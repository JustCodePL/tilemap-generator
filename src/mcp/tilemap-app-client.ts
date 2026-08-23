import type { Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createConnection, type Socket } from 'node:net';
import * as z from 'zod/v4';

const BRIDGE_PROTOCOL_VERSION = 1;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_TOKEN_BYTES = 256;

const endpointDescriptorSchema = z.object({
  protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  instanceId: z.string().trim().min(1).max(200),
  pid: z.number().int().positive(),
  socketPath: z.string().trim().min(1).max(32_767),
  tokenPath: z.string().trim().min(1).max(32_767),
}).strict();

const responseIdSchema = z.union([z.string(), z.number()]);
const bridgeResponseSchema = z.union([
  z.object({ id: responseIdSchema, result: z.unknown() }).strict(),
  z.object({
    id: responseIdSchema,
    error: z.object({
      code: z.union([z.string(), z.number()]),
      message: z.string(),
      data: z.unknown().optional(),
    }).strict(),
  }).strict(),
]);

const authenticationResultSchema = z.object({
  sessionId: z.string().trim().min(1),
  protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
}).strict();

export interface TilemapAppClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

export type TilemapAppClientErrorCode =
  | 'CONNECTION_FAILED'
  | 'CONNECTION_CLOSED'
  | 'PROTOCOL_ERROR'
  | 'REQUEST_TIMEOUT'
  | 'REMOTE_ERROR';

