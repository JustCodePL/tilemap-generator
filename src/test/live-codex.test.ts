import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexService } from '../main/codex/codex-service';
import { ProjectDatabase } from '../main/db/project-database';

const enabled = process.env.TILEMAP_LIVE_CODEX === '1';
const directories: string[] = [];

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  directories.splice(0).forEach((directory) => rmSync(directory, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 100,
  }));
});

describe.skipIf(!enabled)('live Codex App Server', () => {
  it('wykrywa konto, image generation i aktywny skill imagegen', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-live-codex-'));
    directories.push(parent);
    const root = path.join(parent, 'project'); mkdirSync(root);
    const database = ProjectDatabase.create(root, {
      name: 'Live smoke', artBrief: '', tileWidthPx: 256,
    });
    const codex = new CodexService();
    try {
      const health = await codex.connect(database);
      expect(health, health.message).toMatchObject({
        state: 'ready', appServer: true, imageGeneration: true, imagegenSkill: true,
      });
    } finally {
      await codex.disconnect();
      database.close();
    }
  }, 60_000);
});
