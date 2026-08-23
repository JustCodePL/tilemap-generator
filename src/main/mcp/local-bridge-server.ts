import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net, { type Server, type Socket } from 'node:net';
import path from 'node:path';

export const LOCAL_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const LOCAL_BRIDGE_ENDPOINT_FILE = 'endpoint.json';
export const LOCAL_BRIDGE_TOKEN_FILE = 'token';
export const LOCAL_BRIDGE_AUTH_METHOD = 'bridge.authenticate';

const LOCAL_BRIDGE_LOCK_FILE = 'bridge.lock';
const DEFAULT_MAX_LINE_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_REQUESTS = 16;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const MAX_AUTH_LINE_BYTES = 4 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export interface LocalBridgeEndpoint {
  protocolVersion: typeof LOCAL_BRIDGE_PROTOCOL_VERSION;
  instanceId: string;
  pid: number;
  socketPath: string;
  tokenPath: string;
}

export type LocalBridgeRequestId = string | number;

export interface LocalBridgeRequest {
  id: LocalBridgeRequestId;
  method: string;
  params?: unknown;
}

export interface LocalBridgeErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export type LocalBridgeResponse = {
  id: LocalBridgeRequestId | null;
  result: unknown;
} | {
  id: LocalBridgeRequestId | null;
  error: LocalBridgeErrorBody;
};

export interface LocalBridgeSessionContext {
  sessionId: string;
  signal: AbortSignal;
}

export interface LocalBridgeRequestContext {
  id: LocalBridgeRequestId;
  sessionId: string;
  signal: AbortSignal;
}

export interface LocalBridgeSession {
  handleRequest(method: string, params: unknown, context: LocalBridgeRequestContext): Promise<unknown>;
  close?(): void | Promise<void>;
}

export type LocalBridgeSessionFactory = (
  context: LocalBridgeSessionContext,
) => Promise<LocalBridgeSession>;

export interface LocalBridgeServerOptions {
  authTimeoutMs?: number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxLineBytes?: number;
  maxBufferedBytes?: number;
  maxResponseBytes?: number;
  maxQueuedRequests?: number;
}

export class LocalBridgeRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'LocalBridgeRequestError';
  }
}

interface ResolvedOptions {
  authTimeoutMs: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  maxLineBytes: number;
  maxBufferedBytes: number;
  maxResponseBytes: number;
  maxQueuedRequests: number;
}

interface ConnectionState {
  socket: Socket;
  sessionId: string;
  sessionController: AbortController;
  session: LocalBridgeSession | null;
  buffer: Buffer;
  queuedLines: Buffer[];
  queuedBytes: number;
  processing: boolean;
  paused: boolean;
  authenticated: boolean;
  closing: boolean;
  sessionClosed: boolean;
  authTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout | null;
  closedPromise: Promise<void>;
  resolveClosed: () => void;
}

export class LocalBridgeServer {
  readonly runtimeDirectory: string;

  private readonly options: ResolvedOptions;
  private server: Server | null = null;
  private endpointValue: LocalBridgeEndpoint | null = null;
  private token = '';
  private starting: Promise<LocalBridgeEndpoint> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly connections = new Set<ConnectionState>();

  constructor(
    runtimeDirectory: string,
    private readonly sessionFactory: LocalBridgeSessionFactory,
    options: LocalBridgeServerOptions = {},
  ) {
    this.runtimeDirectory = path.resolve(runtimeDirectory);
    this.options = resolveOptions(options);
  }

  get endpoint(): LocalBridgeEndpoint | null {
    return this.endpointValue ? { ...this.endpointValue } : null;
  }

  async start(): Promise<LocalBridgeEndpoint> {
    if (process.platform === 'win32') {
      throw new Error('LocalBridgeServer wymaga Unix domain sockets i nie obsługuje Windows.');
    }
    if (this.endpointValue) return { ...this.endpointValue };
    if (this.starting) return this.starting;
    if (this.stopping) await this.stopping;
    this.starting = this.startOnce();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopOnce();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
  }

