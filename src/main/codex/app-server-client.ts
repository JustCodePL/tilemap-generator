import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexNotification {
  method: string;
  params: JsonObject;
}

export type ServerRequestHandler = (method: string, params: JsonObject) => Promise<unknown>;

export interface AppServerLaunch {
  command: string;
  args: string[];
  shell?: boolean;
}

export class CodexAppServerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private requests = new Map<number, PendingRequest>();
  private nextId = 1;
  private stopping = false;

  constructor(
    private readonly cwd: string,
    private readonly serverRequestHandler: ServerRequestHandler,
    private readonly launch: AppServerLaunch = {
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      shell: process.platform === 'win32',
    },
  ) {
    super();
  }

  get running(): boolean {
    return Boolean(this.process && !this.process.killed);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stopping = false;
    this.process = spawn(this.launch.command, this.launch.args, {
      cwd: this.cwd,
      shell: this.launch.shell ?? false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const processStarted = new Promise<void>((resolve, reject) => {
      this.process!.once('spawn', resolve);
      this.process!.once('error', reject);
    });
    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.process.stderr.on('data', (chunk) => this.emit('stderr', String(chunk)));
    this.process.on('exit', (code, signal) => {
      const error = new Error(`Codex App Server zakończył pracę (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`);
      for (const pending of this.requests.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.requests.clear();
      this.process = null;
      if (!this.stopping) this.emit('crash', error);
    });

    await processStarted;
    await this.request('initialize', {
      clientInfo: { name: 'tilemap_generator', title: 'Tilemap Generator', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    }, 20_000);
    this.notify('initialized', {});
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.process) return;
    const child = this.process;
    let hasExited = false;
    const exited = new Promise<void>((resolve) => child.once('exit', () => {
      hasExited = true;
      resolve();
    }));
    child.stdin.end();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
    if (!hasExited) {
      child.kill();
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    this.process = null;
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (!this.process) return Promise.reject(new Error('Codex App Server nie działa.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`Przekroczono czas oczekiwania na ${method}.`));
      }, timeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.process) return;
    this.write({ method, params });
  }

  private write(message: unknown): void {
    this.process?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.emit('protocol-error', new Error(`Niepoprawny JSONL App Servera: ${line.slice(0, 300)}`));
      return;
    }

    if (typeof message.id === 'number' && !message.method) {
      const pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = message.error as JsonObject;
        pending.reject(new Error(String(error.message ?? 'Nieznany błąd App Servera.')));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.id === 'number' && typeof message.method === 'string') {
      void this.handleServerRequest(message.id, message.method, (message.params ?? {}) as JsonObject);
      return;
    }

    if (typeof message.method === 'string') {
      this.emit('notification', { method: message.method, params: (message.params ?? {}) as JsonObject } satisfies CodexNotification);
    }
  }

  private async handleServerRequest(id: number, method: string, params: JsonObject): Promise<void> {
    try {
      const result = await this.serverRequestHandler(method, params);
      this.write({ id, result });
    } catch (error) {
      this.write({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}
