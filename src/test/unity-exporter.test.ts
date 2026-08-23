import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectDatabase } from '../main/db/project-database';
import { UnityExporter } from '../main/services/unity-exporter';
import {
  characterDirectionsForProjection,
  defaultCharacterAnimationSettings,
  type AssetCategory,
  type CharacterAnimationSet,
  type ProjectProjection,
} from '../shared/domain';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function createUnityAssets(parent: string, projectName = 'UnityProject'): string {
  const unityRoot = path.join(parent, projectName);
  const assets = path.join(unityRoot, 'Assets');
  const projectSettings = path.join(unityRoot, 'ProjectSettings');
  mkdirSync(assets, { recursive: true });
  mkdirSync(projectSettings, { recursive: true });
  writeFileSync(path.join(projectSettings, 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.0f1\n', 'utf8');
  return realpathSync.native(assets);
}

function addApprovedAsset(
  database: ProjectDatabase,
  projectRoot: string,
  category: AssetCategory = 'vegetation',
  name = 'Drzewo',
) {
  const job = database.enqueueGeneration({
    name,
    prompt: '',
    mode: 'generate',
    category,
    footprint: { x: 1, y: 1 },
  });
  const source = path.join(projectRoot, `${job.versionId}.png`);
  writeFileSync(source, Buffer.from(`test-png-${job.versionId}`));
  database.finalizeGeneration(job.id, {
    finalPath: database.relative(source),
    width: 32,
    height: 32,
    category,
    tags: ['test'],
    pivot: { x: 0.5, y: 0.5 },
    description: name,
  });
  database.reviewVersion({
    versionId: job.versionId,
    decision: 'approved',
    tags: ['test'],
    footprint: { x: 1, y: 1 },
    pivot: { x: 0.5, y: 0.5 },
  });
  return job;
}

function passedCharacterAnimation(
  projection: ProjectProjection,
  frameWidth: number,
  frameHeight: number,
  framesPerSecond = 8,
  framesPerDirection = 8,
): CharacterAnimationSet {
  const directions = [...characterDirectionsForProjection(projection)];
  return {
    settings: { action: 'walk', framesPerDirection, framesPerSecond },
    directions,
    frameSize: { width: frameWidth, height: frameHeight },
    sheetSize: { width: frameWidth * (framesPerDirection + 1), height: frameHeight * 4 },
    movementAnalysis: {
      status: 'passed',
      summary: 'Każdy kierunek ma czytelny, spójny i poprawnie zapętlony chód.',
      directions: directions.map((direction) => ({
        direction: direction.id,
        status: 'passed',
        message: `Chód ${direction.shortLabel} jest poprawny.`,
      })),
      turnId: 'turn-character-analysis',
      analyzedAt: '2026-08-22T12:00:00.000Z',
    },
  };
}

it('eksportuje manifest i nie modyfikuje istniejącego .meta', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-export-'));
  directories.push(parent);
  const root = path.join(parent, 'project'); mkdirSync(root);
  const database = ProjectDatabase.create(root, { name: 'Las', artBrief: '', tileWidthPx: 256 });
  const job = database.enqueueGeneration({ name: 'Dąb', prompt: 'Stary dąb', mode: 'generate', category: 'vegetation', footprint: { x: 2, y: 2 } });
  const source = path.join(root, 'oak.png');
  await sharp({ create: { width: 64, height: 96, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="30" height="60"><rect x="13" y="25" width="5" height="35" fill="#593f2b"/><circle cx="15" cy="18" r="15" fill="#47643a"/></svg>'), left: 17, top: 18 }])
    .png().toFile(source);
  database.finalizeGeneration(job.id, { finalPath: database.relative(source), width: 64, height: 96, category: 'vegetation', tags: ['drzewo'], pivot: { x: 0.5, y: 0.08 }, description: 'Dąb' });
  database.reviewVersion({ versionId: job.versionId, decision: 'approved', tags: ['drzewo'], footprint: { x: 2, y: 2 }, pivot: { x: 0.5, y: 0 } });

  const unityAssets = createUnityAssets(parent);
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { integration: 'unity', targetDirectory: unityAssets });
  expect(path.dirname(preview.files[0].destinationPath)).toBe(path.join(unityAssets, 'vegetation'));
  expect(preview.files[0].destinationPath).not.toContain(`${path.sep}Las${path.sep}`);
  expect(preview.files[0].destinationPath).not.toContain(`${path.sep}Sprites${path.sep}`);
  expect(preview.manifestPath).toBe(path.join(unityAssets, 'tilemap-assets.json'));
  const metaPath = `${preview.files[0].destinationPath}.meta`;
  mkdirSync(path.dirname(metaPath), { recursive: true });
  writeFileSync(metaPath, 'guid: keep-me', 'utf8');
  const result = exporter.run(database, preview.token);

  expect(result).toMatchObject({ assetCount: 1, fileCount: 1, writtenFileCount: 1 });
  expect(existsSync(preview.files[0].destinationPath)).toBe(true);
  expect(readFileSync(metaPath, 'utf8')).toBe('guid: keep-me');
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
    schemaVersion: number;
    project: { projection: string };
    assets: Array<{ elevationLevels: number; relativeSize: { width: number; height: number }; expectedCanvasPx: null }>;
    tile: { widthPx: number; heightPx: number };
  };
  expect(manifest.schemaVersion).toBe(9);
  expect(manifest.project.projection).toBe('isometric');
  expect(manifest.assets).toHaveLength(1);
  expect(manifest.tile.widthPx).toBe(256);
  expect(manifest.tile.heightPx).toBe(128);
  expect(manifest.assets[0].elevationLevels).toBe(0);
  expect(manifest.assets[0].relativeSize).toEqual({ width: 1, height: 1 });
  expect(manifest.assets[0].expectedCanvasPx).toBeNull();
  const manifestMetaPath = `${result.manifestPath}.meta`;
  writeFileSync(manifestMetaPath, 'guid: stable-manifest-guid', 'utf8');
  const unchangedPreview = await exporter.preview(database, {
    integration: 'unity', targetDirectory: unityAssets,
  });
  expect(unchangedPreview.files[0].action).toBe('unchanged');
  expect(exporter.run(database, unchangedPreview.token).writtenFileCount).toBe(0);
  expect(readFileSync(manifestMetaPath, 'utf8')).toBe('guid: stable-manifest-guid');
  database.close();
});

it('eksportuje budynek z prefabowym workflow Grid i pędzlem footprintu', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-building-export-'));
  directories.push(parent);
  const root = path.join(parent, 'project'); mkdirSync(root);
  const database = ProjectDatabase.create(root, { name: 'Osada', artBrief: '', tileWidthPx: 256 });
  const job = database.enqueueGeneration({
    name: 'Tartak', prompt: '', mode: 'generate', category: 'building',
    relativeWidth: 1, relativeHeight: 2, footprint: { x: 2, y: 2 },
  });
  const source = path.join(root, 'sawmill.png');
  await sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(
      '<svg width="256" height="256">'
      + '<polygon points="128,24 228,84 128,144 28,84" fill="#9a6238"/>'
      + '<rect x="52" y="84" width="152" height="112" fill="#70452d"/>'
      + '</svg>',
    ) }]).png().toFile(source);
  database.finalizeGeneration(job.id, {
    finalPath: database.relative(source), width: 256, height: 256,
    category: 'building', tags: ['produkcja'],
    pivot: { x: 0.5, y: 0.125 }, description: 'Tartak',
  });
  database.reviewVersion({
    versionId: job.versionId, decision: 'approved', tags: ['produkcja'],
    footprint: { x: 2, y: 2 }, pivot: { x: 0.5, y: 0.125 },
  });

  const unityAssets = createUnityAssets(parent);
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { integration: 'unity', targetDirectory: unityAssets });
  expect(preview.files).toHaveLength(19);
  expect(preview.files[0].role).toBe('asset');
  expect(preview.files.slice(1).every((file) => file.role === 'integration_support')).toBe(true);
  const result = exporter.run(database, preview.token);
  expect(result).toMatchObject({ assetCount: 1, fileCount: 19, writtenFileCount: 19 });

  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
    assets: Array<{
      category: string;
      footprintCells: { x: number; y: number };
      pivotNormalized: { x: number; y: number };
      expectedCanvasPx: { width: number; height: number };
    }>;
  };
  expect(manifest.assets[0]).toMatchObject({
    category: 'building',
    footprintCells: { x: 2, y: 2 },
    pivotNormalized: { x: 0.5, y: 0.125 },
    expectedCanvasPx: { width: 256, height: 256 },
  });
  const integrationRoot = path.join(unityAssets, 'TilemapGeneratorIntegration');
  const runtimeMap = path.join(integrationRoot, 'Runtime', 'BuildingMap.cs');
  const editorBrush = path.join(integrationRoot, 'Editor', 'BuildingPlacementBrush.cs');
  const importer = path.join(integrationRoot, 'Editor', 'TerrainBlendImporter.cs');
  expect(readFileSync(runtimeMap, 'utf8')).toContain('public sealed class BuildingMap');
  const editorBrushSource = readFileSync(editorBrush, 'utf8');
  expect(editorBrushSource).toContain('Building Placement Brush');
  expect(editorBrushSource).toContain('map.CanPlace');
  expect(editorBrushSource).toContain('paletteTilemap.GetTile');
  expect(editorBrushSource).not.toContain('EditorGUILayout.Popup("Building"');
  expect(editorBrushSource).not.toContain('AssetPreview.GetAssetPreview');
  expect(editorBrushSource).not.toContain('DrawTextureTransparent');
  const terrainBrush = path.join(integrationRoot, 'Editor', 'TerrainBlendBrush.cs');
  const terrainBrushSource = readFileSync(terrainBrush, 'utf8');
  expect(terrainBrushSource).not.toContain('LabelField("Terrain"');
  expect(terrainBrushSource).not.toContain('LabelField("Priority"');
  expect(terrainBrushSource).not.toContain('LabelField("Type"');
  expect(readFileSync(importer, 'utf8')).toContain('PrefabUtility.SaveAsPrefabAsset');
  expect(readFileSync(importer, 'utf8')).toContain('renderer.sortingOrder = 200');
  expect(readFileSync(importer, 'utf8')).toContain('GridPaletteUtility.CreateNewPalette');
  const definitionSource = path.join(integrationRoot, 'Runtime', 'BuildingDefinition.cs');
  expect(readFileSync(definitionSource, 'utf8')).toContain('UnityEngine.Tilemaps.Tile');
  database.close();
});

