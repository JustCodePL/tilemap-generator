import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LOCAL_BRIDGE_AUTH_METHOD,
  LOCAL_BRIDGE_ENDPOINT_FILE,
  LOCAL_BRIDGE_PROTOCOL_VERSION,
  LOCAL_BRIDGE_TOKEN_FILE,
  LocalBridgeRequestError,
  LocalBridgeServer,
  type LocalBridgeEndpoint,
  type LocalBridgeResponse,
  type LocalBridgeSession,
} from '../main/mcp/local-bridge-server';

const temporaryDirectories: string[] = [];
const servers: LocalBridgeServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')('tworzy prywatny endpoint i utrzymuje osobną sesję na połączenie', async () => {
  const runtimeDirectory = temporaryRuntime();
  const closedSessions: string[] = [];
  const sessionFactory = vi.fn(async ({ sessionId }: { sessionId: string }): Promise<LocalBridgeSession> => ({
    handleRequest: async (method, params, context) => ({ method, params, sessionId: context.sessionId }),
    close: async () => { closedSessions.push(sessionId); },
  }));
  const server = trackedServer(new LocalBridgeServer(runtimeDirectory, sessionFactory));
  const endpoint = await server.start();

  expect(server.endpoint).toEqual(endpoint);
  expect(endpoint).toMatchObject({ protocolVersion: LOCAL_BRIDGE_PROTOCOL_VERSION, pid: process.pid });
  expect(endpoint.socketPath).toMatch(new RegExp(`^${escapeRegex(runtimeDirectory)}/b-[a-f0-9]{16}\\.sock$`));
  expect(endpoint.tokenPath).toBe(path.join(runtimeDirectory, LOCAL_BRIDGE_TOKEN_FILE));
  expect(fileMode(runtimeDirectory)).toBe(0o700);
  for (const privatePath of [
    path.join(runtimeDirectory, LOCAL_BRIDGE_ENDPOINT_FILE),
    endpoint.tokenPath,
    endpoint.socketPath,
    path.join(runtimeDirectory, 'bridge.lock'),
  ]) {
    expect(fileMode(privatePath)).toBe(0o600);
  }
  expect(lstatSync(endpoint.socketPath).isSocket()).toBe(true);
  const token = readFileSync(endpoint.tokenPath, 'utf8');
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse(readFileSync(path.join(runtimeDirectory, LOCAL_BRIDGE_ENDPOINT_FILE), 'utf8'))).toEqual(endpoint);
  expect(readdirSync(runtimeDirectory).some((name) => name.endsWith('.tmp'))).toBe(false);

  const first = await authenticatedPeer(endpoint, token, 'first-auth');
  const second = await authenticatedPeer(endpoint, token, 'second-auth');
  first.send({ id: 1, method: 'echo', params: { value: 'pierwszy' } });
  second.send({ id: 2, method: 'echo', params: { value: 'drugi' } });
  const firstResult = await first.next();
  const secondResult = await second.next();
  expect(firstResult).toMatchObject({ id: 1, result: { method: 'echo', params: { value: 'pierwszy' } } });
  expect(secondResult).toMatchObject({ id: 2, result: { method: 'echo', params: { value: 'drugi' } } });
  expect((firstResult as { result: { sessionId: string } }).result.sessionId)
    .not.toBe((secondResult as { result: { sessionId: string } }).result.sessionId);
  expect(sessionFactory).toHaveBeenCalledTimes(2);

  first.close();
  second.close();
  await vi.waitFor(() => expect(closedSessions).toHaveLength(2));
  await server.stop();
  expect(server.endpoint).toBeNull();
  for (const removedPath of [
    path.join(runtimeDirectory, LOCAL_BRIDGE_ENDPOINT_FILE),
    endpoint.tokenPath,
    endpoint.socketPath,
    path.join(runtimeDirectory, 'bridge.lock'),
  ]) {
    expect(existsSync(removedPath)).toBe(false);
  }
});

