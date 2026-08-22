import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { ProjectDatabase } from '../main/db/project-database';
import { UnityExporter } from '../main/services/unity-exporter';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

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

  const unityAssets = path.join(parent, 'UnityProject', 'Assets'); mkdirSync(unityAssets, { recursive: true });
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { targetAssetsDirectory: unityAssets }, () => true);
  expect(path.dirname(preview.files[0].destinationPath)).toBe(path.join(unityAssets, 'TilemapGenerator', 'vegetation'));
  expect(preview.files[0].destinationPath).not.toContain(`${path.sep}Las${path.sep}`);
  expect(preview.files[0].destinationPath).not.toContain(`${path.sep}Sprites${path.sep}`);
  expect(preview.manifestPath).toBe(path.join(unityAssets, 'TilemapGenerator', 'tilemap-assets.json'));
  const metaPath = `${preview.files[0].destinationPath}.meta`;
  mkdirSync(path.dirname(metaPath), { recursive: true });
  writeFileSync(metaPath, 'guid: keep-me', 'utf8');
  const result = exporter.run(database, preview.token);

  expect(result.exported).toBe(1);
  expect(existsSync(preview.files[0].destinationPath)).toBe(true);
  expect(readFileSync(metaPath, 'utf8')).toBe('guid: keep-me');
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
    assets: Array<{ elevationLevels: number; relativeSize: { width: number; height: number }; expectedCanvasPx: null }>;
    tile: { widthPx: number; heightPx: number };
  };
  expect(manifest.assets).toHaveLength(1);
  expect(manifest.tile.widthPx).toBe(256);
  expect(manifest.tile.heightPx).toBe(128);
  expect(manifest.assets[0].elevationLevels).toBe(0);
  expect(manifest.assets[0].relativeSize).toEqual({ width: 1, height: 1 });
  expect(manifest.assets[0].expectedCanvasPx).toBeNull();
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

  const unityAssets = path.join(parent, 'UnityProject', 'Assets'); mkdirSync(unityAssets, { recursive: true });
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { targetAssetsDirectory: unityAssets }, () => true);
  expect(preview.files).toHaveLength(16);
  expect(preview.files[0].role).toBe('asset');
  expect(preview.files.slice(1).every((file) => file.role === 'unity_support')).toBe(true);
  const result = exporter.run(database, preview.token);
  expect(result.exported).toBe(16);

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
  const runtimeMap = path.join(unityAssets, 'TilemapGenerator', 'Runtime', 'BuildingMap.cs');
  const editorBrush = path.join(unityAssets, 'TilemapGenerator', 'Editor', 'BuildingPlacementBrush.cs');
  const importer = path.join(unityAssets, 'TilemapGenerator', 'Editor', 'TerrainBlendImporter.cs');
  expect(readFileSync(runtimeMap, 'utf8')).toContain('public sealed class BuildingMap');
  const editorBrushSource = readFileSync(editorBrush, 'utf8');
  expect(editorBrushSource).toContain('Building Placement Brush');
  expect(editorBrushSource).toContain('map.CanPlace');
  expect(editorBrushSource).toContain('paletteTilemap.GetTile');
  expect(editorBrushSource).not.toContain('EditorGUILayout.Popup("Building"');
  expect(editorBrushSource).not.toContain('AssetPreview.GetAssetPreview');
  expect(editorBrushSource).not.toContain('DrawTextureTransparent');
  const terrainBrush = path.join(unityAssets, 'TilemapGenerator', 'Editor', 'TerrainBlendBrush.cs');
  const terrainBrushSource = readFileSync(terrainBrush, 'utf8');
  expect(terrainBrushSource).not.toContain('LabelField("Terrain"');
  expect(terrainBrushSource).not.toContain('LabelField("Priority"');
  expect(terrainBrushSource).not.toContain('LabelField("Type"');
  expect(readFileSync(importer, 'utf8')).toContain('PrefabUtility.SaveAsPrefabAsset');
  expect(readFileSync(importer, 'utf8')).toContain('renderer.sortingOrder = 200');
  expect(readFileSync(importer, 'utf8')).toContain('GridPaletteUtility.CreateNewPalette');
  const definitionSource = path.join(unityAssets, 'TilemapGenerator', 'Runtime', 'BuildingDefinition.cs');
  expect(readFileSync(definitionSource, 'utf8')).toContain('UnityEngine.Tilemaps.Tile');
  database.close();
});

it('eksportuje 16 wariantów road tile do manifestu v6 z provenance', async () => {
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

  const unityAssets = path.join(parent, 'UnityProject', 'Assets'); mkdirSync(unityAssets, { recursive: true });
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { targetAssetsDirectory: unityAssets }, () => true);
  expect(preview.files).toHaveLength(31);
  expect(preview.files.slice(0, 16).map((file) => file.variantMask)).toEqual(Array.from({ length: 16 }, (_, mask) => mask));
  expect(preview.files.slice(16).every((file) => file.role === 'unity_support')).toBe(true);
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
  expect(result.exported).toBe(31);
  expect(manifest.schemaVersion).toBe(6);
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
  const importer = path.join(unityAssets, 'TilemapGenerator', 'Editor', 'TerrainBlendImporter.cs');
  const importerSource = readFileSync(importer, 'utf8');
  expect(importerSource).toContain('RoadRuleTile.asset');
  expect(importerSource).toContain('new(1, new Vector3Int(-1, 0, 0))');
  expect(importerSource).toContain('CreateTilemap(root.transform, "Roads", 100)');
  database.close();
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

  const unityAssets = path.join(parent, 'UnityProject', 'Assets'); mkdirSync(unityAssets, { recursive: true });
  const exporter = new UnityExporter();
  const preview = await exporter.preview(database, { targetAssetsDirectory: unityAssets }, () => true);
  expect(preview.files).toHaveLength(18);
  expect(preview.files.map((file) => file.role)).toEqual([
    'asset', 'terrain_blend_atlas', 'terrain_wall',
    ...Array.from({ length: 15 }, () => 'unity_support'),
  ]);
  const result = exporter.run(database, preview.token);
  expect(result.exported).toBe(18);

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
  expect(manifest.schemaVersion).toBe(6);
  expect(manifest.assets[0].terrainBlend).toMatchObject({
    mode: 'blob47_top_overlay',
    pivotNormalized: { x: 0.5, y: 0.75 },
  });
  expect(manifest.assets[0].terrainBlend.variants).toHaveLength(47);
  expect(manifest.assets[0].terrainBlend.atlasFile).toMatch(/elevated_tile\/aka--[a-f0-9]{8}--blend\.png$/);
  expect(manifest.assets[0].terrainBlend.wallFile).toMatch(/elevated_tile\/aka--[a-f0-9]{8}--walls\.png$/);
  database.close();
});