  private async startOnce(): Promise<LocalBridgeEndpoint> {
    ensurePrivateDirectory(this.runtimeDirectory);
    const instanceId = randomUUID();
    const lockPath = path.join(this.runtimeDirectory, LOCAL_BRIDGE_LOCK_FILE);
    acquireRuntimeLock(lockPath, instanceId);
    const tokenPath = path.join(this.runtimeDirectory, LOCAL_BRIDGE_TOKEN_FILE);
    const endpointPath = path.join(this.runtimeDirectory, LOCAL_BRIDGE_ENDPOINT_FILE);
    const socketPath = path.join(this.runtimeDirectory, `b-${randomBytes(8).toString('hex')}.sock`);
    if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
      releaseRuntimeLock(lockPath, instanceId);
      throw new Error('Ścieżka runtime MCP jest zbyt długa dla bezpiecznego Unix socket.');
    }

    const server = net.createServer({ pauseOnConnect: false }, (socket) => this.accept(socket));
    this.server = server;
    this.token = randomBytes(32).toString('hex');
    try {
      atomicPrivateWrite(tokenPath, this.token);
      await listen(server, socketPath);
      server.on('error', () => { void this.stop(); });
      chmodSync(socketPath, 0o600);
      const endpoint: LocalBridgeEndpoint = {
        protocolVersion: LOCAL_BRIDGE_PROTOCOL_VERSION,
        instanceId,
        pid: process.pid,
        socketPath,
        tokenPath,
      };
      atomicPrivateWrite(endpointPath, JSON.stringify(endpoint));
      this.endpointValue = endpoint;
      return { ...endpoint };
    } catch (error) {
      await closeServer(server);
      this.server = null;
      this.token = '';
      removePathIfPresent(socketPath);
      removePathIfPresent(tokenPath);
      removeOwnedEndpoint(endpointPath, instanceId);
      releaseRuntimeLock(lockPath, instanceId);
      throw error;
    }
  }

  private async stopOnce(): Promise<void> {
    if (this.starting) {
      try {
        await this.starting;
      } catch {
        return;
      }
    }
    const endpoint = this.endpointValue;
    const server = this.server;
    this.endpointValue = null;
    this.server = null;
    this.token = '';

    const serverClosed = server ? closeServer(server) : Promise.resolve();
    for (const connection of this.connections) closeConnection(connection);
    await Promise.allSettled([...this.connections].map((connection) => connection.closedPromise));
    await serverClosed;

    if (!endpoint) return;
    removePathIfPresent(endpoint.socketPath);
    const endpointPath = path.join(this.runtimeDirectory, LOCAL_BRIDGE_ENDPOINT_FILE);
    if (removeOwnedEndpoint(endpointPath, endpoint.instanceId)) {
      removePathIfPresent(endpoint.tokenPath);
    }
    releaseRuntimeLock(path.join(this.runtimeDirectory, LOCAL_BRIDGE_LOCK_FILE), endpoint.instanceId);
  }

  private accept(socket: Socket): void {
    if (!this.endpointValue || !this.token || !this.server) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    let resolveClosed: () => void = () => undefined;
    const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const sessionId = randomUUID();
    const state = {
      socket,
      sessionId,
      sessionController: new AbortController(),
      session: null,
      buffer: Buffer.alloc(0),
      queuedLines: [],
      queuedBytes: 0,
      processing: false,
      paused: false,
      authenticated: false,
      closing: false,
      sessionClosed: false,
      authTimer: setTimeout(() => {
        void this.failConnection(state, null, new LocalBridgeRequestError(-32001, 'Przekroczono czas uwierzytelnienia bridge.'));
      }, this.options.authTimeoutMs),
      idleTimer: null,
      closedPromise,
      resolveClosed,
    } satisfies ConnectionState;
    this.connections.add(state);

    socket.on('data', (chunk: Buffer) => this.receive(state, chunk));
    socket.on('error', () => closeConnection(state));
    socket.on('close', () => { void this.finalizeConnection(state); });
  }

  private receive(state: ConnectionState, chunk: Buffer): void {
    if (state.closing) return;
    this.refreshIdleTimer(state);
    if (state.buffer.length + state.queuedBytes + chunk.length > this.options.maxBufferedBytes) {
      void this.failConnection(state, null, new LocalBridgeRequestError(-32003, 'Przekroczono limit bufora bridge.'));
      return;
    }
    state.buffer = state.buffer.length ? Buffer.concat([state.buffer, chunk]) : Buffer.from(chunk);
    while (!state.closing) {
      const newline = state.buffer.indexOf(0x0a);
      if (newline < 0) break;
      let line = state.buffer.subarray(0, newline);
      state.buffer = state.buffer.subarray(newline + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      const lineLimit = state.authenticated ? this.options.maxLineBytes : MAX_AUTH_LINE_BYTES;
      if (line.length > lineLimit) {
        void this.failConnection(state, null, new LocalBridgeRequestError(-32003, 'Przekroczono limit pojedynczej wiadomości bridge.'));
        return;
      }
      if (!line.length) {
        void this.failConnection(state, null, new LocalBridgeRequestError(-32600, 'Pusta wiadomość bridge.'));
        return;
      }
      if (state.queuedLines.length >= this.options.maxQueuedRequests) {
        void this.failConnection(state, null, new LocalBridgeRequestError(-32004, 'Zbyt wiele oczekujących żądań bridge.'));
        return;
      }
      const ownedLine = Buffer.from(line);
      state.queuedLines.push(ownedLine);
      state.queuedBytes += ownedLine.length;
    }
    const partialLimit = state.authenticated ? this.options.maxLineBytes : MAX_AUTH_LINE_BYTES;
    if (state.buffer.length > partialLimit) {
      void this.failConnection(state, null, new LocalBridgeRequestError(-32003, 'Przekroczono limit pojedynczej wiadomości bridge.'));
      return;
    }
    if (state.queuedLines.length >= Math.max(1, Math.floor(this.options.maxQueuedRequests / 2)) && !state.paused) {
      state.socket.pause();
      state.paused = true;
    }
    void this.pump(state);
  }

  private async pump(state: ConnectionState): Promise<void> {
    if (state.processing || state.closing) return;
    state.processing = true;
    try {
      while (!state.closing && state.queuedLines.length) {
        const line = state.queuedLines.shift()!;
        state.queuedBytes -= line.length;
        await this.processLine(state, line);
        if (state.paused && state.queuedLines.length < Math.max(1, Math.floor(this.options.maxQueuedRequests / 4))) {
          state.socket.resume();
          state.paused = false;
        }
      }
    } catch {
      closeConnection(state);
    } finally {
      state.processing = false;
    }
  }

  private async processLine(state: ConnectionState, line: Buffer): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line.toString('utf8')) as unknown;
    } catch {
      await this.failConnection(state, null, new LocalBridgeRequestError(-32700, 'Niepoprawny JSON bridge.'));
      return;
    }
    const request = parseRequest(raw);
    if (request instanceof LocalBridgeRequestError) {
      await this.failConnection(state, requestIdFromUnknown(raw), request);
      return;
    }
    if (!state.authenticated) {
      await this.authenticate(state, request);
      return;
    }
    if (request.method === LOCAL_BRIDGE_AUTH_METHOD) {
      await this.send(state, errorResponse(request.id, new LocalBridgeRequestError(-32600, 'Połączenie bridge jest już uwierzytelnione.')));
      return;
    }
    await this.dispatch(state, request);
  }

  private async authenticate(state: ConnectionState, request: LocalBridgeRequest): Promise<void> {
    if (request.method !== LOCAL_BRIDGE_AUTH_METHOD || !isRecord(request.params)) {
      await this.failConnection(state, request.id, new LocalBridgeRequestError(-32001, 'Pierwsza wiadomość musi uwierzytelnić bridge.'));
      return;
    }
    const suppliedToken = request.params.token;
    if (typeof suppliedToken !== 'string' || !validToken(suppliedToken, this.token)) {
      await this.failConnection(state, request.id, new LocalBridgeRequestError(-32001, 'Uwierzytelnienie bridge nie powiodło się.'));
      return;
    }

    clearTimeout(state.authTimer);
    try {
      let detachedSessionClosed = false;
      const sessionPromise = this.sessionFactory({
        sessionId: state.sessionId,
        signal: state.sessionController.signal,
      });
      void sessionPromise.then(async (session) => {
        if ((state.closing || state.sessionController.signal.aborted) && !detachedSessionClosed) {
          detachedSessionClosed = true;
          await safelyCloseSession(session, this.options.requestTimeoutMs);
        }
      }, () => undefined);
      const session = await withTimeout(
        sessionPromise,
        this.options.requestTimeoutMs,
        () => state.sessionController.abort(),
      );
      if (state.closing || state.sessionController.signal.aborted) {
        if (!detachedSessionClosed) {
          detachedSessionClosed = true;
          await safelyCloseSession(session, this.options.requestTimeoutMs);
        }
        return;
      }
      state.session = session;
      state.authenticated = true;
      this.refreshIdleTimer(state);
      await this.send(state, {
        id: request.id,
        result: { sessionId: state.sessionId, protocolVersion: LOCAL_BRIDGE_PROTOCOL_VERSION },
      });
    } catch {
      await this.failConnection(state, request.id, new LocalBridgeRequestError(-32603, 'Nie udało się utworzyć sesji bridge.'));
    }
  }

  private async dispatch(state: ConnectionState, request: LocalBridgeRequest): Promise<void> {
    if (!state.session) {
      await this.failConnection(state, request.id, new LocalBridgeRequestError(-32603, 'Sesja bridge nie jest dostępna.'));
      return;
    }
    const requestController = new AbortController();
    const abort = () => requestController.abort();
    state.sessionController.signal.addEventListener('abort', abort, { once: true });
    let response: LocalBridgeResponse;
    try {
      const result = await withTimeout(
        state.session.handleRequest(request.method, request.params, {
          id: request.id,
          sessionId: state.sessionId,
          signal: requestController.signal,
        }),
        this.options.requestTimeoutMs,
        abort,
      );
      response = { id: request.id, result: result ?? null };
    } catch (error) {
      const responseError = error instanceof LocalBridgeRequestError
        ? error
        : requestController.signal.aborted
          ? new LocalBridgeRequestError(-32002, 'Przekroczono czas obsługi żądania bridge.')
          : new LocalBridgeRequestError(-32603, 'Wewnętrzny błąd obsługi bridge.');
      response = errorResponse(request.id, responseError);
    } finally {
      state.sessionController.signal.removeEventListener('abort', abort);
    }
    await this.send(state, response);
  }

  private async failConnection(
    state: ConnectionState,
    id: LocalBridgeRequestId | null,
    error: LocalBridgeRequestError,
  ): Promise<void> {
    if (state.closing) return;
    state.closing = true;
    clearTimeout(state.authTimer);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    try {
      await this.send(state, errorResponse(id, error));
      state.socket.end();
      const destroyTimer = setTimeout(() => state.socket.destroy(), 500);
      destroyTimer.unref?.();
    } catch {
      state.socket.destroy();
    }
  }

  private async send(state: ConnectionState, response: LocalBridgeResponse): Promise<void> {
    let serialized: string;
    try {
      serialized = `${JSON.stringify(response)}\n`;
    } catch {
      serialized = `${JSON.stringify(errorResponse(response.id, new LocalBridgeRequestError(-32603, 'Nie można zakodować odpowiedzi bridge.')))}\n`;
    }
    if (Buffer.byteLength(serialized) > this.options.maxResponseBytes) {
      serialized = `${JSON.stringify(errorResponse(response.id, new LocalBridgeRequestError(-32003, 'Odpowiedź bridge przekracza dozwolony rozmiar.')))}\n`;
    }
    await writeWithBackpressure(state.socket, serialized);
  }

  private refreshIdleTimer(state: ConnectionState): void {
    if (!this.options.idleTimeoutMs || state.closing) return;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      void this.failConnection(state, null, new LocalBridgeRequestError(-32002, 'Sesja bridge wygasła z powodu bezczynności.'));
    }, this.options.idleTimeoutMs);
  }

  private async finalizeConnection(state: ConnectionState): Promise<void> {
    if (state.sessionClosed) return;
    state.sessionClosed = true;
    state.closing = true;
    clearTimeout(state.authTimer);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.sessionController.abort();
    state.buffer = Buffer.alloc(0);
    state.queuedLines = [];
    state.queuedBytes = 0;
    this.connections.delete(state);
    try {
      if (state.session) await safelyCloseSession(state.session, this.options.requestTimeoutMs);
    } catch {
      // A broken session must not prevent bridge shutdown.
    } finally {
      state.resolveClosed();
    }
  }
}