it('eksportuje przeanalizowany arkusz postaci do ścisłego manifestu v9 i authoringu Unity', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-character-export-'));
  directories.push(parent);
  const root = path.join(parent, 'project'); mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Bohaterowie', artBrief: '', projection: 'top_down', tileWidthPx: 64,
  });
  const job = database.enqueueGeneration({
    name: 'Łuczniczka', prompt: '', mode: 'generate', category: 'character',
    relativeWidth: 1, relativeHeight: 1, footprint: { x: 1, y: 1 },
    characterAnimation: { ...defaultCharacterAnimationSettings, framesPerSecond: 12 },
  });
  const source = path.join(root, 'archer-sheet.png');
  await sharp({
    create: { width: 576, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: Buffer.from(
    '<svg width="576" height="256"><rect x="8" y="8" width="560" height="240" rx="8" fill="#5e8f63"/></svg>',
  ) }]).png().toFile(source);
  const animation = passedCharacterAnimation('top_down', 64, 64, 12);
  database.finalizeGeneration(job.id, {
    finalPath: database.relative(source), width: 576, height: 256,
    category: 'character', tags: ['łuczniczka'], pivot: { x: 0.5, y: 0.08 },
    description: 'Łuczniczka', characterAnimation: animation,
  });
  database.reviewVersion({
    versionId: job.versionId, decision: 'approved', tags: ['łuczniczka'],
    footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.08 },
  });

  const unityAssets = createUnityAssets(parent);
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { integration: 'unity', targetDirectory: unityAssets });
  expect(preview.files).toHaveLength(19);
  expect(preview.files[0]).toMatchObject({ role: 'asset', action: 'create' });
  expect(preview.files.slice(1).every((file) => file.role === 'integration_support')).toBe(true);
  const result = exporter.run(database, preview.token);
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
    schemaVersion: number;
    assets: Array<{
      file: string;
      expectedCanvasPx: { width: number; height: number };
      characterAnimation: {
        schemaVersion: number;
        settings: { action: string; framesPerDirection: number; framesPerSecond: number };
        sheet: Record<string, unknown>;
        directions: Array<Record<string, unknown>>;
        clips: Array<{ id: string; framesPerSecond: number; frames: unknown[] }>;
        movementAnalysis: { status: string; analyzer: { provider: string; turnId: string } };
      };
    }>;
  };
  expect(manifest.schemaVersion).toBe(9);
  expect(manifest.assets[0].expectedCanvasPx).toEqual({ width: 576, height: 256 });
  expect(manifest.assets[0].characterAnimation).toMatchObject({
    schemaVersion: 1,
    settings: { action: 'walk', framesPerDirection: 8, framesPerSecond: 12 },
    sheet: {
      file: manifest.assets[0].file,
      widthPx: 576,
      heightPx: 256,
      frameWidthPx: 64,
      frameHeightPx: 64,
      columns: 9,
      rows: 4,
      origin: 'top_left',
    },
    movementAnalysis: {
      status: 'passed', analyzer: { provider: 'codex', turnId: 'turn-character-analysis' },
    },
  });
  expect(manifest.assets[0].characterAnimation.directions).toEqual([
    { id: 'north', label: 'N', row: 0, screenDelta: { x: 0, y: -1 }, gridDelta: { x: 0, y: 1 } },
    { id: 'east', label: 'E', row: 1, screenDelta: { x: 1, y: 0 }, gridDelta: { x: 1, y: 0 } },
    { id: 'south', label: 'S', row: 2, screenDelta: { x: 0, y: 1 }, gridDelta: { x: 0, y: -1 } },
    { id: 'west', label: 'W', row: 3, screenDelta: { x: -1, y: 0 }, gridDelta: { x: -1, y: 0 } },
  ]);
  expect(manifest.assets[0].characterAnimation.clips).toHaveLength(8);
  expect(manifest.assets[0].characterAnimation.clips[0]).toMatchObject({
    id: 'idle_north', framesPerSecond: 12, frames: [expect.objectContaining({ column: 0, row: 0 })],
  });
  expect(manifest.assets[0].characterAnimation.clips[1]).toMatchObject({
    id: 'walk_north', framesPerSecond: 12,
  });
  expect(manifest.assets[0].characterAnimation.clips[1].frames).toHaveLength(8);

  const integrationRoot = path.join(unityAssets, 'TilemapGeneratorIntegration');
  expect(existsSync(path.join(integrationRoot, 'Runtime', 'CharacterDefinition.cs'))).toBe(true);
  expect(existsSync(path.join(integrationRoot, 'Runtime', 'DirectionalCharacterAnimator.cs'))).toBe(true);
  const importerSource = readFileSync(path.join(integrationRoot, 'Editor', 'TerrainBlendImporter.cs'), 'utf8');
  expect(importerSource).toContain('BlendTreeType.SimpleDirectional2D');
  expect(importerSource).toContain('Character.controller');

  database.sqlite.prepare(`
    UPDATE character_animation_sets SET analysis_status = 'failed' WHERE version_id = ?
  `).run(job.versionId);
  await expect(exporter.preview(database, {
    integration: 'unity', targetDirectory: unityAssets,
  })).rejects.toThrow(/analiza ruchu/);
  database.close();
});

