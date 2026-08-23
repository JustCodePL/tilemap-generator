import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LocalBridgeRequestError,
  LocalBridgeServer,
  type LocalBridgeSession,
} from '../main/mcp/local-bridge-server';
import {
  TilemapAppClient,
  TilemapAppClientError,
} from '../mcp/tilemap-app-client';

const temporaryDirectories: string[] = [];
const servers: LocalBridgeServer[] = [];
const clients: TilemapAppClient[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'darwin')(
  'odkrywa bridge, uwierzytelnia trwałe połączenie, mapuje błąd i sprząta sesję',
  async () => {
    const runtimeDirectory = temporaryRuntime();
    const closeSession = vi.fn(async () => undefined);
    const handleRequest = vi.fn(async (method: string, params: unknown) => {
      if (method === 'failing') {
        throw new LocalBridgeRequestError(-32050, 'Kontrolowany błąd aplikacji.', { retryable: false });
      }
      return { method, params };
    });
    const sessionFactory = vi.fn(async (): Promise<LocalBridgeSession> => ({
      handleRequest,
      close: closeSession,
    }));
    const server = trackedServer(new LocalBridgeServer(runtimeDirectory, sessionFactory));
    const endpoint = await server.start();
    const client = trackedClient(new TilemapAppClient(runtimeDirectory, {
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    }));

    await client.connect();
    await expect(client.call('project.context', { projectId: 'project-1' })).resolves.toEqual({
      method: 'project.context',
      params: { projectId: 'project-1' },
    });
    await expect(client.call('failing')).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      message: 'Kontrolowany błąd aplikacji.',
      data: { code: -32050, data: { retryable: false } },
    });
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(handleRequest).toHaveBeenCalledTimes(2);

    await client.close();
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledTimes(1));
    await server.stop();
    expect(existsSync(path.join(runtimeDirectory, 'endpoint.json'))).toBe(false);
    expect(existsSync(endpoint.tokenPath)).toBe(false);
    expect(existsSync(endpoint.socketPath)).toBe(false);
  },
);

it.skipIf(process.platform !== 'darwin')('odrzuca niepoprawny descriptor bez ujawniania jego danych', async () => {
  const runtimeDirectory = temporaryRuntime();
  const descriptorSecret = 'descriptor-secret-that-must-not-leak';
  const server = trackedServer(new LocalBridgeServer(runtimeDirectory, async () => ({
    handleRequest: async () => null,
  })));
  await server.start();
  const descriptorPath = path.join(runtimeDirectory, 'endpoint.json');
  writeFileSync(descriptorPath, JSON.stringify({
    protocolVersion: 1,
    instanceId: descriptorSecret,
    pid: process.pid,
    socketPath: descriptorSecret,
    tokenPath: descriptorSecret,
    unexpected: descriptorSecret,
  }), { mode: 0o600 });
  chmodSync(descriptorPath, 0o600);
  const client = trackedClient(new TilemapAppClient(runtimeDirectory));

  const error = await captureError(client.connect());
  expect(error).toBeInstanceOf(TilemapAppClientError);
  expect(error).toMatchObject({ code: 'PROTOCOL_ERROR' });
  expect(serializeError(error)).not.toContain(descriptorSecret);
});

it.skipIf(process.platform !== 'darwin')('odrzuca podmieniony token bez ujawniania żadnego tokenu', async () => {
  const runtimeDirectory = temporaryRuntime();
  const sessionFactory = vi.fn(async (): Promise<LocalBridgeSession> => ({
    handleRequest: async () => null,
  }));
  const server = trackedServer(new LocalBridgeServer(runtimeDirectory, sessionFactory));
  const endpoint = await server.start();
  const actualToken = readFileSync(endpoint.tokenPath, 'utf8');
  const substitutedToken = actualToken === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
  writeFileSync(endpoint.tokenPath, substitutedToken, { mode: 0o600 });
  chmodSync(endpoint.tokenPath, 0o600);
  const client = trackedClient(new TilemapAppClient(runtimeDirectory, { connectTimeoutMs: 1_000 }));

  const error = await captureError(client.connect());
  expect(error).toBeInstanceOf(TilemapAppClientError);
  expect(error).toMatchObject({ code: 'REMOTE_ERROR' });
  expect((error as Error).message).toBe('Tilemap Generator odrzucił uwierzytelnienie lokalnego bridge.');
  const serializedError = serializeError(error);
  expect(serializedError).not.toContain(actualToken);
  expect(serializedError).not.toContain(substitutedToken);
  expect(sessionFactory).not.toHaveBeenCalled();
});

function temporaryRuntime(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tilemap-app-client-'));
  temporaryDirectories.push(directory);
  return directory;
}

function trackedServer(server: LocalBridgeServer): LocalBridgeServer {
  servers.push(server);
  return server;
}

function trackedClient(client: TilemapAppClient): TilemapAppClient {
  clients.push(client);
  return client;
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Oczekiwano odrzucenia operacji.');
}

function serializeError(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error);
  const appError = error as Error & { code?: unknown; data?: unknown };
  return JSON.stringify({
    name: appError.name,
    message: appError.message,
    code: appError.code,
    data: appError.data,
    stack: appError.stack,
  });
}