function resolveOptions(options: LocalBridgeServerOptions): ResolvedOptions {
  const resolved = {
    authTimeoutMs: positiveInteger(options.authTimeoutMs, DEFAULT_AUTH_TIMEOUT_MS),
    requestTimeoutMs: positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    idleTimeoutMs: nonNegativeInteger(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
    maxLineBytes: positiveInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES),
    maxBufferedBytes: positiveInteger(options.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES),
    maxResponseBytes: positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES),
    maxQueuedRequests: positiveInteger(options.maxQueuedRequests, DEFAULT_MAX_QUEUED_REQUESTS),
  };
  if (resolved.maxBufferedBytes < resolved.maxLineBytes) {
    throw new Error('maxBufferedBytes nie może być mniejsze niż maxLineBytes.');
  }
  return resolved;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new Error('Opcja bridge musi być dodatnią liczbą całkowitą.');
  return selected;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0) throw new Error('Opcja bridge nie może być ujemna.');
  return selected;
}

function parseRequest(raw: unknown): LocalBridgeRequest | LocalBridgeRequestError {
  if (!isRecord(raw)) return new LocalBridgeRequestError(-32600, 'Żądanie bridge musi być obiektem.');
  const keys = Object.keys(raw);
  if (keys.some((key) => !['id', 'method', 'params'].includes(key))) {
    return new LocalBridgeRequestError(-32600, 'Żądanie bridge zawiera nieobsługiwane pola.');
  }
  if ((typeof raw.id !== 'string' && typeof raw.id !== 'number')
    || (typeof raw.id === 'string' && (!raw.id.length || raw.id.length > 200))
    || (typeof raw.id === 'number' && !Number.isSafeInteger(raw.id))) {
    return new LocalBridgeRequestError(-32600, 'Żądanie bridge ma niepoprawne id.');
  }
  if (typeof raw.method !== 'string' || !raw.method.length || raw.method.length > 200) {
    return new LocalBridgeRequestError(-32600, 'Żądanie bridge ma niepoprawną metodę.');
  }
  return { id: raw.id, method: raw.method, ...(keys.includes('params') ? { params: raw.params } : {}) };
}