it('eksportuje 16 wariantów road tile do manifestu v9 z provenance', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-road-export-'));
  directories.push(parent);
  const root = path.join(parent, 'project'); mkdirSync(root);
  const database = ProjectDatabase.create(root, { name: 'Drogi', artBrief: '', tileWidthPx: 256 });
  const job = database.enqueueGeneration({
    name: 'Piaskowa droga', prompt: '', mode: 'generate', category: 'road_tile',
    footprint: { x: 1, y: 1 },
  });
  const roadVariants = [];
  for (let connectionMask = 0; connectionMask < 16; connectionMask += 1) {
    const source = path.join(root, `road-${connectionMask.toString().padStart(2, '0')}.png`);
    await sharp({ create: { width: 256, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="256" height="128"><circle cx="128" cy="64" r="20" fill="#c78b43"/></svg>') }])
      .png().toFile(source);
    roadVariants.push({ connectionMask, finalPath: database.relative(source), width: 256, height: 128 });
  }
  const source = path.join(root, 'road-grid.png');
  await sharp({ create: { width: 1024, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png().toFile(source);
  database.finalizeGeneration(job.id, {
    finalPath: database.relative(source), width: 256, height: 128,
    category: 'road_tile', tags: ['droga'], pivot: { x: 0.5, y: 0.5 }, description: 'Piaskowa droga',
    roadVariants,
  });
  database.reviewVersion({
    versionId: job.versionId, decision: 'approved', tags: ['droga'],
    footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 },
  });

  const unityAssets = createUnityAssets(parent);
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { integration: 'unity', targetDirectory: unityAssets });
  expect(preview.files).toHaveLength(34);
  expect(preview.files.slice(0, 16).map((file) => file.variantMask)).toEqual(Array.from({ length: 16 }, (_, mask) => mask));
  expect(preview.files.slice(16).every((file) => file.role === 'integration_support')).toBe(true);
  const result = exporter.run(database, preview.token);
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
    schemaVersion: number;
    assets: Array<{
      category: string;
      file: null;
      roadVariants: Array<{ mask: number; directions: string[]; file: string; width: number; height: number }>;
      expectedCanvasPx: { width: number; height: number };
      generatedBy: { provider: string; model: string | null };
    }>;
  };
  expect(result).toMatchObject({ assetCount: 1, fileCount: 34, writtenFileCount: 34 });
  expect(manifest.schemaVersion).toBe(9);
  expect(manifest.assets[0]).toMatchObject({
    category: 'road_tile',
    file: null,
    expectedCanvasPx: { width: 256, height: 128 },
    generatedBy: { provider: 'codex', model: 'imagegen' },
  });
  expect(manifest.assets[0].roadVariants).toHaveLength(16);
  expect(manifest.assets[0].roadVariants[5]).toMatchObject({
    mask: 5, directions: ['NW', 'SE'], width: 256, height: 128,
  });
  expect(manifest.assets[0].roadVariants[5].file).toMatch(/road_tile\/piaskowa-droga--[a-f0-9]{8}\/road-05\.png$/);
  const importer = path.join(unityAssets, 'TilemapGeneratorIntegration', 'Editor', 'TerrainBlendImporter.cs');
  const importerSource = readFileSync(importer, 'utf8');
  expect(importerSource).toContain('RoadRuleTile.asset');
  expect(importerSource).toContain('new(1, new Vector3Int(-1, 0, 0))');
  expect(importerSource).toContain('CreateTilemap(root.transform, "Roads", 100)');
  database.undoApproval(job.versionId);
  const syncPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: unityAssets });
  expect(syncPreview.files).toHaveLength(16);
  expect(syncPreview.files.every((file) => file.action === 'delete' && file.role === undefined)).toBe(true);
  exporter.run(database, syncPreview.token);
  expect(manifest.assets[0].roadVariants.every((variant) => (
    !existsSync(path.join(unityAssets, ...variant.file.split('/')))
  ))).toBe(true);
  database.close();
});

