import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { ProjectDatabase } from '../main/db/project-database';
import { GodotExporter } from '../main/services/godot-exporter';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('eksportuje zatwierdzone assety do projektu Godot 4 ze ścieżkami res://', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-godot-'));
  temporaryDirectories.push(parent);
  const libraryRoot = path.join(parent, 'library');
  const godotRoot = path.join(parent, 'godot-game');
  const targetPath = path.join(godotRoot, 'assets', 'tilemap-generator');
  mkdirSync(libraryRoot);
  mkdirSync(targetPath, { recursive: true });
  writeFileSync(path.join(godotRoot, 'project.godot'), '[application]\nconfig/name="Godot Export Test"\n');
  const target = realpathSync.native(targetPath);
  const database = ProjectDatabase.create(libraryRoot, {
    name: 'Świat Godot', artBrief: '', projection: 'top_down', tileWidthPx: 32,
  });
  const source = path.join(libraryRoot, 'skala.png');
  await sharp({
    create: { width: 24, height: 30, channels: 4, background: { r: 100, g: 110, b: 120, alpha: 1 } },
  }).png().toFile(source);
  const job = database.enqueueGeneration({
    name: 'Duża skała', prompt: '', mode: 'generate', category: 'prop', footprint: { x: 1, y: 1 },
  });
  database.finalizeGeneration(job.id, {
    finalPath: database.relative(source), width: 24, height: 30, category: 'prop', tags: ['skała'],
    pivot: { x: 0.5, y: 0.1 }, description: 'Duża skała',
  });
  database.reviewVersion({
    versionId: job.versionId, decision: 'approved', tags: ['skała'],
    footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.1 },
  });

  const exporter = new GodotExporter();
  const preview = await exporter.preview(database, { integration: 'godot', targetDirectory: target });
  expect(preview).toMatchObject({ integration: 'godot', assetCount: 1 });
  expect(preview.manifestPath).toBe(path.join(target, 'tilemap-assets.godot.json'));
  expect(preview.files).toEqual([expect.objectContaining({ role: 'asset', action: 'create' })]);

  expect(exporter.run(database, preview.token)).toMatchObject({
    assetCount: 1, fileCount: 1, writtenFileCount: 1,
  });
  expect(database.getProject().exportTargets.godot).toBe(target);
  const section = readGodotManifest(preview.manifestPath);
  expect(section).toMatchObject({
    schemaVersion: 1,
    engine: 'godot4',
    project: { name: 'Świat Godot', projection: 'top_down' },
    grid: { orientation: 'orthogonal', tileWidthPx: 32, tileHeightPx: 32 },
    godot: {
      resourceRoot: 'res://assets/tilemap-generator',
      manifestPath: 'res://assets/tilemap-generator/tilemap-assets.godot.json',
    },
  });
  expect(section.files).toEqual([expect.objectContaining({
    type: 'image',
    key: `tilemap-${job.assetId}`,
    url: expect.stringMatching(/^assets\/prop\/.+--[a-f0-9]{8}\.png$/),
    resourcePath: expect.stringMatching(/^res:\/\/assets\/tilemap-generator\/assets\/prop\/.+--/),
  })]);
  expect(section.assets[0]).toMatchObject({
    id: job.assetId,
    resourcePath: section.files[0].resourcePath,
    sourcePivotNormalized: { x: 0.5, y: 0.1 },
    origin: { x: 0.5, y: 0.9 },
  });
  expect(section.managedFiles).toContain('tilemap-assets.godot.json');

  const unchanged = await exporter.preview(database, { integration: 'godot', targetDirectory: target });
  expect(unchanged.files).toEqual([expect.objectContaining({ action: 'unchanged' })]);
  expect(exporter.run(database, unchanged.token).writtenFileCount).toBe(0);

  database.undoApproval(job.versionId);
  const cleanup = await exporter.preview(database, { integration: 'godot', targetDirectory: target });
  expect(cleanup).toMatchObject({ assetCount: 0 });
  expect(cleanup.files).toEqual([expect.objectContaining({ action: 'delete' })]);
  exporter.run(database, cleanup.token);
  const emptySection = readGodotManifest(cleanup.manifestPath);
  expect(emptySection.assets).toEqual([]);
  expect(emptySection.files).toEqual([]);
  expect(emptySection.managedFiles).toEqual(['tilemap-assets.godot.json']);
  database.close();
});

it('wymaga celu wewnątrz projektu z bezpiecznym plikiem project.godot', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-godot-target-'));
  temporaryDirectories.push(parent);
  const target = path.join(parent, 'assets');
  mkdirSync(target);
  expect(() => new GodotExporter().validateTarget(target)).toThrow(/project\.godot/);
});

it('odrzuca manifest Godot innego silnika zamiast przejmować jego pliki', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-godot-manifest-'));
  temporaryDirectories.push(parent);
  const libraryRoot = path.join(parent, 'library');
  const godotRoot = path.join(parent, 'game');
  const target = path.join(godotRoot, 'generated');
  mkdirSync(libraryRoot);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(godotRoot, 'project.godot'), '[application]\nconfig/name="Manifest Test"\n');
  const database = ProjectDatabase.create(libraryRoot, { name: 'Manifest Godot', artBrief: '', tileWidthPx: 32 });
  writeFileSync(path.join(target, 'tilemap-assets.godot.json'), JSON.stringify({
    'tilemap-generator': {
      schemaVersion: 1,
      engine: 'phaser3',
      project: { id: database.getProject().id },
      managedFiles: ['tilemap-assets.godot.json'],
      files: [],
    },
  }));

  await expect(new GodotExporter().preview(database, {
    integration: 'godot', targetDirectory: target,
  })).rejects.toThrow(/nieobsługiwany schemat/);
  database.close();
});

type GodotManifestSection = {
  schemaVersion: number;
  engine: string;
  managedFiles: string[];
  project: Record<string, unknown>;
  grid: Record<string, unknown>;
  godot: Record<string, unknown>;
  files: Array<Record<string, any>>;
  assets: Array<Record<string, any>>;
};

function readGodotManifest(manifestPath: string): GodotManifestSection {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, GodotManifestSection>;
  return manifest['tilemap-generator'];
}
