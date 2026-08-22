import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { assetCategories, pivotSchema, type CodexHealth } from '../../shared/domain';
import type { ProjectDatabase } from '../db/project-database';
import { nullLogger, type Logger } from '../services/app-logger';
import { CodexAppServerClient, type CodexNotification } from './app-server-client';
import { handleRegistryTool, registryDynamicTools } from './registry-tools';

const execFileAsync = promisify(execFile);
const MINIMUM_CODEX_VERSION = [0, 142, 5] as const;

interface TurnResult {
  turnId: string;
  items: Array<Record<string, unknown>>;
  finalMessage: string;
}

interface TurnWaiter {
  threadId: string;
  turnId: string;
  items: Array<Record<string, unknown>>;
  finalMessage: string;
  failureMessage: string;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onEvent?: (notification: CodexNotification) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export class CodexService {
  private client: CodexAppServerClient | null = null;
  private database: ProjectDatabase | null = null;
  private healthValue: CodexHealth;
  private imagegenSkillPath: string | null = null;
  private turnWaiters = new Map<string, TurnWaiter>();
  private activeTurns = new Map<string, { threadId: string; turnId: string }>();
  private threadSerials = new Map<string, Promise<void>>();
  private connectionThreadIds = new Set<string>();
  private serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly logger: Logger = nullLogger) {
    this.healthValue = checkingHealth(logger.filePath);
  }

  async connect(database: ProjectDatabase): Promise<CodexHealth> {
    await this.disconnect();
    this.database = database;
    this.healthValue = checkingHealth(this.logger.filePath);
    try {
      const detected = await detectCodex();
      const version = detected.version;
      if (!versionAtLeast(version, MINIMUM_CODEX_VERSION)) {
        this.healthValue = {
          state: 'incompatible', version, appServer: false, imageGeneration: false,
          imagegenSkill: false, skillPath: null, logPath: this.logger.filePath,
          message: `Wymagany Codex >= ${MINIMUM_CODEX_VERSION.join('.')}; wykryto ${version}.`,
        };
        return this.healthValue;
      }
      this.client = new CodexAppServerClient(
        database.rootPath,
        (method, params) => this.handleServerRequest(method, params),
        { command: detected.command, args: [...detected.prefixArgs, 'app-server', '--listen', 'stdio://'], shell: false },
      );
      this.client.on('notification', (notification: CodexNotification) => this.handleNotification(notification));
      this.client.on('stderr', (message) => {
        const value = String(message).trim();
        if (value) this.logger.warn('codex.app-server.stderr', { message: value.slice(0, 8_000) });
      });
      this.client.on('protocol-error', (error) => {
        this.logger.error('codex.app-server.protocol-error', errorDetails(error));
        this.failActive(error as Error);
      });
      this.client.on('crash', (error) => {
        this.logger.error('codex.app-server.crash', errorDetails(error));
        this.failActive(error as Error);
      });
      await this.client.start();

      const account = await this.client.request('account/read', { refreshToken: false }, 20_000) as Record<string, unknown>;
      if (account.requiresOpenaiAuth && !account.account) {
        this.healthValue = {
          state: 'not_logged_in', version, appServer: true, imageGeneration: false,
          imagegenSkill: false, skillPath: null, logPath: this.logger.filePath,
          message: 'Codex nie jest zalogowany. Uruchom codex login.',
        };
        return this.healthValue;
      }

      const capabilities = await this.client.request('modelProvider/capabilities/read', {}, 20_000) as Record<string, unknown>;
      const skills = await this.client.request('skills/list', { cwds: [database.rootPath], forceReload: true }, 30_000) as {
        data?: Array<{ skills?: Array<{ name: string; path: string; enabled: boolean }> }>;
      };
      const imagegen = skills.data?.flatMap((entry) => entry.skills ?? [])
        .find((skill) => skill.name === 'imagegen' && skill.enabled);
      this.imagegenSkillPath = imagegen?.path ?? null;
      const imageGeneration = capabilities.imageGeneration === true;
      const ready = imageGeneration && Boolean(this.imagegenSkillPath);
      this.healthValue = {
        state: ready ? 'ready' : 'unavailable', version, appServer: true, imageGeneration,
        imagegenSkill: Boolean(this.imagegenSkillPath), skillPath: this.imagegenSkillPath,
        logPath: this.logger.filePath,
        message: ready ? 'Codex App Server i imagegen są gotowe.' : 'Brak capability image generation lub aktywnego skillu imagegen.',
      };
      this.logger.info('codex.health', {
        state: this.healthValue.state,
        version,
        imageGeneration,
        imagegenSkill: Boolean(this.imagegenSkillPath),
      });
    } catch (error) {
      this.healthValue = {
        state: 'unavailable', version: null, appServer: false, imageGeneration: false,
        imagegenSkill: false, skillPath: null, logPath: this.logger.filePath,
        message: error instanceof Error ? error.message : String(error),
      };
      this.logger.error('codex.connect.failed', errorDetails(error));
    }
    return this.healthValue;
  }