it('eksportuje top-down jako kwadratowy projekt z kierunkami dróg N/E/S/W', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-top-down-export-'));
  directories.push(parent);
  const root = path.join(parent, 'project'); mkdirSync(root);
  const database = ProjectDatabase.create(root, {
    name: 'Top-down',
    artBrief: '',
    projection: 'top_down',
    tileWidthPx: 32,
  });
  const job = database.enqueueGeneration({
    name: 'Droga', prompt: '', mode: 'generate', category: 'road_tile',
    footprint: { x: 1, y: 1 },
  });
  const source = path.join(root, 'road.png');
  await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 190, g: 140, b: 80, alpha: 1 },
    },
  }).png().toFile(source);
  database.finalizeGeneration(job.id, {
    finalPath: database.relative(source),
    width: 32,
    height: 32,
    category: 'road_tile',
    tags: ['droga'],
    pivot: { x: 0.5, y: 0.5 },
    description: 'Droga top-down',
    roadVariants: Array.from({ length: 16 }, (_, connectionMask) => ({
      connectionMask,
      finalPath: database.relative(source),
      width: 32,
      height: 32,
    })),
  });
  database.reviewVersion({
    versionId: job.versionId,
    decision: 'approved',
    tags: ['droga'],
    footprint: { x: 1, y: 1 },
    pivot: { x: 0.5, y: 0.5 },
  });

  const unityAssets = createUnityAssets(parent);
  const unityTarget = path.join(unityAssets, 'Generated', 'Tilemaps');
  mkdirSync(unityTarget, { recursive: true });
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { integration: 'unity', targetDirectory: unityTarget });
  expect(preview.targetDirectory).toBe(unityTarget);
  expect(preview.manifestPath).toBe(path.join(unityTarget, 'tilemap-assets.json'));
  const result = exporter.run(database, preview.token);
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
    schemaVersion: number;
    project: { projection: string };
    tile: { widthPx: number; heightPx: number };
    assets: Array<{
      expectedCanvasPx: { width: number; height: number };
      roadVariants: Array<{ mask: number; directions: string[] }>;
    }>;
  };
  expect(manifest).toMatchObject({
    schemaVersion: 9,
    project: { projection: 'top_down' },
    tile: { widthPx: 32, heightPx: 32 },
  });
  expect(manifest.assets[0].expectedCanvasPx).toEqual({ width: 32, height: 32 });
  expect(manifest.assets[0].roadVariants[5]).toMatchObject({ mask: 5, directions: ['N', 'S'] });
  expect(manifest.assets[0].roadVariants[10]).toMatchObject({ mask: 10, directions: ['E', 'W'] });
  database.close();
});

