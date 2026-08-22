import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TILEMAP_TEST_USER_DATA },
  dialog: { showOpenDialog: vi.fn() },
}));

import { ProjectManager } from '../main/services/project-manager';
import { dialog } from 'electron';

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

it('tworzy bibliotekę bezpośrednio we wskazanym pustym katalogu', async () => {
  const storageDirectory = path.join(temporaryDirectory, 'moja-biblioteka');
  mkdirSync(storageDirectory);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: false,
    filePaths: [storageDirectory],
  });
  const manager = new ProjectManager();

  const selected = await manager.chooseStorageDirectory();
  expect(selected).toBe(storageDirectory);
  expect(dialog.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Wybierz katalog biblioteki assetów',
    properties: ['openDirectory', 'createDirectory'],
  }));

  const database = manager.create({
    name: 'Moja gra', artBrief: '', projection: 'top_down', tileWidthPx: 64,
  }, storageDirectory);
  expect(database.rootPath).toBe(storageDirectory);
  expect(existsSync(path.join(storageDirectory, 'tilemap-project.json'))).toBe(true);
  expect(existsSync(path.join(storageDirectory, 'moja-gra'))).toBe(false);
  manager.close();
});

it('odrzuca niewybrany albo niepusty katalog biblioteki', async () => {
  const ungrantedDirectory = path.join(temporaryDirectory, 'bez-grantu');
  mkdirSync(ungrantedDirectory);
  const manager = new ProjectManager();
  expect(() => manager.create({ name: 'Bez grantu', artBrief: '', tileWidthPx: 64 }, ungrantedDirectory))
    .toThrow(/nie został wybrany przez dialog/);

  const nonEmptyDirectory = path.join(temporaryDirectory, 'niepusty');
  mkdirSync(nonEmptyDirectory);
  writeFileSync(path.join(nonEmptyDirectory, 'keep.txt'), 'keep', 'utf8');
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: false,
    filePaths: [nonEmptyDirectory],
  });
  await expect(manager.chooseStorageDirectory()).rejects.toThrow(/nie jest pusty/);
});