function requestIdFromUnknown(raw: unknown): LocalBridgeRequestId | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id === 'string' && raw.id.length <= 200) return raw.id;
  if (typeof raw.id === 'number' && Number.isSafeInteger(raw.id)) return raw.id;
  return null;
}

function validToken(supplied: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(supplied) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
}

function errorResponse(id: LocalBridgeRequestId | null, error: LocalBridgeRequestError): LocalBridgeResponse {
  return {
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Katalog runtime bridge nie jest bezpiecznym katalogiem.');
  assertCurrentOwner(stats.uid, 'Katalog runtime bridge należy do innego użytkownika.');
  chmodSync(directory, 0o700);
}

function atomicPrivateWrite(targetPath: string, content: string): void {
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, targetPath);
    chmodSync(targetPath, 0o600);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    removePathIfPresent(temporaryPath);
    throw error;
  }
}

function acquireRuntimeLock(lockPath: string, instanceId: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | null = null;
    let created = false;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      created = true;
      writeFileSync(descriptor, JSON.stringify({ instanceId, pid: process.pid }), 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      chmodSync(lockPath, 0o600);
      return;
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if (created) removePathIfPresent(lockPath);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || attempt > 0) throw error;
      const lock = readOwnedLock(lockPath);
      if (!lock || processIsAlive(lock.pid)) {
        throw new Error('Inna instancja lokalnego bridge już używa tego katalogu runtime.');
      }
      unlinkSync(lockPath);
    }
  }
}