it('odrzuca cel, który nie znajduje się w katalogu Assets projektu Unity', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-invalid-unity-target-'));
  directories.push(parent);
  const target = path.join(parent, 'MyAssetsOutput');
  mkdirSync(target);
  expect(() => new UnityExporter().validateTarget(target)).toThrow(/w Assets/);
});

it('eksportuje atlas 47 wariantów blendingu dla zatwierdzonego elevated terrain', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-terrain-export-'));
  directories.push(parent);
  const root = path.join(parent, 'project'); mkdirSync(root);
  const database = ProjectDatabase.create(root, { name: 'Tereny', artBrief: '', tileWidthPx: 256 });
  const job = database.enqueueGeneration({
    name: 'Łąka', prompt: '', mode: 'generate', category: 'elevated_tile', elevationLevels: 1,
    footprint: { x: 1, y: 1 },
  });
  const source = path.join(root, 'meadow.png');
  await sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(
      '<svg width="256" height="256">'
      + '<polygon points="128,0 256,64 128,128 0,64" fill="#86ad45"/>'
      + '<polygon points="0,64 128,128 128,256 0,192" fill="#5d4128"/>'
      + '<polygon points="256,64 128,128 128,256 256,192" fill="#765033"/>'
      + '</svg>',
    ) }]).png().toFile(source);
  database.finalizeGeneration(job.id, {
    finalPath: database.relative(source), width: 256, height: 256,
    category: 'elevated_tile', tags: ['trawa'],
    pivot: { x: 0.5, y: 0.5 }, description: 'Łąka',
  });
  database.reviewVersion({
    versionId: job.versionId, decision: 'approved', tags: ['trawa'],
    footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 },
  });

  const unityAssets = createUnityAssets(parent);
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { integration: 'unity', targetDirectory: unityAssets });
  expect(preview.files).toHaveLength(21);
  expect(preview.files.map((file) => file.role)).toEqual([
    'asset', 'terrain_blend_atlas', 'terrain_wall',
    ...Array.from({ length: 18 }, () => 'integration_support'),
  ]);
  const result = exporter.run(database, preview.token);
  expect(result).toMatchObject({ assetCount: 1, fileCount: 21, writtenFileCount: 21 });

  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
    schemaVersion: number;
    assets: Array<{
      terrainBlend: {
        mode: string;
        atlasFile: string;
        wallFile: string;
        variants: Array<{ mask: number; spriteName: string }>;
        pivotNormalized: { x: number; y: number };
      };
    }>;
  };
  expect(manifest.schemaVersion).toBe(9);
  expect(manifest.assets[0].terrainBlend).toMatchObject({
    mode: 'blob47_top_overlay',
    pivotNormalized: { x: 0.5, y: 0.75 },
  });
  expect(manifest.assets[0].terrainBlend.variants).toHaveLength(47);
  expect(manifest.assets[0].terrainBlend.atlasFile).toMatch(/elevated_tile\/aka--[a-f0-9]{8}--blend\.png$/);
  expect(manifest.assets[0].terrainBlend.wallFile).toMatch(/elevated_tile\/aka--[a-f0-9]{8}--walls\.png$/);
  database.undoApproval(job.versionId);
  const syncPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: unityAssets });
  expect(syncPreview.files).toHaveLength(3);
  expect(syncPreview.files.every((file) => file.action === 'delete')).toBe(true);
  exporter.run(database, syncPreview.token);
  expect(syncPreview.files.every((file) => !existsSync(file.destinationPath))).toBe(true);
  database.close();
});

