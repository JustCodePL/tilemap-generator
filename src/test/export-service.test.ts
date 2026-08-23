import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
}));

import { dialog } from 'electron';
import type { ExportPreviewInput, ExportRunResult, ProjectInfo } from '../shared/domain';
import type { ProjectDatabase } from '../main/db/project-database';
import { ExportService, type ExportIntegrationAdapter } from '../main/services/export-service';

const firstToken = '11111111-1111-4111-8111-111111111111';
const secondToken = '22222222-2222-4222-8222-222222222222';

beforeEach(() => vi.clearAllMocks());

it('rejestruje Unity, Phaser i Godot jako niezależne integracje domyślne', () => {
  expect(new ExportService().listIntegrations()).toEqual([
    expect.objectContaining({ id: 'unity', label: 'Unity' }),
    expect.objectContaining({ id: 'phaser', label: 'Phaser 3' }),
    expect.objectContaining({ id: 'godot', label: 'Godot 4' }),
  ]);
});

it('udostępnia neutralny descriptor i grantuje cel tylko bieżącemu projektowi', async () => {
  const adapter = fakeAdapter();
  const service = new ExportService([adapter]);
  const targetDirectory = path.resolve('/game/Assets/Generated');
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [targetDirectory] });
  const project = fakeDatabase('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

  expect(service.listIntegrations()).toEqual([{
    id: 'unity',
    label: 'Unity',
    description: 'Testowa integracja',
    targetLabel: 'Katalog docelowy',
  }]);
  await expect(service.preview(project, {
    integration: 'unity', targetDirectory,
  })).rejects.toThrow(/nie został wybrany przez dialog/);

  await expect(service.chooseTarget(project, 'unity')).resolves.toBe(targetDirectory);
  expect(dialog.showOpenDialog).toHaveBeenCalledWith({
    title: 'Wybierz katalog docelowy integracji Unity',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Wybierz katalog',
  });
  await expect(service.preview(project, {
    integration: 'unity', targetDirectory,
  })).resolves.toMatchObject({ token: firstToken, integration: 'unity', targetDirectory });

  const otherProject = fakeDatabase('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  await expect(service.preview(otherProject, {
    integration: 'unity', targetDirectory,
  })).rejects.toThrow(/nie został wybrany przez dialog/);
});

it('akceptuje zapisany cel integracji i unieważnia token po zmianie projektu', async () => {
  const adapter = fakeAdapter();
  const service = new ExportService([adapter]);
  const targetDirectory = path.resolve('/game/Assets/Tilemaps');
  const firstProject = fakeDatabase('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { unity: targetDirectory });
  const secondProject = fakeDatabase('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

  const preview = await service.preview(firstProject, {
    integration: 'unity', targetDirectory,
  });
  expect(preview.token).toBe(firstToken);
  expect(() => service.run(secondProject, preview.token)).toThrow(/innego projektu/);
  expect(() => service.run(firstProject, preview.token)).toThrow(/wygasł/);
  expect(adapter.run).not.toHaveBeenCalled();

  const next = await service.preview(firstProject, {
    integration: 'unity', targetDirectory,
  });
  expect(next.token).toBe(secondToken);
  expect(service.run(firstProject, next.token)).toMatchObject({ assetCount: 1, fileCount: 1 });
  expect(adapter.run).toHaveBeenCalledWith(firstProject, secondToken);
  expect(() => service.run(firstProject, next.token)).toThrow(/wygasł/);
});

it('odrzuca dwie implementacje tej samej integracji', () => {
  expect(() => new ExportService([fakeAdapter(), fakeAdapter()])).toThrow(/tylko raz/);
});

function fakeDatabase(
  id: string,
  exportTargets: ProjectInfo['exportTargets'] = {},
): ProjectDatabase {
  return {
    getProject: () => ({ id, exportTargets }),
  } as unknown as ProjectDatabase;
}

function fakeAdapter(): ExportIntegrationAdapter & { run: ReturnType<typeof vi.fn> } {
  let previewCount = 0;
  const runResult: ExportRunResult = {
    assetCount: 1,
    fileCount: 1,
    writtenFileCount: 1,
    manifestPath: '/target/tilemap-assets.json',
  };
  return {
    integration: 'unity',
    descriptor: {
      id: 'unity', label: 'Unity', description: 'Testowa integracja', targetLabel: 'Katalog docelowy',
    },
    targetDialog: {
      title: 'Wybierz katalog docelowy integracji Unity',
      buttonLabel: 'Wybierz katalog',
    },
    validateTarget: (targetDirectory) => path.resolve(targetDirectory),
    preview: vi.fn(async (_database: ProjectDatabase, input: ExportPreviewInput) => {
      const token = previewCount === 0 ? firstToken : secondToken;
      previewCount += 1;
      return {
        token,
        integration: 'unity' as const,
        targetDirectory: input.targetDirectory,
        manifestPath: path.join(input.targetDirectory, 'tilemap-assets.json'),
        assetCount: 1,
        files: [{
          assetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          versionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          sourcePath: '/source.png',
          destinationPath: path.join(input.targetDirectory, 'asset.png'),
          role: 'asset' as const,
          action: 'create' as const,
        }],
      };
    }),
    run: vi.fn(() => runResult),
  };
}