export class TilemapAppClientError extends Error {
  constructor(
    public readonly code: TilemapAppClientErrorCode,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'TilemapAppClientError';
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function defaultTilemapMcpRuntimeDir(
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  if (platform === 'darwin') {
    return path.join(homeDirectory, 'Library', 'Application Support', 'Tilemap Generator', 'mcp');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    return path.join(appData || path.join(homeDirectory, 'AppData', 'Roaming'), 'Tilemap Generator', 'mcp');
  }
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(homeDirectory, '.config');
  return path.join(configHome, 'Tilemap Generator', 'mcp');
}

export class TilemapAppClient {
  private readonly runtimeDir: string;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private authenticated = false;
  private closing = false;
  private receiveBuffer = '';
  private nextRequestId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();

  constructor(runtimeDir = defaultTilemapMcpRuntimeDir(), options: TilemapAppClientOptions = {}) {
    this.runtimeDir = path.resolve(runtimeDir);
    this.connectTimeoutMs = positiveTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  }

  async connect(): Promise<void> {
    if (this.authenticated && this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.closing = false;
    this.connecting = this.openAndAuthenticate().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async call<T>(method: string, params: unknown = {}): Promise<T> {
    if (!method.trim() || method === 'bridge.authenticate') {
      throw new TilemapAppClientError('PROTOCOL_ERROR', 'Nieprawidłowa metoda lokalnego bridge.');
    }
    await this.connect();
    return this.sendRequest<T>(this.nextRequestId++, method, params, this.requestTimeoutMs);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.authenticated = false;
    const socket = this.socket;
    this.socket = null;
    this.receiveBuffer = '';
    this.rejectPending(new TilemapAppClientError('CONNECTION_CLOSED', 'Klient lokalnego bridge został zamknięty.'));
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.destroy();
    });
  }

  private async openAndAuthenticate(): Promise<void> {
    let socket: Socket | null = null;
    try {
      if (process.platform !== 'darwin') {
        throw new TilemapAppClientError(
          'CONNECTION_FAILED',
          'Lokalny bridge MCP V1 jest obecnie obsługiwany tylko na macOS.',
        );
      }
      await assertSecureRuntimeEntry(this.runtimeDir, 'directory');
      const descriptorPath = path.join(this.runtimeDir, 'endpoint.json');
      await assertSecureRuntimeEntry(descriptorPath, 'file');
      const descriptor = endpointDescriptorSchema.parse(JSON.parse(await readSmallTextFile(
        descriptorPath,
        MAX_DESCRIPTOR_BYTES,
        'descriptor endpointu MCP',
      )));
      const tokenPath = path.resolve(descriptor.tokenPath);
      const expectedTokenPath = path.join(this.runtimeDir, 'token');
      if (tokenPath !== expectedTokenPath) {
        throw new TilemapAppClientError(
          'PROTOCOL_ERROR',
          'Descriptor lokalnego bridge wskazuje nieoczekiwany plik tokenu.',
        );
      }
      if (!path.isAbsolute(descriptor.socketPath)
        || path.dirname(path.resolve(descriptor.socketPath)) !== this.runtimeDir) {
        throw new TilemapAppClientError(
          'PROTOCOL_ERROR',
          'Descriptor lokalnego bridge wskazuje nieoczekiwany socket.',
        );
      }
      await assertSecureRuntimeEntry(tokenPath, 'file');
      await assertSecureRuntimeEntry(descriptor.socketPath, 'socket');
      const token = (await readSmallTextFile(tokenPath, MAX_TOKEN_BYTES, 'token MCP')).trim();
      if (!/^[a-f0-9]{64}$/.test(token)) {
        throw new TilemapAppClientError('PROTOCOL_ERROR', 'Token lokalnego bridge ma nieprawidłowy format.');
      }

      socket = createConnection(descriptor.socketPath);
      this.attachSocket(socket);
      await waitForSocketConnection(socket, this.connectTimeoutMs);
      const authentication = await this.sendRequest<unknown>(
        'auth',
        'bridge.authenticate',
        { token },
        this.connectTimeoutMs,
      );
      authenticationResultSchema.parse(authentication);
      this.authenticated = true;
    } catch (error) {
      if (socket && !socket.destroyed) socket.destroy();
      this.socket = null;
      this.authenticated = false;
      this.receiveBuffer = '';
      if (error instanceof TilemapAppClientError) throw error;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new TilemapAppClientError('PROTOCOL_ERROR', 'Descriptor lub odpowiedź lokalnego bridge jest nieprawidłowa.');
      }
      throw new TilemapAppClientError(
        'CONNECTION_FAILED',
        `Nie udało się połączyć z Tilemap Generator: ${safeErrorMessage(error)}.`,
      );
    }
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    this.receiveBuffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (error) => {
      this.disconnect(new TilemapAppClientError(
        'CONNECTION_CLOSED',
        `Połączenie z Tilemap Generator zostało przerwane: ${safeErrorMessage(error)}.`,
      ));
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.disconnect(new TilemapAppClientError(
        'CONNECTION_CLOSED',
        this.closing
          ? 'Klient lokalnego bridge został zamknięty.'
          : 'Tilemap Generator zamknął połączenie lokalnego bridge.',
      ));
    });
  }