  async disconnect(): Promise<void> {
    await this.client?.stop();
    this.failActive(new Error('Połączenie z Codex App Serverem zostało zamknięte.'));
    this.client = null;
    this.database = null;
    this.imagegenSkillPath = null;
    this.activeTurns.clear();
    this.threadSerials.clear();
    this.connectionThreadIds.clear();
  }

  health(): CodexHealth {
    return this.healthValue;
  }

  requireReady(): { client: CodexAppServerClient; database: ProjectDatabase; skillPath: string } {
    if (this.healthValue.state !== 'ready' || !this.client || !this.database || !this.imagegenSkillPath) {
      throw new Error(this.healthValue.message || 'Codex nie jest gotowy.');
    }
    return { client: this.client, database: this.database, skillPath: this.imagegenSkillPath };
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation, operation);
    this.serial = next.then(() => undefined, () => undefined);
    return next;
  }

  async ensureAssetThread(assetId: string, existingThreadId: string | null): Promise<string> {
    const { client, database } = this.requireReady();
    if (existingThreadId && this.connectionThreadIds.has(existingThreadId)) {
      return existingThreadId;
    }
    const params = {
      cwd: database.rootPath,
      runtimeWorkspaceRoots: [database.rootPath],
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      serviceName: 'tilemap-generator',
      developerInstructions: agentInstructions(),
      dynamicTools: registryDynamicTools,
    };
    // Dynamic tools are supplied only by thread/start in the current App Server protocol.
    // A resumed thread keeps the tool contract it had when it was created, so reusing a
    // persisted thread after an application update can hide newly added registry tools.
    // Start one fresh thread per asset and App Server connection, then reuse it in-memory.
    const response = await client.request('thread/start', params, 45_000) as { thread?: { id?: string } };
    const threadId = response.thread?.id;
    if (!threadId) throw new Error('App Server nie zwrócił identyfikatora wątku.');
    this.connectionThreadIds.add(threadId);
    database.setAssetThread(assetId, threadId);
    if (existingThreadId) {
      this.logger.info('codex.thread.replaced', { assetId, previousThreadId: existingThreadId, threadId });
    }
    return threadId;
  }

  async startUtilityThread(): Promise<string> {
    const { client, database } = this.requireReady();
    const response = await client.request('thread/start', {
      cwd: database.rootPath,
      runtimeWorkspaceRoots: [database.rootPath],
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      serviceName: 'tilemap-generator-style',
      developerInstructions: agentInstructions(),
      dynamicTools: registryDynamicTools,
      ephemeral: true,
    }, 45_000) as { thread?: { id?: string } };
    if (!response.thread?.id) throw new Error('Nie udało się utworzyć wątku pomocniczego.');
    return response.thread.id;
  }

  async runTurn(
    threadId: string,
    input: Array<Record<string, unknown>>,
    outputSchema: Record<string, unknown>,
    onEvent?: (notification: CodexNotification) => void,
    timeoutMs = 15 * 60_000,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    const previous = this.threadSerials.get(threadId) ?? Promise.resolve();
    const start = () => {
      if (signal?.aborted) throw cancellationError();
      return this.runTurnNow(threadId, input, outputSchema, onEvent, timeoutMs, signal);
    };
    const next = previous.then(start, start);
    const settled = next.then(() => undefined, () => undefined);
    this.threadSerials.set(threadId, settled);
    void settled.then(() => {
      if (this.threadSerials.get(threadId) === settled) this.threadSerials.delete(threadId);
    });
    return next;
  }

  private async runTurnNow(
    threadId: string,
    input: Array<Record<string, unknown>>,
    outputSchema: Record<string, unknown>,
    onEvent: ((notification: CodexNotification) => void) | undefined,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<TurnResult> {
    const { client } = this.requireReady();
    const response = await client.request('turn/start', {
      threadId,
      input,
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'workspaceWrite', writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
      outputSchema,
    }, 60_000) as { turn?: { id?: string } };
    const turnId = response.turn?.id;
    if (!turnId) throw new Error('App Server nie zwrócił identyfikatora turnu.');
    const activeTurn = { threadId, turnId };
    this.activeTurns.set(turnId, activeTurn);
    return new Promise<TurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.turnWaiters.get(turnId);
        this.turnWaiters.delete(turnId);
        this.activeTurns.delete(turnId);
        if (waiter?.signal && waiter.abortListener) {
          waiter.signal.removeEventListener('abort', waiter.abortListener);
        }
        void client.request('turn/interrupt', activeTurn, 20_000).catch((error) => {
          this.logger.warn('codex.turn.timeout-interrupt-failed', {
            threadId,
            turnId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        reject(new Error(`Generacja przekroczyła limit ${Math.round(timeoutMs / 60_000)} minut.`));
      }, timeoutMs);
      const waiter: TurnWaiter = {
        threadId, turnId, items: [], finalMessage: '', failureMessage: '', resolve, reject, timer, onEvent,
        signal,
      };
      if (signal) {
        waiter.abortListener = () => {
          void client.request('turn/interrupt', activeTurn, 20_000)
            .catch((error) => {
              this.logger.warn('codex.turn.cancel-interrupt-failed', {
                threadId,
                turnId,
                message: error instanceof Error ? error.message : String(error),
              });
            })
            .finally(() => {
              if (this.turnWaiters.get(turnId) !== waiter) return;
              clearTimeout(waiter.timer);
              this.turnWaiters.delete(turnId);
              this.activeTurns.delete(turnId);
              signal.removeEventListener('abort', waiter.abortListener!);
              waiter.reject(cancellationError());
            });
        };
      }
      this.turnWaiters.set(turnId, waiter);
      if (signal?.aborted) waiter.abortListener?.();
      else if (signal && waiter.abortListener) signal.addEventListener('abort', waiter.abortListener, { once: true });
    });
  }

  async interruptActiveTurn(): Promise<void> {
    if (!this.client || !this.activeTurns.size) return;
    await Promise.all([...this.activeTurns.values()].map((turn) => (
      this.client!.request('turn/interrupt', turn, 20_000)
    )));
  }

  skillPath(): string {
    return this.requireReady().skillPath;
  }

  private async handleServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'item/tool/call') {
      if (!this.database) throw new Error('Brak otwartego projektu.');
      return handleRegistryTool(this.database, params);
    }
    if (method === 'currentTime/read') return { time: new Date().toISOString() };
    if (method.includes('requestApproval')) return { decision: 'decline' };
    if (method === 'item/tool/requestUserInput') {
      throw new Error('Agent wymaga decyzji użytkownika. Zakończono turn bez automatycznego fallbacku.');
    }
    throw new Error(`Nieobsługiwane żądanie App Servera: ${method}`);
  }

  private handleNotification(notification: CodexNotification): void {
    let turnId = String(notification.params.turnId ?? (notification.params.turn as Record<string, unknown> | undefined)?.id ?? '');
    if (!turnId && ['error', 'warning'].includes(notification.method)) {
      turnId = this.activeTurns.size === 1 ? this.activeTurns.keys().next().value ?? '' : '';
    }
    const waiter = this.turnWaiters.get(turnId);
    waiter?.onEvent?.(notification);

    if (notification.method === 'error') {
      const message = extractCodexErrorMessage(notification.params) || 'Codex App Server zgłosił nieznany błąd.';
      if (waiter) waiter.failureMessage = message;
      this.logger.error('codex.turn.error', { threadId: waiter?.threadId, turnId, message });
    } else if (notification.method === 'warning') {
      const message = extractCodexErrorMessage(notification.params) || 'Codex App Server zgłosił ostrzeżenie.';
      this.logger.warn('codex.turn.warning', { threadId: waiter?.threadId, turnId, message });
    }

    if (!waiter) return;

    if (notification.method === 'item/completed') {
      const item = notification.params.item as Record<string, unknown> | undefined;
      if (item) {
        waiter.items.push(item);
        if (item.type === 'agentMessage') waiter.finalMessage = String(item.text ?? '');
      }
    }
    if (notification.method === 'turn/completed') {
      clearTimeout(waiter.timer);
      this.turnWaiters.delete(turnId);
      this.activeTurns.delete(turnId);
      if (waiter.signal && waiter.abortListener) {
        waiter.signal.removeEventListener('abort', waiter.abortListener);
      }
      const turn = notification.params.turn as Record<string, unknown> | undefined;
      const status = String(turn?.status ?? notification.params.status ?? 'completed');
      if (!['completed', 'complete'].includes(status.toLocaleLowerCase())) {
        const message = extractCodexErrorMessage(
          turn?.error,
          notification.params.error,
          waiter.failureMessage,
        ) || `Turn zakończył się statusem ${status}.`;
        this.logger.error('codex.turn.completed-with-error', {
          threadId: waiter.threadId,
          turnId,
          status,
          message,
        });
        waiter.reject(new Error(message));
      } else {
        this.logger.info('codex.turn.completed', { threadId: waiter.threadId, turnId, status });
        waiter.resolve({ turnId, items: waiter.items, finalMessage: waiter.finalMessage });
      }
    }
  }

  private failActive(error: Error): void {
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abortListener) {
        waiter.signal.removeEventListener('abort', waiter.abortListener);
      }
      waiter.reject(error);
    }
    this.turnWaiters.clear();
    this.activeTurns.clear();
  }
}

