import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import {
  characterDirectionsForProjection,
  defaultCharacterAnimationSettings,
  type CharacterAnimationSet,
  type ProjectProjection,
} from '../shared/domain';
import { ProjectDatabase } from '../main/db/project-database';
import { PhaserExporter } from '../main/services/phaser-exporter';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('eksportuje natywny Phaser File Pack z originem i zapamiętuje niezależny cel', async () => {
  const { root, target, database } = createProject('Phaser Pack');
  const source = path.join(root, 'tree.png');
  await sharp({
    create: { width: 32, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: Buffer.from(
    '<svg width="32" height="48"><rect x="14" y="22" width="4" height="24" fill="#684b31"/>'
    + '<circle cx="16" cy="16" r="14" fill="#4d8c52"/></svg>',
  ) }]).png().toFile(source);
  const job = approveAsset(database, source, {
    name: 'Stary dąb', category: 'vegetation', width: 32, height: 48,
    pivot: { x: 0.4, y: 0.125 },
  });

  const exporter = new PhaserExporter();
  const preview = await exporter.preview(database, { integration: 'phaser', targetDirectory: target });
  expect(preview).toMatchObject({ integration: 'phaser', assetCount: 1 });
  expect(preview.manifestPath).toBe(path.join(target, 'tilemap-assets.phaser.json'));
  expect(preview.files).toHaveLength(1);
  expect(preview.files[0]).toMatchObject({ role: 'asset', action: 'create', assetId: job.assetId });

  const result = exporter.run(database, preview.token);
  expect(result).toMatchObject({ assetCount: 1, fileCount: 1, writtenFileCount: 1 });
  expect(database.getProject().exportTargets.phaser).toBe(target);
  const section = readManifest(result.manifestPath);
  expect(section).toMatchObject({
    schemaVersion: 1,
    engine: 'phaser3',
    project: { name: 'Phaser Pack', projection: 'isometric' },
    grid: { orientation: 'isometric', tileWidthPx: 32, tileHeightPx: 16 },
  });
  expect(section.files).toEqual([expect.objectContaining({
    type: 'image',
    key: `tilemap-${job.assetId}`,
    url: expect.stringMatching(/^assets\/vegetation\/stary-dab--[a-f0-9]{8}\.png$/),
  })]);
  expect(section.assets[0]).toMatchObject({
    id: job.assetId,
    textureKey: `tilemap-${job.assetId}`,
    sourcePivotNormalized: { x: 0.4, y: 0.125 },
    origin: { x: 0.4, y: 0.875 },
  });
  expect(section.managedFiles).toContain('tilemap-assets.phaser.json');
  expect(section.managedFiles).toContain(section.files[0].url);

  const unchanged = await exporter.preview(database, { integration: 'phaser', targetDirectory: target });
  expect(unchanged.files).toHaveLength(1);
  expect(unchanged.files[0].action).toBe('unchanged');
  expect(exporter.run(database, unchanged.token).writtenFileCount).toBe(0);

  const tampered = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as Record<string, any>;
  tampered['tilemap-generator'].managedFiles.push('assets/foreign.png');
  writeFileSync(result.manifestPath, JSON.stringify(tampered));
  await expect(exporter.preview(database, { integration: 'phaser', targetDirectory: target }))
    .rejects.toThrow(/niespójną deklarację/);
  database.close();
});