it.skipIf(process.platform === 'win32')('odrzuca złe uwierzytelnienie przed utworzeniem sesji', async () => {
  const runtimeDirectory = temporaryRuntime();
  const sessionFactory = vi.fn(async (): Promise<LocalBridgeSession> => ({
    handleRequest: async () => null,
  }));
  const server = trackedServer(new LocalBridgeServer(runtimeDirectory, sessionFactory));
  const endpoint = await server.start();
  const peer = await connectPeer(endpoint.socketPath);

  peer.send({ id: 'auth', method: LOCAL_BRIDGE_AUTH_METHOD, params: { token: '0'.repeat(64) } });
  await expect(peer.next()).resolves.toEqual({
    id: 'auth',
    error: { code: -32001, message: 'Uwierzytelnienie bridge nie powiodło się.' },
  });
  await peer.waitForClose();
  expect(sessionFactory).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')('wymaga auth jako pierwszej wiadomości i egzekwuje auth timeout', async () => {
  const runtimeDirectory = temporaryRuntime();
  const server = trackedServer(new LocalBridgeServer(runtimeDirectory, async () => ({
    handleRequest: async () => null,
  }), { authTimeoutMs: 25 }));
  const endpoint = await server.start();

  const requestBeforeAuth = await connectPeer(endpoint.socketPath);
  requestBeforeAuth.send({ id: 1, method: 'project.context' });
  await expect(requestBeforeAuth.next()).resolves.toEqual({
    id: 1,
    error: { code: -32001, message: 'Pierwsza wiadomość musi uwierzytelnić bridge.' },
  });
  await requestBeforeAuth.waitForClose();

  const silent = await connectPeer(endpoint.socketPath);
  await expect(silent.next()).resolves.toEqual({
    id: null,
    error: { code: -32001, message: 'Przekroczono czas uwierzytelnienia bridge.' },
  });
  await silent.waitForClose();
});

it.skipIf(process.platform === 'win32')('sprząta sesję utworzoną już po timeout tworzenia', async () => {
  const runtimeDirectory = temporaryRuntime();
  const closeSession = vi.fn(async () => undefined);
  let resolveSession!: (session: LocalBridgeSession) => void;
  const sessionPromise = new Promise<LocalBridgeSession>((resolve) => { resolveSession = resolve; });
  const server = trackedServer(new LocalBridgeServer(runtimeDirectory, async () => sessionPromise, {
    requestTimeoutMs: 25,
  }));
  const endpoint = await server.start();
  const peer = await connectPeer(endpoint.socketPath);
  peer.send({
    id: 'auth',
    method: LOCAL_BRIDGE_AUTH_METHOD,
    params: { token: readFileSync(endpoint.tokenPath, 'utf8') },
  });

  await expect(peer.next()).resolves.toEqual({
    id: 'auth',
    error: { code: -32603, message: 'Nie udało się utworzyć sesji bridge.' },
  });
  await peer.waitForClose();
  resolveSession({ handleRequest: async () => null, close: closeSession });
  await vi.waitFor(() => expect(closeSession).toHaveBeenCalledTimes(1));
});