function cancellationError(): Error {
  const error = new Error('Generacja została anulowana.');
  error.name = 'AbortError';
  return error;
}

async function detectCodex(): Promise<{ command: string; prefixArgs: string[]; version: string }> {
  let command = 'codex';
  let prefixArgs: string[] = [];
  if (process.platform === 'win32') {
    try {
      const located = await execFileAsync('where.exe', ['codex.cmd'], { timeout: 10_000, windowsHide: true });
      const shim = located.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (!shim) throw new Error('Nie znaleziono codex.cmd.');
      const script = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      const adjacentNode = path.join(path.dirname(shim), 'node.exe');
      if (!existsSync(script) || !existsSync(adjacentNode)) throw new Error('Shim npm Codexa jest niekompletny.');
      command = adjacentNode;
      prefixArgs = [script];
    } catch {
      const located = await execFileAsync('where.exe', ['codex.exe'], { timeout: 10_000, windowsHide: true });
      command = located.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? command;
    }
  }
  const result = await execFileAsync(command, [...prefixArgs, '--version'], {
    timeout: 15_000,
    windowsHide: true,
    shell: false,
  });
  const match = `${result.stdout} ${result.stderr}`.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error('Nie udało się odczytać wersji Codexa.');
  return { command, prefixArgs, version: `${match[1]}.${match[2]}.${match[3]}` };
}

