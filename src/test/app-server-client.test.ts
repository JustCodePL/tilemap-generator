import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '../main/codex/app-server-client';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

it('obsługuje handshake, request/response i request inicjowany przez serwer', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-app-server-'));
  directories.push(directory);
  const script = path.join(directory, 'fake-app-server.mjs');
  writeFileSync(script, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    let triggerId = null;
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }));
      if (message.method === 'ping') console.log(JSON.stringify({ id: message.id, result: { pong: true } }));
      if (message.method === 'trigger') {
        triggerId = message.id;
        console.log(JSON.stringify({ id: 900, method: 'item/tool/call', params: { namespace: 'registry', tool: 'list_tags', arguments: {} } }));
      }
      if (message.id === 900 && message.result) console.log(JSON.stringify({ id: triggerId, result: message.result }));
    });
  `, 'utf8');
  const serverHandler = vi.fn(async () => ({ success: true, contentItems: [] }));
  const client = new CodexAppServerClient(directory, serverHandler, { command: process.execPath, args: [script] });
  await client.start();
  await expect(client.request('ping', {})).resolves.toEqual({ pong: true });
  await expect(client.request('trigger', {})).resolves.toEqual({ success: true, contentItems: [] });
  expect(serverHandler).toHaveBeenCalledWith('item/tool/call', expect.objectContaining({ tool: 'list_tags' }));
  await client.stop();
});