it('eksportuje 16 top-down wariantów drogi z unikalnymi kluczami i synchronizuje cofnięcie approval', async () => {
  const { root, target, database } = createProject('Drogi Phaser', 'top_down');
  const job = database.enqueueGeneration({
    name: 'Leśna droga', prompt: '', mode: 'generate', category: 'road_tile', footprint: { x: 1, y: 1 },
  });
  const roadVariants = [];
  for (let mask = 0; mask < 16; mask += 1) {
    const filePath = path.join(root, `road-${mask}.png`);
    await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 120 + mask, g: 96, b: 62, alpha: 1 } },
    }).png().toFile(filePath);
    roadVariants.push({ connectionMask: mask, finalPath: database.relative(filePath), width: 32, height: 32 });
  }
  const grid = path.join(root, 'road-grid.png');
  await sharp({
    create: { width: 128, height: 128, channels: 4, background: { r: 90, g: 72, b: 48, alpha: 1 } },
  }).png().toFile(grid);
  database.finalizeGeneration(job.id, {
    finalPath: database.relative(grid), width: 32, height: 32, category: 'road_tile', tags: ['droga'],
    pivot: { x: 0.5, y: 0.5 }, description: 'Leśna droga', roadVariants,
  });
  database.reviewVersion({
    versionId: job.versionId, decision: 'approved', tags: ['droga'],
    footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 },
  });

  const exporter = new PhaserExporter();
  const preview = await exporter.preview(database, { integration: 'phaser', targetDirectory: target });
  expect(preview.files).toHaveLength(16);
  expect(preview.files.map((file) => file.variantMask)).toEqual(Array.from({ length: 16 }, (_, mask) => mask));
  exporter.run(database, preview.token);
  const section = readManifest(preview.manifestPath);
  expect(section.grid).toMatchObject({ orientation: 'orthogonal', tileWidthPx: 32, tileHeightPx: 32 });
  expect(section.files).toHaveLength(16);
  expect(new Set(section.files.map((file) => file.key)).size).toBe(16);
  expect(section.assets[0]).toMatchObject({ textureKey: null, file: null });
  expect(section.assets[0].roadVariants).toHaveLength(16);
  expect(section.assets[0].roadVariants[5]).toMatchObject({
    mask: 5,
    directions: ['N', 'S'],
    textureKey: `tilemap-${job.assetId}-road-05`,
    origin: { x: 0.5, y: 0.5 },
  });

  database.sqlite.prepare(`
    UPDATE road_variants SET height = 31 WHERE version_id = ? AND connection_mask = 15
  `).run(job.versionId);
  await expect(exporter.preview(database, { integration: 'phaser', targetDirectory: target }))
    .rejects.toThrow(/32×32/);
  database.sqlite.prepare(`
    UPDATE road_variants SET height = 32 WHERE version_id = ? AND connection_mask = 15
  `).run(job.versionId);
  database.sqlite.prepare(`
    DELETE FROM road_variants WHERE version_id = ? AND connection_mask = 15
  `).run(job.versionId);
  await expect(exporter.preview(database, { integration: 'phaser', targetDirectory: target }))
    .rejects.toThrow(/dokładnie 16/);
  database.sqlite.prepare(`
    INSERT INTO road_variants (version_id, connection_mask, final_path, width, height)
    VALUES (?, 15, ?, 32, 32)
  `).run(job.versionId, database.relative(path.join(root, 'road-15.png')));

  const stalePreview = await exporter.preview(database, { integration: 'phaser', targetDirectory: target });
  database.undoApproval(job.versionId);
  expect(() => exporter.run(database, stalePreview.token)).toThrow(/zmieniły się/);
  expect(readManifest(preview.manifestPath).assets).toHaveLength(1);
  const cleanup = await exporter.preview(database, { integration: 'phaser', targetDirectory: target });
  expect(cleanup.assetCount).toBe(0);
  expect(cleanup.files).toHaveLength(16);
  expect(cleanup.files.every((file) => file.action === 'delete')).toBe(true);
  exporter.run(database, cleanup.token);
  const emptySection = readManifest(cleanup.manifestPath);
  expect(emptySection.files).toEqual([]);
  expect(emptySection.assets).toEqual([]);
  expect(emptySection.managedFiles).toEqual(['tilemap-assets.phaser.json']);
  database.close();
});

it('eksportuje postać 5×4 jako spritesheet i gotowe definicje animacji Phaser', async () => {
  const { root, target, database } = createProject('Postacie Phaser', 'top_down', 64);
  const job = database.enqueueGeneration({
    name: 'Drwal', prompt: '', mode: 'generate', category: 'character',
    relativeWidth: 1, relativeHeight: 1, footprint: { x: 1, y: 1 },
    characterAnimation: { ...defaultCharacterAnimationSettings, framesPerSecond: 10 },
  });
  const source = path.join(root, 'drwal-sheet.png');
  await sharp({
    create: { width: 320, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: Buffer.from(
    '<svg width="320" height="256"><rect x="8" y="8" width="304" height="240" fill="#7f9858"/></svg>',
  ) }]).png().toFile(source);
  database.finalizeGeneration(job.id, {
    finalPath: database.relative(source), width: 320, height: 256, category: 'character', tags: ['drwal'],
    pivot: { x: 0.5, y: 0.04 }, description: 'Drwal',
    characterAnimation: passedCharacterAnimation('top_down', 64, 64, 10),
  });
  database.reviewVersion({
    versionId: job.versionId, decision: 'approved', tags: ['drwal'],
    footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.04 },
  });

  const exporter = new PhaserExporter();
  const preview = await exporter.preview(database, { integration: 'phaser', targetDirectory: target });
  exporter.run(database, preview.token);
  const section = readManifest(preview.manifestPath);
  expect(section.files).toEqual([expect.objectContaining({
    type: 'spritesheet',
    key: `tilemap-${job.assetId}`,
    frameConfig: { frameWidth: 64, frameHeight: 64, startFrame: 0, endFrame: 19 },
  })]);
  const animation = section.assets[0].characterAnimation;
  expect(animation).toMatchObject({
    textureKey: `tilemap-${job.assetId}`,
    origin: { x: 0.5, y: 0.96 },
    frameConfig: { frameWidth: 64, frameHeight: 64, columns: 5, rows: 4 },
  });
  expect(animation.directions.map((direction: { id: string }) => direction.id)).toEqual(['north', 'east', 'south', 'west']);
  expect(animation.directions.map((direction: { gridDelta: { x: number; y: number } }) => direction.gridDelta))
    .toEqual([{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]);
  expect(animation.animations[0]).toMatchObject({
    action: 'idle', direction: 'north', frameNumbers: [0],
    frames: [{ key: `tilemap-${job.assetId}`, frame: 0 }], repeat: -1,
  });
  expect(animation.animations[1]).toMatchObject({
    action: 'walk', direction: 'north', frameNumbers: [1, 2, 3, 4],
    frames: [1, 2, 3, 4].map((frame) => ({ key: `tilemap-${job.assetId}`, frame })),
    frameRate: 10,
  });
  expect(animation.animations[2]).toMatchObject({
    action: 'idle', direction: 'east', frameNumbers: [5],
    frames: [{ key: `tilemap-${job.assetId}`, frame: 5 }],
  });

  database.sqlite.prepare('UPDATE character_animation_sets SET analysis_status = ? WHERE version_id = ?')
    .run('failed', job.versionId);
  await expect(exporter.preview(database, { integration: 'phaser', targetDirectory: target }))
    .rejects.toThrow(/analiza ruchu/);
  database.close();
});