it('usuwa z delivery wyłącznie plik cofniętego zatwierdzenia i zachowuje jego .meta', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-unapprove-sync-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'Sync', artBrief: '', tileWidthPx: 32 });
  const job = addApprovedAsset(database, projectRoot);
  const unityAssets = createUnityAssets(parent);
  const target = path.join(unityAssets, 'ApprovedAssets');
  mkdirSync(target);
  const exporter = new UnityExporter();

  const firstPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: target });
  const exportedAsset = firstPreview.files.find((file) => file.role === 'asset')!;
  exporter.run(database, firstPreview.token);
  const metaPath = `${exportedAsset.destinationPath}.meta`;
  writeFileSync(metaPath, 'guid: preserve-me', 'utf8');

  database.undoApproval(job.versionId);
  const syncPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: target });
  expect(syncPreview.assetCount).toBe(0);
  expect(syncPreview.files).toEqual([expect.objectContaining({
    sourcePath: null,
    destinationPath: exportedAsset.destinationPath,
    action: 'delete',
  })]);
  expect(syncPreview.files.some((file) => file.destinationPath.endsWith('.meta'))).toBe(false);

  const result = exporter.run(database, syncPreview.token);
  expect(result).toMatchObject({ assetCount: 0, fileCount: 1, writtenFileCount: 1 });
  expect(existsSync(exportedAsset.destinationPath)).toBe(false);
  expect(readFileSync(metaPath, 'utf8')).toBe('guid: preserve-me');
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
    schemaVersion: number;
    managedFiles: string[];
    assets: unknown[];
  };
  expect(manifest).toMatchObject({
    schemaVersion: 9,
    managedFiles: ['tilemap-assets.json'],
    assets: [],
  });
  database.close();
});

it('przenosi delivery w obrębie tego samego Unity Assets bez duplikowania integracji', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-retarget-sync-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'Retarget', artBrief: '', tileWidthPx: 32 });
  addApprovedAsset(database, projectRoot, 'building', 'Dom');
  const unityAssets = createUnityAssets(parent);
  const oldTarget = path.join(unityAssets, 'OldDelivery');
  const newTarget = path.join(unityAssets, 'NewDelivery');
  mkdirSync(oldTarget);
  mkdirSync(newTarget);
  const exporter = new UnityExporter();

  const firstPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: oldTarget });
  const oldAsset = firstPreview.files.find((file) => file.role === 'asset')!.destinationPath;
  exporter.run(database, firstPreview.token);
  const integrationRoot = path.join(unityAssets, 'TilemapGeneratorIntegration');
  const importerPath = path.join(integrationRoot, 'Editor', 'TerrainBlendImporter.cs');
  expect(existsSync(importerPath)).toBe(true);

  const retargetPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: newTarget });
  const deletes = retargetPreview.files.filter((file) => file.action === 'delete');
  expect(deletes.map((file) => file.destinationPath).sort()).toEqual([
    oldAsset,
    path.join(oldTarget, 'tilemap-assets.json'),
  ].sort());
  expect(deletes.some((file) => file.destinationPath.startsWith(integrationRoot))).toBe(false);
  expect(retargetPreview.files.filter((file) => file.role === 'integration_support')
    .every((file) => file.action === 'unchanged')).toBe(true);

  const newAsset = retargetPreview.files.find((file) => file.role === 'asset')!.destinationPath;
  const commitSpy = vi.spyOn(database, 'commitExport').mockImplementation(() => {
    throw new Error('retarget database failure');
  });
  expect(() => exporter.run(database, retargetPreview.token)).toThrow(/retarget database failure/);
  expect(existsSync(oldAsset)).toBe(true);
  expect(existsSync(path.join(oldTarget, 'tilemap-assets.json'))).toBe(true);
  expect(existsSync(newAsset)).toBe(false);
  expect(existsSync(path.join(newTarget, 'tilemap-assets.json'))).toBe(false);
  expect(database.getProject().exportTargets.unity).toBe(oldTarget);
  commitSpy.mockRestore();

  const retryPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: newTarget });
  exporter.run(database, retryPreview.token);
  expect(existsSync(oldAsset)).toBe(false);
  expect(existsSync(path.join(oldTarget, 'tilemap-assets.json'))).toBe(false);
  expect(existsSync(path.join(newTarget, 'tilemap-assets.json'))).toBe(true);
  expect(existsSync(importerPath)).toBe(true);
  database.close();
});

