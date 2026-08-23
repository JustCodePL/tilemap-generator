import { expect, it } from 'vitest';
import terrainBlendImporterSource from '../main/unity-package/TerrainBlendImporter.cs?raw';
import terrainBlendBrushSource from '../main/unity-package/TerrainBlendBrush.cs?raw';
import buildingPlacementBrushSource from '../main/unity-package/BuildingPlacementBrush.cs?raw';
import characterDefinitionSource from '../main/unity-package/CharacterDefinition.cs?raw';
import directionalCharacterAnimatorSource from '../main/unity-package/DirectionalCharacterAnimator.cs?raw';

it('mapuje maski blob na osie izometrycznego Gridu Unity', () => {
  expect(terrainBlendImporterSource).toContain('new(1, new Vector3Int(0, 1, 0), 0, 0)');
  expect(terrainBlendImporterSource).toContain('new(4, new Vector3Int(1, 0, 0), 0, 0)');
  expect(terrainBlendImporterSource).toContain('new(16, new Vector3Int(0, -1, 0), 0, 0)');
  expect(terrainBlendImporterSource).toContain('new(64, new Vector3Int(-1, 0, 0), 0, 0)');
  expect(terrainBlendImporterSource).toContain('new(2, new Vector3Int(1, 1, 0), 1, 4)');
  expect(terrainBlendImporterSource).toContain('new(32, new Vector3Int(-1, -1, 0), 16, 64)');
});

it('mapuje drogi top-down na N/E/S/W i tworzy zwykły RuleTile', () => {
  expect(terrainBlendImporterSource).toContain('TopDownRoadNeighbors');
  expect(terrainBlendImporterSource).toContain('new(1, new Vector3Int(0, 1, 0)),  // N');
  expect(terrainBlendImporterSource).toContain('new(2, new Vector3Int(1, 0, 0)),  // E');
  expect(terrainBlendImporterSource).toContain('new(4, new Vector3Int(0, -1, 0)), // S');
  expect(terrainBlendImporterSource).toContain('new(8, new Vector3Int(-1, 0, 0)), // W');
  expect(terrainBlendImporterSource).toContain('return LoadOrCreate<RuleTile>(assetPath, out _)');
  expect(terrainBlendImporterSource).toContain('return LoadOrCreate<IsometricRuleTile>(assetPath, out _)');
});

it('ustawia prostokątny Grid i Palette dla top-down wyłącznie z manifestu v9', () => {
  expect(terrainBlendImporterSource).toContain('manifest.schemaVersion != 9');
  expect(terrainBlendImporterSource).toContain('manifest.project.projection == "top_down"');
  expect(terrainBlendImporterSource).toContain('Guid.TryParse(manifest.project.id, out _)');
  expect(terrainBlendImporterSource).toContain('manifest.tile.pixelsPerUnit <= 0');
  expect(terrainBlendImporterSource).toContain('manifest.managedFiles == null');
  expect(terrainBlendImporterSource).toContain('HasSafeOwnedPaths(manifest)');
  expect(terrainBlendImporterSource).toContain('segment == "." || segment == ".."');
  expect(terrainBlendImporterSource).toContain('managedFiles.Contains(pathValue)');
  expect(terrainBlendImporterSource).toContain('GridLayout.CellLayout.Rectangle');
  expect(terrainBlendImporterSource).toContain('GridLayout.CellLayout.Isometric');
  expect(terrainBlendImporterSource).not.toContain('manifest.schemaVersion >= 7');
});

it('importuje dynamiczny arkusz postaci jako stabilne sprite, klipy, controller i prefab', () => {
  expect(terrainBlendImporterSource).toContain('animation.settings.framesPerDirection < 2');
  expect(terrainBlendImporterSource).toContain('animation.settings.framesPerDirection > 16');
  expect(terrainBlendImporterSource).toContain(
    'animation.sheet.columns != animation.settings.framesPerDirection + 1',
  );
  expect(terrainBlendImporterSource).toContain('animation.sheet.rows != 4');
  expect(terrainBlendImporterSource).toContain('animation.sheet.origin != "top_left"');
  expect(terrainBlendImporterSource).toContain('CharacterSpriteName(direction.Id, "idle", 0)');
  expect(terrainBlendImporterSource).toContain('previousIds.TryGetValue(spriteName');
  expect(terrainBlendImporterSource).toContain('BuildCharacterClip(');
  expect(terrainBlendImporterSource).toContain('Enumerable.Range(0, framesPerDirection)');
  expect(terrainBlendImporterSource).toContain('BuildCharacterController(');
  expect(terrainBlendImporterSource).toContain('BlendTreeType.SimpleDirectional2D');
  expect(terrainBlendImporterSource).toContain('AnimatorConditionMode.If, 0f, "IsMoving"');
  expect(terrainBlendImporterSource).toContain('AnimatorConditionMode.IfNot, 0f, "IsMoving"');
  expect(terrainBlendImporterSource).toContain('DirectionalCharacterAnimator');
  expect(terrainBlendImporterSource).toContain('Character.prefab');
  expect(terrainBlendImporterSource).toContain('var characterDirectory = $"Characters/{asset.id}";');
  expect(terrainBlendImporterSource).toContain('planned.Add($"{characterDirectory}/Clips/idle_{direction.Id}.anim");');
  expect(characterDefinitionSource).toContain('public sealed class CharacterDefinition');
  expect(characterDefinitionSource).toContain('RuntimeAnimatorController');
  expect(directionalCharacterAnimatorSource).toContain('this component never moves');
  expect(directionalCharacterAnimatorSource).toContain('targetAnimator.SetFloat(DirectionY, -value.y)');
});