  private receive(chunk: string): void {
    this.receiveBuffer += chunk;
    if (Buffer.byteLength(this.receiveBuffer, 'utf8') > this.maxResponseBytes) {
      this.disconnect(new TilemapAppClientError(
        'PROTOCOL_ERROR',
        'Odpowiedź lokalnego bridge przekroczyła bezpieczny limit rozmiaru.',
      ));
      return;
    }
    for (;;) {
      const newlineIndex = this.receiveBuffer.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = this.receiveBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.receiveBuffer = this.receiveBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        this.acceptResponse(line);
      } catch (error) {
        this.disconnect(error instanceof TilemapAppClientError
          ? error
          : new TilemapAppClientError('PROTOCOL_ERROR', 'Lokalny bridge zwrócił nieprawidłową odpowiedź.'));
        return;
      }
    }
  }

  private acceptResponse(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new TilemapAppClientError('PROTOCOL_ERROR', 'Lokalny bridge zwrócił nieprawidłowy JSON.');
    }
    const response = bridgeResponseSchema.parse(parsed);
    const pending = this.pending.get(response.id);
    if (!pending) {
      throw new TilemapAppClientError('PROTOCOL_ERROR', 'Lokalny bridge zwrócił odpowiedź dla nieznanego żądania.');
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if ('error' in response) {
      pending.reject(new TilemapAppClientError(
        'REMOTE_ERROR',
        response.id === 'auth'
          ? 'Tilemap Generator odrzucił uwierzytelnienie lokalnego bridge.'
          : response.error.message,
        response.id === 'auth'
          ? { code: response.error.code }
          : { code: response.error.code, data: response.error.data },
      ));
      return;
    }
    pending.resolve(response.result);
  }

  private sendRequest<T>(
    id: string | number,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) {
      return Promise.reject(new TilemapAppClientError(
        'CONNECTION_CLOSED',
        'Brak aktywnego połączenia z Tilemap Generator.',
      ));
    }
    let requestLine: string;
    try {
      requestLine = `${JSON.stringify({ id, method, params })}\n`;
    } catch {
      return Promise.reject(new TilemapAppClientError(
        'PROTOCOL_ERROR',
        'Parametry żądania lokalnego bridge nie są poprawnym JSON.',
      ));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const error = new TilemapAppClientError(
          'REQUEST_TIMEOUT',
          `Tilemap Generator nie odpowiedział na metodę ${method} w wyznaczonym czasie.`,
        );
        pending.reject(error);
        this.disconnect(error);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      socket.write(requestLine, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new TilemapAppClientError(
          'CONNECTION_CLOSED',
          `Nie udało się wysłać żądania do Tilemap Generator: ${safeErrorMessage(error)}.`,
        ));
      });
    });
  }

  private disconnect(error: TilemapAppClientError): void {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.receiveBuffer = '';
    this.rejectPending(error);
    if (socket && !socket.destroyed) socket.destroy();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createTilemapAppClient(
  runtimeDir?: string,
  options?: TilemapAppClientOptions,
): TilemapAppClient {
  return new TilemapAppClient(runtimeDir, options);
}

async function readSmallTextFile(filePath: string, limit: number, label: string): Promise<string> {
  const fileStats = await lstat(filePath);
  if (!fileStats.isFile() || fileStats.size > limit) {
    throw new TilemapAppClientError('PROTOCOL_ERROR', `Nieprawidłowy ${label}.`);
  }
  return readFile(filePath, 'utf8');
}

async function assertSecureRuntimeEntry(
  entryPath: string,
  kind: 'directory' | 'file' | 'socket',
): Promise<void> {
  const entryStats = await lstat(entryPath);
  const isExpectedKind = kind === 'directory'
    ? entryStats.isDirectory()
    : kind === 'file'
      ? entryStats.isFile()
      : entryStats.isSocket();
  const expectedMode = kind === 'directory' ? 0o700 : 0o600;
  if (entryStats.isSymbolicLink()
    || !isExpectedKind
    || !ownedByCurrentUser(entryStats)
    || (entryStats.mode & 0o777) !== expectedMode) {
    throw new TilemapAppClientError(
      'PROTOCOL_ERROR',
      `Niebezpieczne uprawnienia lokalnego ${kind === 'directory' ? 'katalogu' : kind === 'socket' ? 'socketu' : 'pliku'} MCP.`,
    );
  }
}

function ownedByCurrentUser(entryStats: Stats): boolean {
  return typeof process.getuid !== 'function' || entryStats.uid === process.getuid();
}

function waitForSocketConnection(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new TilemapAppClientError(
        'CONNECTION_FAILED',
        'Przekroczono czas oczekiwania na lokalny bridge Tilemap Generator.',
      ));
    }, timeoutMs);
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new TilemapAppClientError(
        'CONNECTION_FAILED',
        `Nie udało się otworzyć lokalnego bridge: ${safeErrorMessage(error)}.`,
      ));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return positiveInteger(value, fallback);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isInteger(value) || value <= 0 ? fallback : value;
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) return 'nieznany błąd';
  return error.message.replace(
    /(?:[A-Za-z]:\\|\/(?:Users|home|private|var|tmp|Volumes|Applications|opt|etc)\/)[^\s,;:)]+/g,
    '[ścieżka ukryta]',
  );
}