it('pozostawia poprzednie delivery przy eksporcie do innego projektu Unity', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-second-unity-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'Dwa Unity', artBrief: '', tileWidthPx: 32 });
  addApprovedAsset(database, projectRoot);
  const firstTarget = path.join(createUnityAssets(parent, 'UnityOne'), 'Delivery');
  const secondTarget = path.join(createUnityAssets(parent, 'UnityTwo'), 'Delivery');
  mkdirSync(firstTarget);
  mkdirSync(secondTarget);
  const exporter = new UnityExporter();

  const firstPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: firstTarget });
  const oldAsset = firstPreview.files.find((file) => file.role === 'asset')!.destinationPath;
  exporter.run(database, firstPreview.token);
  const secondPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: secondTarget });
  expect(secondPreview.files.some((file) => file.action === 'delete')).toBe(false);
  exporter.run(database, secondPreview.token);
  expect(existsSync(oldAsset)).toBe(true);
  expect(existsSync(path.join(firstTarget, 'tilemap-assets.json'))).toBe(true);
  database.close();
});

it.each([
  ['obcy', JSON.stringify({
    schemaVersion: 9,
    managedFiles: ['tilemap-assets.json'],
    project: { id: randomUUID(), name: 'Foreign', projection: 'isometric' },
    assets: [],
  })],
  ['nieczytelny', '{broken-json'],
  ['stary', JSON.stringify({
    schemaVersion: 7,
    project: { id: randomUUID(), name: 'Legacy', projection: 'isometric' },
    assets: [],
  })],
])('blokuje %s manifest zamiast nadpisywać delivery', async (_kind, manifestContent) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-foreign-manifest-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'Safety', artBrief: '', tileWidthPx: 32 });
  addApprovedAsset(database, projectRoot);
  const target = path.join(createUnityAssets(parent), 'Delivery');
  mkdirSync(target);
  const manifestPath = path.join(target, 'tilemap-assets.json');
  writeFileSync(manifestPath, manifestContent, 'utf8');

  await expect(new UnityExporter().preview(database, {
    integration: 'unity', targetDirectory: target,
  })).rejects.toThrow(/Manifest|manifest|schemaVersion/);
  expect(readFileSync(manifestPath, 'utf8')).toBe(manifestContent);
  database.close();
});

it('blokuje pierwszy eksport, gdy docelowy plik nie ma manifestu własności', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-first-export-collision-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'Collision', artBrief: '', tileWidthPx: 32 });
  const job = addApprovedAsset(database, projectRoot, 'vegetation', 'Drzewo');
  const target = path.join(createUnityAssets(parent), 'Delivery');
  const collisionPath = path.join(target, 'vegetation', `drzewo--${job.assetId.slice(0, 8)}.png`);
  mkdirSync(path.dirname(collisionPath), { recursive: true });
  writeFileSync(collisionPath, 'foreign-content', 'utf8');

  await expect(new UnityExporter().preview(database, {
    integration: 'unity', targetDirectory: target,
  })).rejects.toThrow(/manifest nie potwierdza własności/);
  expect(readFileSync(collisionPath, 'utf8')).toBe('foreign-content');
  database.close();
});

it('nie blokuje nowego Unity, gdy zapamiętany poprzedni cel już nie istnieje', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-detached-unity-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'Detached', artBrief: '', tileWidthPx: 32 });
  addApprovedAsset(database, projectRoot);
  database.setExportTarget('unity', path.join(parent, 'DetachedUnity', 'Assets', 'Delivery'));
  const target = path.join(createUnityAssets(parent, 'CurrentUnity'), 'Delivery');
  mkdirSync(target);

  const preview = await new UnityExporter().preview(database, {
    integration: 'unity', targetDirectory: target,
  });
  expect(preview.assetCount).toBe(1);
  expect(preview.files.some((file) => file.action === 'delete')).toBe(false);
  database.close();
});

it('odrzuca marker integracji Unity z plikiem spoza ścisłej allowlisty', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-support-ownership-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'Support', artBrief: '', tileWidthPx: 32 });
  addApprovedAsset(database, projectRoot, 'building', 'Wieża');
  const unityAssets = createUnityAssets(parent);
  const target = path.join(unityAssets, 'Delivery');
  mkdirSync(target);
  const exporter = new UnityExporter();
  const firstPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: target });
  exporter.run(database, firstPreview.token);

  const integrationRoot = path.join(unityAssets, 'TilemapGeneratorIntegration');
  const markerPath = path.join(integrationRoot, 'tilemap-generator-integration.json');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { managedFiles: string[] };
  marker.managedFiles.push('foreign.txt');
  writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
  const foreignPath = path.join(integrationRoot, 'foreign.txt');
  writeFileSync(foreignPath, 'keep', 'utf8');

  await expect(exporter.preview(database, {
    integration: 'unity', targetDirectory: target,
  })).rejects.toThrow(/dokładnej listy/);
  expect(readFileSync(foreignPath, 'utf8')).toBe('keep');
  database.close();
});