it('eksportuje blob47 jako spritesheet z frameIndex liczonym od lewego górnego rogu', async () => {
  const { root, target, database } = createProject('Teren Phaser', 'isometric', 32);
  const source = path.join(root, 'grass.png');
  await sharp({
    create: { width: 32, height: 16, channels: 4, background: { r: 72, g: 132, b: 70, alpha: 1 } },
  }).png().toFile(source);
  approveAsset(database, source, {
    name: 'Trawa', category: 'flat_tile', width: 32, height: 16,
    pivot: { x: 0.5, y: 0.5 },
  });

  const exporter = new PhaserExporter();
  const preview = await exporter.preview(database, { integration: 'phaser', targetDirectory: target });
  expect(preview.files.map((file) => file.role)).toEqual(['asset', 'terrain_blend_atlas', 'terrain_wall']);
  exporter.run(database, preview.token);
  const section = readManifest(preview.manifestPath);
  expect(section.grid.orientation).toBe('isometric');
  const blend = section.assets[0].terrainBlend;
  expect(blend.loader).toMatchObject({
    type: 'spritesheet', frameConfig: { frameWidth: 32, frameHeight: 16, startFrame: 0, endFrame: 46 },
  });
  expect(blend.variants).toHaveLength(47);
  expect(blend.variants[0]).toMatchObject({ frameIndex: 0, rectPx: { x: 0, y: 0, width: 32, height: 16 } });
  expect(blend.variants[46].frameIndex).toBe(46);
  expect(blend.wall).toMatchObject({ loader: { type: 'image' } });
  database.close();
});

it('blokuje obcy plik i cofa filesystem, gdy zapis historii eksportu się nie powiedzie', async () => {
  const { root, target, database } = createProject('Bezpieczny Phaser');
  const source = path.join(root, 'rock.png');
  writeFileSync(source, 'rock-source');
  const job = approveAsset(database, source, {
    name: 'Rock', category: 'prop', width: 16, height: 16,
    pivot: { x: 0.5, y: 0 },
  });
  const expectedDestination = path.join(target, 'assets', 'prop', `rock--${job.assetId.slice(0, 8)}.png`);
  mkdirSync(path.dirname(expectedDestination), { recursive: true });
  writeFileSync(expectedDestination, 'foreign');
  const exporter = new PhaserExporter();
  await expect(exporter.preview(database, { integration: 'phaser', targetDirectory: target }))
    .rejects.toThrow(/nie potwierdza własności/);
  rmSync(expectedDestination);

  const preview = await exporter.preview(database, { integration: 'phaser', targetDirectory: target });
  vi.spyOn(database, 'commitExport').mockImplementationOnce(() => {
    throw new Error('Testowy błąd SQLite');
  });
  expect(() => exporter.run(database, preview.token)).toThrow('Testowy błąd SQLite');
  expect(existsSync(expectedDestination)).toBe(false);
  expect(existsSync(preview.manifestPath)).toBe(false);
  expect(database.getProject().exportTargets.phaser).toBeUndefined();

  const result = exporter.run(database, preview.token);
  expect(result.writtenFileCount).toBe(1);
  expect(existsSync(expectedDestination)).toBe(true);
  database.close();
});