it.skipIf(process.platform === 'win32')('mapuje kontrolowane błędy, timeout i zbyt dużą odpowiedź', async () => {
  const runtimeDirectory = temporaryRuntime();
  const server = trackedServer(new LocalBridgeServer(runtimeDirectory, async () => ({
    handleRequest: async (method, _params, context) => {
      if (method === 'controlled') throw new LocalBridgeRequestError(-32050, 'Błąd domenowy.', { field: 'name' });
      if (method === 'slow') {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      if (method === 'large') return 'x'.repeat(1_000);
      return null;
    },
  }), { requestTimeoutMs: 25, maxResponseBytes: 256 }));
  const endpoint = await server.start();
  const token = readFileSync(endpoint.tokenPath, 'utf8');
  const peer = await authenticatedPeer(endpoint, token);

  peer.send({ id: 1, method: 'controlled' });
  await expect(peer.next()).resolves.toEqual({
    id: 1,
    error: { code: -32050, message: 'Błąd domenowy.', data: { field: 'name' } },
  });
  peer.send({ id: 2, method: 'slow' });
  await expect(peer.next()).resolves.toMatchObject({ id: 2, error: { code: -32002 } });
  peer.send({ id: 3, method: 'large' });
  await expect(peer.next()).resolves.toEqual({
    id: 3,
    error: { code: -32003, message: 'Odpowiedź bridge przekracza dozwolony rozmiar.' },
  });
  peer.close();
});

it.skipIf(process.platform === 'win32')('zamyka połączenie po przekroczeniu limitu linii', async () => {
  const runtimeDirectory = temporaryRuntime();
  const handler = vi.fn(async () => null);
  const server = trackedServer(new LocalBridgeServer(runtimeDirectory, async () => ({ handleRequest: handler }), {
    maxLineBytes: 128,
    maxBufferedBytes: 512,
  }));
  const endpoint = await server.start();
  const peer = await authenticatedPeer(endpoint, readFileSync(endpoint.tokenPath, 'utf8'));

  peer.send({ id: 1, method: 'oversized', params: { value: 'x'.repeat(256) } });
  await expect(peer.next()).resolves.toEqual({
    id: null,
    error: { code: -32003, message: 'Przekroczono limit pojedynczej wiadomości bridge.' },
  });
  await peer.waitForClose();
  expect(handler).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')('nie pozwala dwóm serwerom nadpisać tego samego runtime', async () => {
  const runtimeDirectory = temporaryRuntime();
  const createSession = async (): Promise<LocalBridgeSession> => ({ handleRequest: async () => null });
  const first = trackedServer(new LocalBridgeServer(runtimeDirectory, createSession));
  const second = trackedServer(new LocalBridgeServer(runtimeDirectory, createSession));
  await first.start();

  await expect(second.start()).rejects.toThrow('Inna instancja lokalnego bridge');
  await first.stop();
  await expect(second.start()).resolves.toMatchObject({ protocolVersion: 1 });
});

function temporaryRuntime(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tilemap-local-bridge-'));
  temporaryDirectories.push(directory);
  return directory;
}

function trackedServer(server: LocalBridgeServer): LocalBridgeServer {
  servers.push(server);
  return server;
}

function fileMode(filePath: string): number {
  return lstatSync(filePath).mode & 0o777;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function authenticatedPeer(endpoint: LocalBridgeEndpoint, token: string, id = 'auth'): Promise<JsonLinePeer> {
  const peer = await connectPeer(endpoint.socketPath);
  peer.send({ id, method: LOCAL_BRIDGE_AUTH_METHOD, params: { token } });
  await expect(peer.next()).resolves.toMatchObject({
    id,
    result: { protocolVersion: LOCAL_BRIDGE_PROTOCOL_VERSION },
  });
  return peer;
}

async function connectPeer(socketPath: string): Promise<JsonLinePeer> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return new JsonLinePeer(socket);
}

class JsonLinePeer {
  private buffer = '';
  private readonly messages: LocalBridgeResponse[] = [];
  private readonly waiters: Array<{
    resolve: (message: LocalBridgeResponse) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private readonly closePromise: Promise<void>;

  constructor(private readonly socket: Socket) {
    this.closePromise = new Promise((resolve) => socket.once('close', resolve));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (error) => this.rejectWaiters(error));
    socket.on('close', () => {
      this.closed = true;
      this.rejectWaiters(new Error('Socket został zamknięty.'));
    });
  }

  send(value: unknown): void {
    this.socket.write(`${JSON.stringify(value)}\n`);
  }

  next(): Promise<LocalBridgeResponse> {
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    if (this.closed) return Promise.reject(new Error('Socket został zamknięty.'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  close(): void {
    this.socket.destroy();
  }

  waitForClose(): Promise<void> {
    return this.closePromise;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const message = JSON.parse(line) as LocalBridgeResponse;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.messages.push(message);
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}