it('nie osieroca utworzonych plików, gdy staging manifestu kończy się błędem', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-export-rollback-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'Rollback', artBrief: '', tileWidthPx: 32 });
  addApprovedAsset(database, projectRoot, 'building', 'Warsztat');
  const unityAssets = createUnityAssets(parent);
  const target = path.join(unityAssets, 'Delivery');
  mkdirSync(target);
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { integration: 'unity', targetDirectory: target });
  const exportedAsset = preview.files.find((file) => file.role === 'asset')!.destinationPath;
  const occupiedStage = path.join(target, `.tilemap-assets.json.${preview.token}.stage`);
  writeFileSync(occupiedStage, 'foreign-temp', 'utf8');

  expect(() => exporter.run(database, preview.token)).toThrow(/Tymczasowy plik eksportu/);
  expect(existsSync(exportedAsset)).toBe(false);
  expect(existsSync(preview.manifestPath)).toBe(false);
  expect(readFileSync(occupiedStage, 'utf8')).toBe('foreign-temp');
  expect(existsSync(path.join(unityAssets, 'TilemapGeneratorIntegration'))).toBe(false);

  rmSync(occupiedStage);
  const retryPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: target });
  exporter.run(database, retryPreview.token);
  expect(existsSync(retryPreview.manifestPath)).toBe(true);
  expect(existsSync(path.join(
    unityAssets,
    'TilemapGeneratorIntegration',
    'tilemap-generator-integration.json',
  ))).toBe(true);
  database.close();
});

it.each([
  '../escape.png',
  '/absolute.png',
  'C:/escape.png',
  'folder\\escape.png',
  'Generated/foreign.asset',
  'vegetation/foreign.png.meta',
])('odrzuca niebezpieczną ścieżkę managedFiles: %s', async (managedPath) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-managed-path-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'Paths', artBrief: '', tileWidthPx: 32 });
  const target = path.join(createUnityAssets(parent), 'Delivery');
  mkdirSync(target);
  writeFileSync(path.join(target, 'tilemap-assets.json'), JSON.stringify({
    schemaVersion: 9,
    managedFiles: ['tilemap-assets.json', managedPath],
    project: {
      id: database.getProject().id,
      name: 'Paths',
      projection: 'isometric',
    },
    assets: [],
  }), 'utf8');

  await expect(new UnityExporter().preview(database, {
    integration: 'unity', targetDirectory: target,
  })).rejects.toThrow(/Manifest/);
  database.close();
});

it('nie usuwa pliku zarządzanego zmienionego po przygotowaniu preview', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-stale-preview-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'Stale preview', artBrief: '', tileWidthPx: 32 });
  const job = addApprovedAsset(database, projectRoot);
  const target = path.join(createUnityAssets(parent), 'Delivery');
  mkdirSync(target);
  const exporter = new UnityExporter();
  const firstPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: target });
  const exportedAsset = firstPreview.files.find((file) => file.role === 'asset')!.destinationPath;
  exporter.run(database, firstPreview.token);
  database.undoApproval(job.versionId);
  const deletePreview = await exporter.preview(database, { integration: 'unity', targetDirectory: target });
  writeFileSync(exportedAsset, 'externally-replaced', 'utf8');

  expect(() => exporter.run(database, deletePreview.token)).toThrow(/Pliki docelowe zmieniły się/);
  expect(readFileSync(exportedAsset, 'utf8')).toBe('externally-replaced');
  database.close();
});

it('przywraca filesystem, gdy atomowy zapis eksportu w bazie zawiedzie', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-db-rollback-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'DB rollback', artBrief: '', tileWidthPx: 32 });
  addApprovedAsset(database, projectRoot);
  const target = path.join(createUnityAssets(parent), 'Delivery');
  mkdirSync(target);
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { integration: 'unity', targetDirectory: target });
  const exportedAsset = preview.files.find((file) => file.role === 'asset')!.destinationPath;
  const commitSpy = vi.spyOn(database, 'commitExport').mockImplementation(() => {
    throw new Error('test database failure');
  });

  expect(() => exporter.run(database, preview.token)).toThrow(/test database failure/);
  expect(existsSync(exportedAsset)).toBe(false);
  expect(existsSync(preview.manifestPath)).toBe(false);
  expect(existsSync(path.dirname(exportedAsset))).toBe(false);
  expect(database.getProject().exportTargets).toEqual({});
  expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM export_records').get())
    .toMatchObject({ count: 0 });

  commitSpy.mockRestore();
  const retryPreview = await exporter.preview(database, { integration: 'unity', targetDirectory: target });
  exporter.run(database, retryPreview.token);
  expect(existsSync(retryPreview.manifestPath)).toBe(true);
  database.close();
});

it('traktuje symlink do tego samego celu jako ten sam canonical target', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-target-alias-'));
  directories.push(parent);
  const projectRoot = path.join(parent, 'library');
  mkdirSync(projectRoot);
  const database = ProjectDatabase.create(projectRoot, { name: 'Alias', artBrief: '', tileWidthPx: 32 });
  addApprovedAsset(database, projectRoot);
  const target = path.join(createUnityAssets(parent), 'Delivery');
  mkdirSync(target);
  const targetAlias = path.join(parent, 'delivery-alias');
  symlinkSync(target, targetAlias, 'dir');
  database.setExportTarget('unity', targetAlias);

  const preview = await new UnityExporter().preview(database, {
    integration: 'unity', targetDirectory: target,
  });
  expect(preview.files.some((file) => file.action === 'delete')).toBe(false);
  database.close();
});