it('wymaga passed analizy Codexa dla wszystkich kierunków postaci', () => {
  expect(terrainBlendImporterSource).toContain('analysis.status != "passed"');
  expect(terrainBlendImporterSource).toContain('analysis.analyzer.provider != "codex"');
  expect(terrainBlendImporterSource).toContain('result.direction != expectedDirections[index].Id');
  expect(terrainBlendImporterSource).toContain('result.status != "passed"');
});

it('odnajduje manifest integracji Unity w dowolnym katalogu docelowym pod Assets', () => {
  expect(terrainBlendImporterSource).toContain(
    'AssetDatabase.FindAssets("tilemap-assets", new[] { "Assets" })',
  );
  expect(terrainBlendImporterSource).not.toContain(
    'AssetDatabase.FindAssets("tilemap-assets", new[] { "Assets/TilemapGenerator" })',
  );
});

it('synchronizuje wyłącznie oznaczone pliki Generated i czyści inventory po usunięciu manifestu', () => {
  expect(terrainBlendImporterSource).toContain(
    'GeneratedOwnershipFileName = "tilemap-generated-ownership.json"',
  );
  expect(terrainBlendImporterSource).toContain('projectId = projectId');
  expect(terrainBlendImporterSource).toContain('CleanupStaleGeneratedFiles(');
  expect(terrainBlendImporterSource).toContain('DeleteOwnedGeneratedFile(');
  expect(terrainBlendImporterSource).toContain('IsSafeGeneratedRelativePath(relativePath)');
  expect(terrainBlendImporterSource).toContain('AssetDatabase.DeleteAsset(assetPath)');
  expect(terrainBlendImporterSource).toContain('ScheduleDeletedManifestCleanup(deletedManifest)');
  expect(terrainBlendImporterSource).toContain('deletedAssets\n                .Concat(movedFromAssetPaths)');
  expect(terrainBlendImporterSource).toContain('if (desiredFiles.Contains(relativePath)) continue;');
  expect(terrainBlendImporterSource).toContain('if (!created) return asset;');
  expect(terrainBlendImporterSource).toContain(
    'inventory {ownershipPath} nie potwierdza własności bieżącego manifestu',
  );
  const provisionalInventory = terrainBlendImporterSource.indexOf(
    'WriteGeneratedOwnership(\n                generatedRoot,',
  );
  const firstGeneratedDirectory = terrainBlendImporterSource.indexOf('EnsureFolder(terrainRoot);');
  expect(provisionalInventory).toBeGreaterThan(0);
  expect(provisionalInventory).toBeLessThan(firstGeneratedDirectory);
});

it('zachowuje Generated przy atomowej podmianie lub przywróceniu manifestu', () => {
  const deletedCleanup = terrainBlendImporterSource.slice(
    terrainBlendImporterSource.indexOf('internal static void CleanupDeletedManifest('),
    terrainBlendImporterSource.indexOf('private static void CleanupOrphanGeneratedOwnership('),
  );
  expect(deletedCleanup).toContain(
    'if (File.Exists(manifestPath) || AssetDatabase.AssetPathExists(manifestPath)) return;',
  );
  expect(deletedCleanup.indexOf('File.Exists(manifestPath)')).toBeLessThan(
    deletedCleanup.indexOf('TryReadGeneratedOwnership('),
  );

  const orphanCleanup = terrainBlendImporterSource.slice(
    terrainBlendImporterSource.indexOf('private static void CleanupOrphanGeneratedOwnership('),
    terrainBlendImporterSource.indexOf('private static void BuildManifest('),
  );
  expect(orphanCleanup).toContain('AssetDatabase.FindAssets(');
  expect(orphanCleanup).toContain('File.Exists(ownership.manifestPath)');
  expect(orphanCleanup).toContain('AssetDatabase.AssetPathExists(ownership.manifestPath)');
  expect(orphanCleanup.indexOf('File.Exists(ownership.manifestPath)')).toBeLessThan(
    orphanCleanup.indexOf('CleanupGeneratedOwnership('),
  );
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

it('rysuje prostokątny podgląd komórki i footprintu na Gridzie top-down', () => {
  for (const source of [terrainBlendBrushSource, buildingPlacementBrushSource]) {
    expect(source).toContain('gridLayout.cellLayout == GridLayout.CellLayout.Rectangle');
    expect(source).toContain('center - right - up');
    expect(source).toContain('center + right + up');
  }
});

it('czy\u015bci wybrany teren po wskazaniu pustej kom\u00f3rki palety', () => {
  expect(terrainBlendBrushSource).toContain('SelectTerrain(pickedTerrain);');
  expect(terrainBlendBrushSource).toContain('if (pickedTerrain == terrain) return;');
  expect(terrainBlendBrushSource).not.toContain(
    'if (pickedTerrain == null || pickedTerrain == terrain) return;',
  );
});