function readOwnedLock(lockPath: string): { instanceId: string; pid: number } | null {
  const stats = lstatSync(lockPath);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('Plik blokady bridge ma niebezpieczny typ.');
  assertCurrentOwner(stats.uid, 'Plik blokady bridge należy do innego użytkownika.');
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    if (typeof value.instanceId !== 'string' || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid)) return null;
    return { instanceId: value.instanceId, pid: value.pid };
  } catch {
    return null;
  }
}

function releaseRuntimeLock(lockPath: string, instanceId: string): void {
  if (!existsSync(lockPath)) return;
  try {
    const lock = readOwnedLock(lockPath);
    if (lock?.instanceId === instanceId && lock.pid === process.pid) unlinkSync(lockPath);
  } catch {
    // Never remove a lock that cannot be proven to belong to this instance.
  }
}

function removeOwnedEndpoint(endpointPath: string, instanceId: string): boolean {
  if (!existsSync(endpointPath)) return false;
  try {
    const stats = lstatSync(endpointPath);
    if (stats.isSymbolicLink() || !stats.isFile()) return false;
    assertCurrentOwner(stats.uid, 'Descriptor bridge należy do innego użytkownika.');
    const value = JSON.parse(readFileSync(endpointPath, 'utf8')) as Record<string, unknown>;
    if (value.instanceId !== instanceId) return false;
    unlinkSync(endpointPath);
    return true;
  } catch {
    return false;
  }
}