function versionAtLeast(value: string, minimum: readonly number[]): boolean {
  const parts = value.split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if ((parts[index] ?? 0) > minimum[index]) return true;
    if ((parts[index] ?? 0) < minimum[index]) return false;
  }
  return true;
}

function checkingHealth(logPath: string | null): CodexHealth {
  return {
    state: 'checking', version: null, appServer: false, imageGeneration: false,
    imagegenSkill: false, skillPath: null, logPath, message: 'Sprawdzanie lokalnej instalacji Codexa…',
  };
}

export function extractCodexErrorMessage(...values: unknown[]): string | null {
  for (const value of values) {
    const message = findMessage(value, 0);
    if (message) return message;
  }
  return null;
}

function findMessage(value: unknown, depth: number): string | null {
  if (depth > 5 || value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (value instanceof Error) return value.message.trim() || null;
  if (typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  for (const key of ['message', 'detail', 'reason']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  }
  for (const key of ['error', 'cause', 'data', 'codexErrorInfo', 'turn']) {
    const nested = findMessage(record[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}

function agentInstructions(): string {
  return [
    'You are the image asset worker embedded in Tilemap Generator.',
    'Operate only inside the current project workspace. Do not modify application source code.',
    'Use registry tools read-only when existing approved assets or tags can improve consistency.',
    'Use the explicitly supplied imagegen skill for raster generation and editing.',
    'Never use the CLI/API fallback or ask for an API key. If built-in transparent workflow is unsuitable, report needs_user_decision.',
    'Always preserve prior versions and write only into the exact staging directory named in the request.',
    'Finish with data matching the supplied output JSON schema.',
  ].join('\n');
}

export const generationResponseSchema = z.object({
  status: z.enum(['completed', 'needs_user_decision']),
  finalPath: z.string(),
  category: z.enum(assetCategories),
  tags: z.array(z.string().min(1).max(60)).max(40),
  pivot: pivotSchema,
  description: z.string().max(2_000),
  message: z.string().max(2_000).default(''),
});

export const generationOutputSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['completed', 'needs_user_decision'] },
    finalPath: { type: 'string' },
    category: { type: 'string', enum: assetCategories },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 40 },
    pivot: {
      type: 'object',
      properties: {
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    description: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['status', 'finalPath', 'category', 'tags', 'pivot', 'description', 'message'],
  additionalProperties: false,
};
