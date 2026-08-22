import { expect, it } from 'vitest';
import terrainBlendImporterSource from '../main/unity-package/TerrainBlendImporter.cs?raw';
import terrainBlendBrushSource from '../main/unity-package/TerrainBlendBrush.cs?raw';

it('mapuje maski blob na osie izometrycznego Gridu Unity', () => {
  expect(terrainBlendImporterSource).toContain('new(1, new Vector3Int(0, 1, 0), 0, 0)');
  expect(terrainBlendImporterSource).toContain('new(4, new Vector3Int(1, 0, 0), 0, 0)');
  expect(terrainBlendImporterSource).toContain('new(16, new Vector3Int(0, -1, 0), 0, 0)');
  expect(terrainBlendImporterSource).toContain('new(64, new Vector3Int(-1, 0, 0), 0, 0)');
  expect(terrainBlendImporterSource).toContain('new(2, new Vector3Int(1, 1, 0), 1, 4)');
  expect(terrainBlendImporterSource).toContain('new(32, new Vector3Int(-1, -1, 0), 16, 64)');
});

it('renderuje budynki ponad wygenerowanymi warstwami terenu i dróg', () => {
  expect(terrainBlendImporterSource).toContain('renderer.sortingOrder = 200;');
});

it('wymusza custom pivot dla pojedynczych sprite\u00f3w terenu i \u015bcian', () => {
  expect(terrainBlendImporterSource).toContain(
    'settings.spriteAlignment = (int)SpriteAlignment.Custom;',
  );
  expect(terrainBlendImporterSource.match(/ConfigureSingleSpritePivot\(importer, pivot\);/g)).toHaveLength(2);
});

it('pokazuje ghost i romb docelowy podczas malowania terenu', () => {
  expect(terrainBlendBrushSource).toContain('public override void OnPaintSceneGUI(');
  expect(terrainBlendBrushSource).toContain('ShowPreview(map, origin);');
  expect(terrainBlendBrushSource).toContain('DrawCellPreview(gridLayout, origin, true);');
  expect(terrainBlendBrushSource).toContain('new GameObject("Terrain Placement Preview"');
});

it('czy\u015bci wybrany teren po wskazaniu pustej kom\u00f3rki palety', () => {
  expect(terrainBlendBrushSource).toContain('SelectTerrain(pickedTerrain);');
  expect(terrainBlendBrushSource).toContain('if (pickedTerrain == terrain) return;');
  expect(terrainBlendBrushSource).not.toContain(
    'if (pickedTerrain == null || pickedTerrain == terrain) return;',
  );
});