function assertCurrentOwner(uid: number, message: string): void {
  if (typeof process.getuid === 'function' && uid !== process.getuid()) throw new Error(message);
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removePathIfPresent(targetPath: string): void {
  try {
    unlinkSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function closeConnection(state: ConnectionState): void {
  if (state.closing && state.socket.destroyed) return;
  state.closing = true;
  clearTimeout(state.authTimer);
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.sessionController.abort();
  state.socket.destroy();
}

function writeWithBackpressure(socket: Socket, value: string): Promise<void> {
  if (socket.destroyed || !socket.writable) return Promise.reject(new Error('Socket bridge jest zamknięty.'));
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Socket bridge został zamknięty.'));
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('drain', onDrain);
    };
    socket.once('error', onError);
    socket.once('close', onClose);
    const writable = socket.write(value);
    if (writable) {
      cleanup();
      resolve();
    } else {
      socket.once('drain', onDrain);
    }
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new LocalBridgeRequestError(-32002, 'Przekroczono czas operacji bridge.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safelyCloseSession(session: LocalBridgeSession, timeoutMs: number): Promise<void> {
  if (!session.close) return;
  try {
    await withTimeout(Promise.resolve(session.close()), timeoutMs, () => undefined);
  } catch {
    // Session cleanup is best-effort and bounded so bridge shutdown cannot hang.
  }
}