it.skipIf(process.platform === 'win32')('nie czyta ani nie zapisuje terenu przez symlinki poza biblioteką projektu', async () => {
  const first = createProject('Symlink źródła');
  const outsideSource = path.join(path.dirname(first.root), 'outside-source');
  mkdirSync(outsideSource);
  await sharp({
    create: { width: 32, height: 16, channels: 4, background: { r: 30, g: 120, b: 50, alpha: 1 } },
  }).png().toFile(path.join(outsideSource, 'grass.png'));
  symlinkSync(outsideSource, path.join(first.root, 'escape'), 'dir');
  approveAsset(first.database, path.join(first.root, 'escape', 'grass.png'), {
    name: 'Trawa poza projektem', category: 'flat_tile', width: 32, height: 16,
    pivot: { x: 0.5, y: 0.5 },
  });
  await expect(new PhaserExporter().preview(first.database, {
    integration: 'phaser', targetDirectory: first.target,
  })).rejects.toThrow(/symlink|wykracza/);
  expect(existsSync(path.join(outsideSource, 'derived'))).toBe(false);
  first.database.close();

  const second = createProject('Symlink derived');
  const source = path.join(second.root, 'grass.png');
  await sharp({
    create: { width: 32, height: 16, channels: 4, background: { r: 30, g: 120, b: 50, alpha: 1 } },
  }).png().toFile(source);
  const outsideDerived = path.join(path.dirname(second.root), 'outside-derived');
  mkdirSync(outsideDerived);
  symlinkSync(outsideDerived, path.join(second.root, 'derived'), 'dir');
  approveAsset(second.database, source, {
    name: 'Trawa z obcym derived', category: 'flat_tile', width: 32, height: 16,
    pivot: { x: 0.5, y: 0.5 },
  });
  await expect(new PhaserExporter().preview(second.database, {
    integration: 'phaser', targetDirectory: second.target,
  })).rejects.toThrow(/danych pochodnych.*symlink|symlink.*danych pochodnych/i);
  expect(readdirSync(outsideDerived)).toEqual([]);
  second.database.close();
});

function createProject(
  name: string,
  projection: ProjectProjection = 'isometric',
  tileWidthPx = 32,
) {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-phaser-'));
  temporaryDirectories.push(parent);
  const root = path.join(parent, 'project');
  const targetPath = path.join(parent, 'phaser-output');
  mkdirSync(root);
  mkdirSync(targetPath);
  const target = realpathSync.native(targetPath);
  return {
    root,
    target,
    database: ProjectDatabase.create(root, { name, artBrief: '', projection, tileWidthPx }),
  };
}

function approveAsset(
  database: ProjectDatabase,
  sourcePath: string,
  input: {
    name: string;
    category: 'vegetation' | 'prop' | 'flat_tile';
    width: number;
    height: number;
    pivot: { x: number; y: number };
  },
) {
  const job = database.enqueueGeneration({
    name: input.name, prompt: '', mode: 'generate', category: input.category,
    footprint: { x: 1, y: 1 },
  });
  database.finalizeGeneration(job.id, {
    finalPath: database.relative(sourcePath), width: input.width, height: input.height,
    category: input.category, tags: ['test'], pivot: input.pivot, description: input.name,
  });
  database.reviewVersion({
    versionId: job.versionId, decision: 'approved', tags: ['test'],
    footprint: { x: 1, y: 1 }, pivot: input.pivot,
  });
  return job;
}

function passedCharacterAnimation(
  projection: ProjectProjection,
  frameWidth: number,
  frameHeight: number,
  framesPerSecond: number,
): CharacterAnimationSet {
  const directions = [...characterDirectionsForProjection(projection)];
  return {
    settings: { ...defaultCharacterAnimationSettings, framesPerSecond },
    directions,
    frameSize: { width: frameWidth, height: frameHeight },
    sheetSize: { width: frameWidth * 5, height: frameHeight * 4 },
    movementAnalysis: {
      status: 'passed',
      summary: 'Wszystkie kierunki mają spójny chód.',
      directions: directions.map((direction) => ({
        direction: direction.id,
        status: 'passed',
        message: `Chód ${direction.shortLabel} jest stabilny.`,
      })),
      turnId: 'turn-phaser-character-analysis',
      analyzedAt: '2026-08-23T10:00:00.000Z',
    },
  };
}

type PhaserManifestSection = {
  schemaVersion: number;
  engine: string;
  managedFiles: string[];
  project: Record<string, unknown>;
  grid: Record<string, unknown>;
  files: Array<Record<string, any>>;
  assets: Array<Record<string, any>>;
};

function readManifest(manifestPath: string): PhaserManifestSection {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, PhaserManifestSection>;
  return manifest['tilemap-generator'];
}
