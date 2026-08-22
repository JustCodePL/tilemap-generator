import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TILEMAP_TEST_USER_DATA },
  dialog: { showOpenDialog: vi.fn() },
}));

import { ProjectManager } from '../main/services/project-manager';

let temporaryDirectory = '';

beforeEach(() => {
  temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'tilemap-project-manager-'));
  process.env.TILEMAP_TEST_USER_DATA = temporaryDirectory;
});

afterEach(() => {
  delete process.env.TILEMAP_TEST_USER_DATA;
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

it('zachowuje nieistniejący ostatni projekt, sprawdza go przed otwarciem i usuwa tylko z historii', () => {
  const existingRoot = path.join(temporaryDirectory, 'existing-project');
  const missingRoot = path.join(temporaryDirectory, 'missing-project');
  mkdirSync(existingRoot);
  writeFileSync(path.join(temporaryDirectory, 'settings.json'), JSON.stringify({ recentProjects: [
    { name: 'Brakujący', rootPath: missingRoot, openedAt: '2026-08-07T10:00:00.000Z' },
    { name: 'Istniejący', rootPath: existingRoot, openedAt: '2026-08-06T10:00:00.000Z' },
  ] }), 'utf8');
  const manager = new ProjectManager();

  expect(manager.recents()).toHaveLength(2);
  expect(() => manager.open(missingRoot)).toThrow(`Projekt nie istnieje: ${missingRoot}`);
  expect(() => manager.open(existingRoot)).toThrow('Katalog nie zawiera kompletnego projektu Tilemap Generator');

  manager.removeRecent(missingRoot);
  const settings = JSON.parse(readFileSync(path.join(temporaryDirectory, 'settings.json'), 'utf8')) as {
    recentProjects: Array<{ rootPath: string }>;
  };
  expect(settings.recentProjects.map((recent) => recent.rootPath)).toEqual([existingRoot]);
  expect(existsSync(existingRoot)).toBe(true);
});
