using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEditor.Tilemaps;
using UnityEditor.U2D.Sprites;
using UnityEngine;
using UnityEngine.Tilemaps;
using TilemapGenerator.Buildings;

namespace TilemapGenerator.TerrainBlend.Editor
{
    [InitializeOnLoad]
    public static class TerrainBlendImporter
    {
        private const string ManifestFileName = "tilemap-assets.json";
        private const string GeneratedOwnershipFileName = "tilemap-generated-ownership.json";
        private const int GeneratedOwnershipSchemaVersion = 1;
        private static bool rebuildScheduled;
        private static readonly HashSet<string> PendingDeletedManifestPaths = new(StringComparer.Ordinal);
        private static readonly HashSet<string> FixedGeneratedFiles = new(StringComparer.Ordinal)
        {
            "TerrainBlendSet.asset",
            "BuildingSet.asset",
            "TerrainBlendSupportTile.asset",
            "Prefabs/TerrainGrid.prefab",
        };
        private static readonly HashSet<string> TerrainGeneratedFileNames = new(StringComparer.Ordinal)
        {
            "BaseTile.asset",
            "WallTile.asset",
            "BlendRuleTile.asset",
            "TerrainDefinition.asset",
        };
        private static readonly HashSet<string> BuildingGeneratedFileNames = new(StringComparer.Ordinal)
        {
            "BuildingDefinition.asset",
            "Building.prefab",
        };

        private static readonly NeighborSpec[] Neighbors =
        {
            new(1, new Vector3Int(0, 1, 0), 0, 0),
            new(2, new Vector3Int(1, 1, 0), 1, 4),
            new(4, new Vector3Int(1, 0, 0), 0, 0),
            new(8, new Vector3Int(1, -1, 0), 4, 16),
            new(16, new Vector3Int(0, -1, 0), 0, 0),
            new(32, new Vector3Int(-1, -1, 0), 16, 64),
            new(64, new Vector3Int(-1, 0, 0), 0, 0),
            new(128, new Vector3Int(-1, 1, 0), 64, 1),
        };

        private static readonly RoadNeighborSpec[] IsometricRoadNeighbors =
        {
            // Isometric Grid cell axes mapped to the visual diamond edges.
            new(1, new Vector3Int(-1, 0, 0)), // NW
            new(2, new Vector3Int(0, -1, 0)), // NE
            new(4, new Vector3Int(1, 0, 0)),  // SE
            new(8, new Vector3Int(0, 1, 0)),  // SW
        };

        private static readonly RoadNeighborSpec[] TopDownRoadNeighbors =
        {
            new(1, new Vector3Int(0, 1, 0)),  // N
            new(2, new Vector3Int(1, 0, 0)),  // E
            new(4, new Vector3Int(0, -1, 0)), // S
            new(8, new Vector3Int(-1, 0, 0)), // W
        };

        static TerrainBlendImporter()
        {
            ScheduleRebuild();
        }

        [MenuItem("Tools/Tilemap Generator/Rebuild Generated Assets")]
        public static void RebuildAll()
        {
            rebuildScheduled = false;
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
            {
                ScheduleRebuild();
                return;
            }

            var deletedManifestPaths = PendingDeletedManifestPaths.ToArray();
            PendingDeletedManifestPaths.Clear();
            foreach (var deletedManifestPath in deletedManifestPaths)
            {
                CleanupDeletedManifest(deletedManifestPath);
            }
            CleanupOrphanGeneratedOwnership();

            // The Unity integration may be exported to any chosen directory
            // below Assets, so discover manifests across the whole project.
            var manifestGuids = AssetDatabase.FindAssets("tilemap-assets", new[] { "Assets" });
            foreach (var guid in manifestGuids)
            {
                var manifestPath = AssetDatabase.GUIDToAssetPath(guid);
                if (Path.GetFileName(manifestPath) != ManifestFileName) continue;
                BuildManifest(manifestPath);
            }
        }

        internal static void ScheduleRebuild()
        {
            if (rebuildScheduled) return;
            rebuildScheduled = true;
            EditorApplication.delayCall += RebuildAll;
        }

        internal static void ScheduleDeletedManifestCleanup(string deletedManifestPath)
        {
            PendingDeletedManifestPaths.Add(NormalizeAssetPath(deletedManifestPath));
            ScheduleRebuild();
        }

        internal static void CleanupDeletedManifest(string deletedManifestPath)
        {
            var manifestPath = NormalizeAssetPath(deletedManifestPath);
            if (!IsSafeManifestAssetPath(manifestPath)) return;
            // A failed external export can remove and restore the manifest before
            // this delayed cleanup runs. In that case the delivery is still live.
            if (File.Exists(manifestPath) || AssetDatabase.AssetPathExists(manifestPath)) return;
            var exportRoot = NormalizeAssetPath(Path.GetDirectoryName(manifestPath) ?? "Assets");
            var generatedRoot = $"{exportRoot}/Generated";
            var ownershipPath = $"{generatedRoot}/{GeneratedOwnershipFileName}";
            if (!TryReadGeneratedOwnership(
                generatedRoot,
                ownershipPath,
                manifestPath,
                null,
                out var ownership)
                || ownership == null) return;
            CleanupGeneratedOwnership(
                generatedRoot,
                ownershipPath,
                manifestPath,
                ownership.projectId,
                ownership);
            AssetDatabase.SaveAssets();
        }

        private static void CleanupOrphanGeneratedOwnership()
        {
            var changed = false;
            var ownershipGuids = AssetDatabase.FindAssets(
                "tilemap-generated-ownership",
                new[] { "Assets" });
            foreach (var guid in ownershipGuids)
            {
                var ownershipPath = NormalizeAssetPath(AssetDatabase.GUIDToAssetPath(guid));
                if (Path.GetFileName(ownershipPath) != GeneratedOwnershipFileName) continue;
                var generatedRoot = NormalizeAssetPath(Path.GetDirectoryName(ownershipPath) ?? "Assets");
                if (!TryReadGeneratedOwnership(
                    generatedRoot,
                    ownershipPath,
                    null,
                    null,
                    out var ownership)
                    || ownership == null) continue;
                // The manifest can disappear only briefly during an atomic external
                // replacement or rollback. Delayed cleanup must preserve its Generated
                // assets (and their Unity GUIDs) once the exact path exists again.
                if (File.Exists(ownership.manifestPath)
                    || AssetDatabase.AssetPathExists(ownership.manifestPath)) continue;
                CleanupGeneratedOwnership(
                    generatedRoot,
                    ownershipPath,
                    ownership.manifestPath,
                    ownership.projectId,
                    ownership);
                changed = true;
            }
            if (changed) AssetDatabase.SaveAssets();
        }

        private static void BuildManifest(string manifestPath)
        {
            var textAsset = AssetDatabase.LoadAssetAtPath<TextAsset>(manifestPath);
            if (textAsset == null) return;
            var manifest = JsonUtility.FromJson<ExportManifest>(textAsset.text);
            if (manifest == null
                || manifest.schemaVersion != 8
                || manifest.project == null
                || !Guid.TryParse(manifest.project.id, out _)
                || (manifest.project.projection != "isometric"
                    && manifest.project.projection != "top_down")
                || manifest.tile == null
                || manifest.tile.widthPx <= 0
                || manifest.tile.heightPx <= 0
                || manifest.tile.pixelsPerUnit <= 0
                || manifest.managedFiles == null
                || manifest.assets == null
                || !HasSafeOwnedPaths(manifest)) return;
            var isTopDown = manifest.project.projection == "top_down";

            var exportRoot = NormalizeAssetPath(Path.GetDirectoryName(manifestPath) ?? "Assets");
            var generatedRoot = $"{exportRoot}/Generated";
            var terrainRoot = $"{generatedRoot}/Terrains";
            var buildingRoot = $"{generatedRoot}/Buildings";
            var roadRoot = $"{generatedRoot}/Roads";
            var ownershipPath = $"{generatedRoot}/{GeneratedOwnershipFileName}";
            if (!TryReadGeneratedOwnership(
                generatedRoot,
                ownershipPath,
                manifestPath,
                manifest.project.id,
                out var existingOwnership)) return;
            var desiredGeneratedFiles = PlannedGeneratedFiles(manifest);
            if (desiredGeneratedFiles.Count == 0)
            {
                CleanupGeneratedOwnership(
                    generatedRoot,
                    ownershipPath,
                    manifestPath,
                    manifest.project.id,
                    existingOwnership);
                return;
            }
            var provisionalOwnership = new HashSet<string>(desiredGeneratedFiles, StringComparer.Ordinal);
            if (existingOwnership != null) provisionalOwnership.UnionWith(existingOwnership.managedFiles);
            WriteGeneratedOwnership(
                generatedRoot,
                ownershipPath,
                manifestPath,
                manifest.project.id,
                provisionalOwnership);
            EnsureFolder(terrainRoot);
            EnsureFolder(buildingRoot);
            EnsureFolder(roadRoot);

            var terrainDefinitions = new List<TerrainBlendDefinition>();
            var buildingDefinitions = new List<BuildingDefinition>();
            var roadTiles = new List<RuleTile>();
            foreach (var asset in manifest.assets)
            {
                if (asset.terrainBlend != null
                    && !string.IsNullOrWhiteSpace(asset.file)
                    && !string.IsNullOrWhiteSpace(asset.terrainBlend.atlasFile)
                    && !string.IsNullOrWhiteSpace(asset.terrainBlend.wallFile))
                {
                    var terrainDefinition = BuildTerrain(exportRoot, terrainRoot, manifest.tile, asset);
                    if (terrainDefinition == null)
                    {
                        Debug.LogError($"Tilemap Generator: nie udało się zbudować terenu {asset.id}.");
                        return;
                    }
                    terrainDefinitions.Add(terrainDefinition);
                }

                if (asset.category == "building" && !string.IsNullOrWhiteSpace(asset.file))
                {
                    var buildingDefinition = BuildBuilding(exportRoot, buildingRoot, manifest.tile, asset);
                    if (buildingDefinition == null)
                    {
                        Debug.LogError($"Tilemap Generator: nie udało się zbudować budynku {asset.id}.");
                        return;
                    }
                    buildingDefinitions.Add(buildingDefinition);
                }

                if (asset.category == "road_tile" && asset.roadVariants?.Length == 16)
                {
                    var roadTile = BuildRoad(exportRoot, roadRoot, manifest.tile, asset, isTopDown);
                    if (roadTile == null)
                    {
                        Debug.LogError($"Tilemap Generator: nie udało się zbudować drogi {asset.id}.");
                        return;
                    }
                    roadTiles.Add(roadTile);
                }
            }

            var setPath = $"{generatedRoot}/TerrainBlendSet.asset";
            var terrainSet = LoadOrCreate<TerrainBlendSet>(setPath, out _);
            terrainSet.ConfigureGenerated(terrainDefinitions);
            EditorUtility.SetDirty(terrainSet);
            var buildingSetPath = $"{generatedRoot}/BuildingSet.asset";
            var buildingSet = LoadOrCreate<BuildingSet>(buildingSetPath, out _);
            buildingSet.ConfigureGenerated(buildingDefinitions);
            EditorUtility.SetDirty(buildingSet);
            BuildBuildingPalette(generatedRoot, manifest.tile, buildingDefinitions, isTopDown);
            var supportTilePath = $"{generatedRoot}/TerrainBlendSupportTile.asset";
            var supportTile = LoadOrCreate<TerrainBlendSupportTile>(supportTilePath, out _);
            supportTile.name = "TerrainBlendSupportTile";
            supportTile.sprite = null;
            supportTile.colliderType = Tile.ColliderType.None;
            EditorUtility.SetDirty(supportTile);
            BuildGridPrefab(
                generatedRoot,
                manifest.tile,
                terrainSet,
                supportTile,
                buildingSet,
                roadTiles.Count > 0,
                isTopDown);
            AssetDatabase.SaveAssets();
            if (desiredGeneratedFiles.Any(relativePath => (
                !AssetDatabase.AssetPathExists($"{generatedRoot}/{relativePath}")
            )))
            {
                Debug.LogError("Tilemap Generator: nie utworzono kompletnego zestawu plików Generated; zachowano poprzedni inventory.");
                return;
            }
            var retainedOwnership = CleanupStaleGeneratedFiles(
                generatedRoot,
                existingOwnership,
                desiredGeneratedFiles);
            WriteGeneratedOwnership(
                generatedRoot,
                ownershipPath,
                manifestPath,
                manifest.project.id,
                retainedOwnership);
            RefreshLoadedMaps(terrainSet);
            RefreshLoadedBuildingMaps(buildingSet);
        }

        private static TerrainBlendDefinition BuildTerrain(
            string exportRoot,
            string terrainRoot,
            TileSettings tileSettings,
            TerrainAsset terrain)
        {
            var baseTexturePath = ResolveAssetPath(exportRoot, terrain.file);
            var atlasTexturePath = ResolveAssetPath(exportRoot, terrain.terrainBlend.atlasFile);
            var wallTexturePath = ResolveAssetPath(exportRoot, terrain.terrainBlend.wallFile);
            if (AssetImporter.GetAtPath(baseTexturePath) is not TextureImporter) return null;
            if (AssetImporter.GetAtPath(atlasTexturePath) is not TextureImporter) return null;
            if (AssetImporter.GetAtPath(wallTexturePath) is not TextureImporter) return null;

            var pivot = new Vector2(terrain.terrainBlend.pivotNormalized.x, terrain.terrainBlend.pivotNormalized.y);
            ConfigureBaseTexture(baseTexturePath, tileSettings.pixelsPerUnit, pivot);
            ConfigureBlendAtlas(atlasTexturePath, tileSettings.pixelsPerUnit, terrain.terrainBlend);
            ConfigureWallTexture(wallTexturePath, tileSettings.pixelsPerUnit, pivot);

            var baseSprite = AssetDatabase.LoadAssetAtPath<Sprite>(baseTexturePath);
            var wallSprite = AssetDatabase.LoadAssetAtPath<Sprite>(wallTexturePath);
            var sprites = AssetDatabase.LoadAllAssetsAtPath(atlasTexturePath)
                .OfType<Sprite>()
                .ToDictionary(sprite => sprite.name, sprite => sprite, StringComparer.Ordinal);
            if (baseSprite == null || wallSprite == null || sprites.Count == 0) return null;

            var assetDirectory = $"{terrainRoot}/{terrain.id}";
            EnsureFolder(assetDirectory);
            var baseTilePath = $"{assetDirectory}/BaseTile.asset";
            var baseTile = LoadOrCreate<Tile>(baseTilePath, out _);
            baseTile.sprite = baseSprite;
            baseTile.colliderType = Tile.ColliderType.Sprite;
            baseTile.name = "BaseTile";
            EditorUtility.SetDirty(baseTile);

            var wallTilePath = $"{assetDirectory}/WallTile.asset";
            var wallTile = LoadOrCreate<Tile>(wallTilePath, out _);
            wallTile.sprite = wallSprite;
            wallTile.colliderType = Tile.ColliderType.None;
            wallTile.name = "WallTile";
            EditorUtility.SetDirty(wallTile);

            var ruleTilePath = $"{assetDirectory}/BlendRuleTile.asset";
            var ruleTile = LoadOrCreate<TerrainBlendRuleTile>(ruleTilePath, out _);
            ConfigureRuleTile(ruleTile, terrain.terrainBlend, sprites);
            EditorUtility.SetDirty(ruleTile);

            var definitionPath = $"{assetDirectory}/TerrainDefinition.asset";
            var definition = LoadOrCreate<TerrainBlendDefinition>(definitionPath, out var definitionCreated);
            definition.ConfigureGenerated(
                terrain.id,
                terrain.versionId,
                terrain.name,
                terrain.category == "elevated_tile",
                terrain.elevationLevels,
                baseTile,
                wallTile,
                ruleTile,
                DefaultPriority(terrain.tags),
                definitionCreated);
            definition.name = "TerrainDefinition";
            EditorUtility.SetDirty(definition);
            return definition;
        }

        private static BuildingDefinition BuildBuilding(
            string exportRoot,
            string buildingRoot,
            TileSettings tileSettings,
            TerrainAsset building)
        {
            var texturePath = ResolveAssetPath(exportRoot, building.file);
            if (AssetImporter.GetAtPath(texturePath) is not TextureImporter) return null;

            var pivotData = building.pivotNormalized;
            var pivot = pivotData == null
                ? new Vector2(0.5f, 0f)
                : new Vector2(pivotData.x, pivotData.y);
            ConfigureBaseTexture(texturePath, tileSettings.pixelsPerUnit, pivot);
            var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(texturePath);
            if (sprite == null) return null;

            var assetDirectory = $"{buildingRoot}/{building.id}";
            EnsureFolder(assetDirectory);
            var definitionPath = $"{assetDirectory}/BuildingDefinition.asset";
            var definition = LoadOrCreate<BuildingDefinition>(definitionPath, out _);
            var footprint = building.footprintCells == null
                ? Vector2Int.one
                : new Vector2Int(building.footprintCells.x, building.footprintCells.y);
            definition.ConfigureGenerated(
                building.id,
                building.versionId,
                building.name,
                footprint,
                pivot,
                sprite);
            definition.name = "BuildingDefinition";
            EditorUtility.SetDirty(definition);

            var prefabRoot = new GameObject(building.name, typeof(SpriteRenderer), typeof(BuildingInstance));
            try
            {
                var renderer = prefabRoot.GetComponent<SpriteRenderer>();
                renderer.sprite = sprite;
                renderer.spriteSortPoint = SpriteSortPoint.Pivot;
                renderer.sortingOrder = 200;
                var instance = prefabRoot.GetComponent<BuildingInstance>();
                instance.ConfigureGenerated(definition);
                var prefabPath = $"{assetDirectory}/Building.prefab";
                var prefab = PrefabUtility.SaveAsPrefabAsset(prefabRoot, prefabPath);
                definition.SetGeneratedPrefab(prefab);
                EditorUtility.SetDirty(definition);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(prefabRoot);
            }
            return definition;
        }

        private static void BuildBuildingPalette(
            string generatedRoot,
            TileSettings tile,
            IReadOnlyList<BuildingDefinition> buildings,
            bool isTopDown)
        {
            var paletteRoot = $"{generatedRoot}/Palettes";
            var palettePath = $"{paletteRoot}/Buildings.prefab";
            if (buildings.Count == 0) return;
            EnsureFolder(paletteRoot);

            if (!AssetDatabase.AssetPathExists(palettePath))
            {
                GridPaletteUtility.CreateNewPalette(
                    paletteRoot,
                    "Buildings",
                    isTopDown ? GridLayout.CellLayout.Rectangle : GridLayout.CellLayout.Isometric,
                    GridPalette.CellSizing.Manual,
                    new Vector3(
                        tile.widthPx / (float)tile.pixelsPerUnit,
                        tile.heightPx / (float)tile.pixelsPerUnit,
                        1f),
                    GridLayout.CellSwizzle.XYZ);
            }
            if (!AssetDatabase.AssetPathExists(palettePath)) return;

            var paletteContents = PrefabUtility.LoadPrefabContents(palettePath);
            try
            {
                var grid = paletteContents.GetComponentInChildren<Grid>();
                if (grid != null)
                {
                    grid.cellLayout = isTopDown
                        ? GridLayout.CellLayout.Rectangle
                        : GridLayout.CellLayout.Isometric;
                    grid.cellSize = new Vector3(
                        tile.widthPx / (float)tile.pixelsPerUnit,
                        tile.heightPx / (float)tile.pixelsPerUnit,
                        1f);
                }
                var tilemap = paletteContents.GetComponentInChildren<Tilemap>();
                if (tilemap == null) return;
                tilemap.ClearAllTiles();
                const int columns = 4;
                for (var index = 0; index < buildings.Count; index += 1)
                {
                    var position = new Vector3Int(index % columns, -(index / columns), 0);
                    tilemap.SetTile(position, buildings[index]);
                }
                PrefabUtility.SaveAsPrefabAsset(paletteContents, palettePath);
            }
            finally
            {
                PrefabUtility.UnloadPrefabContents(paletteContents);
            }
        }

        private static RuleTile BuildRoad(
            string exportRoot,
            string roadRoot,
            TileSettings tileSettings,
            TerrainAsset road,
            bool isTopDown)
        {
            var sprites = new Dictionary<int, Sprite>();
            var pivotData = road.pivotNormalized;
            var pivot = pivotData == null
                ? new Vector2(0.5f, 0.5f)
                : new Vector2(pivotData.x, pivotData.y);

            foreach (var variant in road.roadVariants.OrderBy(item => item.mask))
            {
                if (variant.mask < 0 || variant.mask > 15 || string.IsNullOrWhiteSpace(variant.file)) return null;
                var texturePath = ResolveAssetPath(exportRoot, variant.file);
                if (AssetImporter.GetAtPath(texturePath) is not TextureImporter) return null;
                ConfigureBaseTexture(texturePath, tileSettings.pixelsPerUnit, pivot);
                var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(texturePath);
                if (sprite == null || !sprites.TryAdd(variant.mask, sprite)) return null;
            }
            if (sprites.Count != 16) return null;

            var assetDirectory = $"{roadRoot}/{road.id}";
            EnsureFolder(assetDirectory);
            var ruleTilePath = $"{assetDirectory}/RoadRuleTile.asset";
            var ruleTile = LoadOrCreateRoadRuleTile(ruleTilePath, isTopDown);
            ConfigureRoadRuleTile(
                ruleTile,
                sprites,
                isTopDown ? TopDownRoadNeighbors : IsometricRoadNeighbors);
            ruleTile.name = string.IsNullOrWhiteSpace(road.name) ? "RoadRuleTile" : road.name;
            EditorUtility.SetDirty(ruleTile);
            return ruleTile;
        }

        private static void ConfigureRoadRuleTile(
            RuleTile ruleTile,
            IReadOnlyDictionary<int, Sprite> sprites,
            IReadOnlyList<RoadNeighborSpec> roadNeighbors)
        {
            ruleTile.m_DefaultSprite = sprites[0];
            ruleTile.m_DefaultColliderType = Tile.ColliderType.None;
            ruleTile.m_TilingRules.Clear();

            foreach (var pair in sprites.OrderBy(item => item.Key))
            {
                var rule = new RuleTile.TilingRule
                {
                    m_Output = RuleTile.TilingRuleOutput.OutputSprite.Single,
                    m_Sprites = new[] { pair.Value },
                    m_ColliderType = Tile.ColliderType.None,
                    m_RuleTransform = RuleTile.TilingRuleOutput.Transform.Fixed,
                };
                rule.m_Neighbors.Clear();
                rule.m_NeighborPositions.Clear();
                foreach (var neighbor in roadNeighbors)
                {
                    rule.m_NeighborPositions.Add(neighbor.Position);
                    rule.m_Neighbors.Add((pair.Key & neighbor.Bit) != 0
                        ? RuleTile.TilingRuleOutput.Neighbor.This
                        : RuleTile.TilingRuleOutput.Neighbor.NotThis);
                }
                ruleTile.m_TilingRules.Add(rule);
            }
        }

        private static void ConfigureRuleTile(
            TerrainBlendRuleTile ruleTile,
            TerrainBlendData blend,
            IReadOnlyDictionary<string, Sprite> sprites)
        {
            ruleTile.name = "BlendRuleTile";
            ruleTile.m_DefaultColliderType = Tile.ColliderType.None;
            ruleTile.m_TilingRules.Clear();

            foreach (var variant in blend.variants.OrderBy(item => item.mask))
            {
                if (!sprites.TryGetValue(variant.spriteName, out var sprite)) continue;
                var rule = new RuleTile.TilingRule
                {
                    m_Output = RuleTile.TilingRuleOutput.OutputSprite.Single,
                    m_Sprites = new[] { sprite },
                    m_ColliderType = Tile.ColliderType.None,
                    m_RuleTransform = RuleTile.TilingRuleOutput.Transform.Fixed,
                };
                rule.m_Neighbors.Clear();
                rule.m_NeighborPositions.Clear();
                foreach (var neighbor in Neighbors)
                {
                    if (neighbor.IsCorner && !neighbor.AdjacentEdgesPresent(variant.mask)) continue;
                    rule.m_NeighborPositions.Add(neighbor.Position);
                    rule.m_Neighbors.Add((variant.mask & neighbor.Bit) != 0
                        ? RuleTile.TilingRuleOutput.Neighbor.This
                        : RuleTile.TilingRuleOutput.Neighbor.NotThis);
                }
                ruleTile.m_TilingRules.Add(rule);
            }

            var defaultVariant = blend.variants.FirstOrDefault(item => item.mask == 0);
            ruleTile.m_DefaultSprite = defaultVariant != null
                && sprites.TryGetValue(defaultVariant.spriteName, out var defaultSprite)
                    ? defaultSprite
                    : sprites.Values.FirstOrDefault();
        }

        private static void ConfigureBaseTexture(string assetPath, float pixelsPerUnit, Vector2 pivot)
        {
            var importer = (TextureImporter)AssetImporter.GetAtPath(assetPath);
            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.spritePixelsPerUnit = pixelsPerUnit;
            ConfigureSingleSpritePivot(importer, pivot);
            importer.mipmapEnabled = false;
            importer.alphaIsTransparency = true;
            importer.textureCompression = TextureImporterCompression.Uncompressed;
            importer.filterMode = FilterMode.Point;
            importer.wrapMode = TextureWrapMode.Clamp;
            importer.SaveAndReimport();
        }

        private static void ConfigureSingleSpritePivot(TextureImporter importer, Vector2 pivot)
        {
            var settings = new TextureImporterSettings();
            importer.ReadTextureSettings(settings);
            settings.spriteAlignment = (int)SpriteAlignment.Custom;
            settings.spritePivot = pivot;
            importer.SetTextureSettings(settings);
        }

        private static void ConfigureBlendAtlas(string assetPath, float pixelsPerUnit, TerrainBlendData blend)
        {
            var importer = (TextureImporter)AssetImporter.GetAtPath(assetPath);
            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Multiple;
            importer.spritePixelsPerUnit = pixelsPerUnit;
            importer.mipmapEnabled = false;
            importer.alphaIsTransparency = true;
            importer.textureCompression = TextureImporterCompression.Uncompressed;
            importer.filterMode = FilterMode.Point;
            importer.wrapMode = TextureWrapMode.Clamp;
            importer.SaveAndReimport();

            var factories = new SpriteDataProviderFactories();
            factories.Init();
            var dataProvider = factories.GetSpriteEditorDataProviderFromObject(importer);
            dataProvider.InitSpriteEditorDataProvider();
            var previousIds = dataProvider.GetSpriteRects()
                .ToDictionary(rect => rect.name, rect => rect.spriteID, StringComparer.Ordinal);
            dataProvider.SetSpriteRects(blend.variants.Select(variant => new SpriteRect
            {
                name = variant.spriteName,
                rect = new Rect(variant.rect.x, variant.rect.y, variant.rect.width, variant.rect.height),
                alignment = SpriteAlignment.Custom,
                pivot = new Vector2(blend.pivotNormalized.x, blend.pivotNormalized.y),
                spriteID = previousIds.TryGetValue(variant.spriteName, out var previousId)
                    ? previousId
                    : UnityEngine.GUID.Generate(),
            }).ToArray());
            dataProvider.Apply();
            importer.SaveAndReimport();
        }

        private static void ConfigureWallTexture(string assetPath, float pixelsPerUnit, Vector2 pivot)
        {
            var importer = (TextureImporter)AssetImporter.GetAtPath(assetPath);
            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.spritePixelsPerUnit = pixelsPerUnit;
            ConfigureSingleSpritePivot(importer, pivot);
            importer.mipmapEnabled = false;
            importer.alphaIsTransparency = true;
            importer.textureCompression = TextureImporterCompression.Uncompressed;
            importer.filterMode = FilterMode.Point;
            importer.wrapMode = TextureWrapMode.Clamp;
            importer.SaveAndReimport();
        }

        private static void BuildGridPrefab(
            string generatedRoot,
            TileSettings tile,
            TerrainBlendSet terrainSet,
            TerrainBlendSupportTile supportTile,
            BuildingSet buildingSet,
            bool includeRoadTilemap,
            bool isTopDown)
        {
            var prefabDirectory = $"{generatedRoot}/Prefabs";
            EnsureFolder(prefabDirectory);
            var root = new GameObject("Terrain Grid", typeof(Grid), typeof(TerrainBlendMap), typeof(BuildingMap));
            try
            {
                var grid = root.GetComponent<Grid>();
                grid.cellLayout = isTopDown
                    ? GridLayout.CellLayout.Rectangle
                    : GridLayout.CellLayout.Isometric;
                grid.cellSize = new Vector3(
                    tile.widthPx / (float)tile.pixelsPerUnit,
                    tile.heightPx / (float)tile.pixelsPerUnit,
                    1f);

                var baseTilemap = CreateTilemap(root.transform, "Base", 0);
                var blendLayerCount = Math.Max(0, terrainSet.Terrains.Count - 1);
                var blendTilemaps = Enumerable.Range(0, blendLayerCount)
                    .Select(index => CreateTilemap(root.transform, $"Blend {index}", 10 + index))
                    .ToArray();
                var wallsTilemap = CreateTilemap(root.transform, "Walls", -10);
                if (includeRoadTilemap) CreateTilemap(root.transform, "Roads", 100);
                var buildingsRoot = new GameObject("Buildings");
                buildingsRoot.transform.SetParent(root.transform, false);
                root.GetComponent<TerrainBlendMap>().ConfigureGenerated(
                    terrainSet,
                    baseTilemap,
                    blendTilemaps,
                    wallsTilemap,
                    supportTile);
                root.GetComponent<BuildingMap>().ConfigureGenerated(
                    buildingSet,
                    grid,
                    buildingsRoot.transform);
                PrefabUtility.SaveAsPrefabAsset(root, $"{prefabDirectory}/TerrainGrid.prefab");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(root);
            }
        }

        private static void RefreshLoadedMaps(TerrainBlendSet terrainSet)
        {
            foreach (var map in UnityEngine.Object.FindObjectsByType<TerrainBlendMap>())
            {
                if (map.TerrainSet != terrainSet) continue;
                map.RefreshAllTiles();
                EditorUtility.SetDirty(map);
                foreach (var tilemap in map.GetComponentsInChildren<Tilemap>()) EditorUtility.SetDirty(tilemap);
                if (map.gameObject.scene.IsValid()) EditorSceneManager.MarkSceneDirty(map.gameObject.scene);
            }
        }

        private static void RefreshLoadedBuildingMaps(BuildingSet buildingSet)
        {
            foreach (var map in UnityEngine.Object.FindObjectsByType<BuildingMap>())
            {
                if (map.BuildingSet != buildingSet) continue;
                foreach (var instance in map.GetInstances())
                {
                    instance.SnapToGrid();
                    EditorUtility.SetDirty(instance);
                }
                if (map.gameObject.scene.IsValid()) EditorSceneManager.MarkSceneDirty(map.gameObject.scene);
            }
        }

        private static Tilemap CreateTilemap(Transform parent, string name, int sortingOrder)
        {
            var child = new GameObject(name, typeof(Tilemap), typeof(TilemapRenderer));
            child.transform.SetParent(parent, false);
            var renderer = child.GetComponent<TilemapRenderer>();
            renderer.mode = TilemapRenderer.Mode.Individual;
            renderer.sortingOrder = sortingOrder;
            return child.GetComponent<Tilemap>();
        }

        private static T LoadOrCreate<T>(string assetPath, out bool created) where T : ScriptableObject
        {
            var asset = AssetDatabase.LoadAssetAtPath<T>(assetPath);
            var isGeneratedDataType = typeof(T) == typeof(TerrainBlendDefinition)
                || typeof(T) == typeof(TerrainBlendSet)
                || typeof(T) == typeof(BuildingDefinition)
                || typeof(T) == typeof(BuildingSet);
            if (asset != null && isGeneratedDataType && HasMissingScript(asset))
            {
                AssetDatabase.DeleteAsset(assetPath);
                asset = null;
            }
            created = asset == null;
            if (!created) return asset;
            if (AssetDatabase.AssetPathExists(assetPath))
            {
                AssetDatabase.DeleteAsset(assetPath);
            }
            EnsureFolder(NormalizeAssetPath(Path.GetDirectoryName(assetPath) ?? "Assets"));
            asset = ScriptableObject.CreateInstance<T>();
            AssetDatabase.CreateAsset(asset, assetPath);
            return asset;
        }

        private static RuleTile LoadOrCreateRoadRuleTile(string assetPath, bool isTopDown)
        {
            var existing = AssetDatabase.LoadAssetAtPath<RuleTile>(assetPath);
            var hasExpectedType = existing != null && (isTopDown
                ? existing.GetType() == typeof(RuleTile)
                : existing.GetType() == typeof(IsometricRuleTile));
            if (existing != null && !hasExpectedType) AssetDatabase.DeleteAsset(assetPath);
            if (isTopDown) return LoadOrCreate<RuleTile>(assetPath, out _);
            return LoadOrCreate<IsometricRuleTile>(assetPath, out _);
        }

        private static bool HasMissingScript(ScriptableObject asset)
        {
            var scriptProperty = new SerializedObject(asset).FindProperty("m_Script");
            return scriptProperty == null || scriptProperty.objectReferenceValue == null;
        }

        private static void EnsureFolder(string folderPath)
        {
            var normalized = NormalizeAssetPath(folderPath).TrimEnd('/');
            if (AssetDatabase.IsValidFolder(normalized)) return;
            var parts = normalized.Split('/');
            var current = parts[0];
            for (var index = 1; index < parts.Length; index++)
            {
                var next = $"{current}/{parts[index]}";
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(current, parts[index]);
                current = next;
            }
        }

        private static HashSet<string> PlannedGeneratedFiles(ExportManifest manifest)
        {
            var planned = new HashSet<string>(StringComparer.Ordinal);
            var hasBuilding = false;
            foreach (var asset in manifest.assets)
            {
                if (asset.terrainBlend != null
                    && !string.IsNullOrWhiteSpace(asset.file)
                    && !string.IsNullOrWhiteSpace(asset.terrainBlend.atlasFile)
                    && !string.IsNullOrWhiteSpace(asset.terrainBlend.wallFile))
                {
                    foreach (var fileName in TerrainGeneratedFileNames)
                    {
                        planned.Add($"Terrains/{asset.id}/{fileName}");
                    }
                }
                if (asset.category == "building" && !string.IsNullOrWhiteSpace(asset.file))
                {
                    hasBuilding = true;
                    foreach (var fileName in BuildingGeneratedFileNames)
                    {
                        planned.Add($"Buildings/{asset.id}/{fileName}");
                    }
                }
                if (asset.category == "road_tile" && asset.roadVariants?.Length == 16)
                {
                    planned.Add($"Roads/{asset.id}/RoadRuleTile.asset");
                }
            }
            if (planned.Count == 0) return planned;
            planned.UnionWith(FixedGeneratedFiles);
            if (hasBuilding) planned.Add("Palettes/Buildings.prefab");
            return planned;
        }

        private static bool TryReadGeneratedOwnership(
            string generatedRoot,
            string ownershipPath,
            string expectedManifestPath,
            string expectedProjectId,
            out GeneratedOwnership ownership)
        {
            ownership = null;
            if (!File.Exists(ownershipPath))
            {
                if (!HasUnownedGeneratedContent(generatedRoot)) return true;
                Debug.LogError(
                    $"Tilemap Generator: {generatedRoot} zawiera pliki bez poprawnego inventory własności. Cleanup i przebudowa zostały zablokowane.");
                return false;
            }
            try
            {
                ownership = JsonUtility.FromJson<GeneratedOwnership>(File.ReadAllText(ownershipPath));
            }
            catch (Exception exception)
            {
                Debug.LogError($"Tilemap Generator: inventory {ownershipPath} jest nieczytelne: {exception.Message}");
                ownership = null;
                return false;
            }
            if (ownership == null
                || ownership.schemaVersion != GeneratedOwnershipSchemaVersion
                || ownership.owner != "tilemap-generator-unity-importer"
                || !Guid.TryParse(ownership.projectId, out _)
                || !IsSafeManifestAssetPath(ownership.manifestPath)
                || ownershipPath != $"{NormalizeAssetPath(Path.GetDirectoryName(ownership.manifestPath) ?? "Assets")}/Generated/{GeneratedOwnershipFileName}"
                || (expectedManifestPath != null && ownership.manifestPath != expectedManifestPath)
                || (expectedProjectId != null && ownership.projectId != expectedProjectId)
                || ownership.managedFiles == null
                || ownership.managedFiles.Any(relativePath => !IsSafeGeneratedRelativePath(relativePath))
                || ownership.managedFiles.Distinct(StringComparer.Ordinal).Count() != ownership.managedFiles.Length)
            {
                Debug.LogError(
                    $"Tilemap Generator: inventory {ownershipPath} nie potwierdza własności bieżącego manifestu. Cleanup i przebudowa zostały zablokowane.");
                ownership = null;
                return false;
            }
            return true;
        }

        private static bool HasUnownedGeneratedContent(string generatedRoot)
        {
            if (!Directory.Exists(generatedRoot)) return false;
            try
            {
                return Directory.EnumerateFiles(generatedRoot, "*", SearchOption.AllDirectories)
                    .Any(filePath => !filePath.EndsWith(".meta", StringComparison.OrdinalIgnoreCase));
            }
            catch
            {
                return true;
            }
        }

        private static void WriteGeneratedOwnership(
            string generatedRoot,
            string ownershipPath,
            string manifestPath,
            string projectId,
            IEnumerable<string> managedFiles)
        {
            EnsureFolder(generatedRoot);
            var ownership = new GeneratedOwnership
            {
                schemaVersion = GeneratedOwnershipSchemaVersion,
                owner = "tilemap-generator-unity-importer",
                projectId = projectId,
                manifestPath = manifestPath,
                managedFiles = managedFiles.OrderBy(pathValue => pathValue, StringComparer.Ordinal).ToArray(),
            };
            File.WriteAllText(ownershipPath, JsonUtility.ToJson(ownership, true));
            AssetDatabase.ImportAsset(ownershipPath, ImportAssetOptions.ForceUpdate);
        }

        private static HashSet<string> CleanupStaleGeneratedFiles(
            string generatedRoot,
            GeneratedOwnership existingOwnership,
            HashSet<string> desiredFiles)
        {
            var retained = new HashSet<string>(desiredFiles, StringComparer.Ordinal);
            if (existingOwnership == null) return retained;
            var removed = new List<string>();
            foreach (var relativePath in existingOwnership.managedFiles)
            {
                if (desiredFiles.Contains(relativePath)) continue;
                if (DeleteOwnedGeneratedFile(generatedRoot, relativePath)) removed.Add(relativePath);
                else retained.Add(relativePath);
            }
            CleanupEmptyGeneratedDirectories(generatedRoot, removed, false);
            return retained;
        }

        private static void CleanupGeneratedOwnership(
            string generatedRoot,
            string ownershipPath,
            string manifestPath,
            string projectId,
            GeneratedOwnership ownership)
        {
            if (ownership == null) return;
            var remaining = new HashSet<string>(StringComparer.Ordinal);
            var removed = new List<string>();
            foreach (var relativePath in ownership.managedFiles)
            {
                if (DeleteOwnedGeneratedFile(generatedRoot, relativePath)) removed.Add(relativePath);
                else remaining.Add(relativePath);
            }
            if (remaining.Count > 0)
            {
                WriteGeneratedOwnership(
                    generatedRoot,
                    ownershipPath,
                    manifestPath,
                    projectId,
                    remaining);
                CleanupEmptyGeneratedDirectories(generatedRoot, removed, false);
                return;
            }
            if (AssetDatabase.AssetPathExists(ownershipPath)) AssetDatabase.DeleteAsset(ownershipPath);
            CleanupEmptyGeneratedDirectories(generatedRoot, removed, true);
        }

        private static bool DeleteOwnedGeneratedFile(string generatedRoot, string relativePath)
        {
            if (!IsSafeGeneratedRelativePath(relativePath)) return false;
            var assetPath = $"{generatedRoot}/{relativePath}";
            if (!AssetDatabase.AssetPathExists(assetPath)) return true;
            return AssetDatabase.DeleteAsset(assetPath) && !AssetDatabase.AssetPathExists(assetPath);
        }

        private static void CleanupEmptyGeneratedDirectories(
            string generatedRoot,
            IEnumerable<string> removedFiles,
            bool includeGeneratedRoot)
        {
            var directories = new HashSet<string>(StringComparer.Ordinal);
            foreach (var relativePath in removedFiles)
            {
                var current = NormalizeAssetPath(Path.GetDirectoryName($"{generatedRoot}/{relativePath}") ?? generatedRoot);
                while (current.StartsWith($"{generatedRoot}/", StringComparison.Ordinal))
                {
                    directories.Add(current);
                    current = NormalizeAssetPath(Path.GetDirectoryName(current) ?? generatedRoot);
                }
            }
            if (includeGeneratedRoot) directories.Add(generatedRoot);
            foreach (var directoryPath in directories.OrderByDescending(pathValue => pathValue.Count(character => character == '/')))
            {
                if (!AssetDatabase.IsValidFolder(directoryPath) || !IsAssetDirectoryEmpty(directoryPath)) continue;
                AssetDatabase.DeleteAsset(directoryPath);
            }
        }

        private static bool IsAssetDirectoryEmpty(string assetDirectory)
        {
            if (!Directory.Exists(assetDirectory)) return true;
            try
            {
                return !Directory.EnumerateFileSystemEntries(assetDirectory)
                    .Any(entry => !entry.EndsWith(".meta", StringComparison.OrdinalIgnoreCase));
            }
            catch
            {
                return false;
            }
        }

        private static bool IsSafeGeneratedRelativePath(string relativePath)
        {
            if (string.IsNullOrWhiteSpace(relativePath)
                || relativePath.IndexOf('\0') >= 0
                || relativePath.Contains("\\")
                || relativePath.Contains(":")
                || relativePath.StartsWith("/", StringComparison.Ordinal)
                || relativePath.EndsWith(".meta", StringComparison.OrdinalIgnoreCase)) return false;
            var segments = relativePath.Split('/');
            if (segments.Any(segment => (
                string.IsNullOrEmpty(segment) || segment == "." || segment == ".."
            ))) return false;
            if (FixedGeneratedFiles.Contains(relativePath)
                || relativePath == "Palettes/Buildings.prefab") return true;
            if (segments.Length != 3 || !Guid.TryParse(segments[1], out _)) return false;
            if (segments[0] == "Terrains") return TerrainGeneratedFileNames.Contains(segments[2]);
            if (segments[0] == "Buildings") return BuildingGeneratedFileNames.Contains(segments[2]);
            return segments[0] == "Roads" && segments[2] == "RoadRuleTile.asset";
        }

        private static bool IsSafeManifestAssetPath(string manifestPath)
        {
            if (string.IsNullOrWhiteSpace(manifestPath)
                || manifestPath.IndexOf('\0') >= 0
                || manifestPath.Contains("\\")
                || manifestPath.Contains(":")
                || !manifestPath.StartsWith("Assets/", StringComparison.Ordinal)
                || Path.GetFileName(manifestPath) != ManifestFileName) return false;
            var segments = manifestPath.Split('/');
            return segments.Length >= 2
                && segments[0] == "Assets"
                && !segments.Any(segment => (
                    string.IsNullOrEmpty(segment) || segment == "." || segment == ".."
                ));
        }

        private static string ResolveAssetPath(string root, string relativePath)
        {
            return NormalizeAssetPath($"{root}/{relativePath}");
        }

        private static bool HasSafeOwnedPaths(ExportManifest manifest)
        {
            var managedFiles = new HashSet<string>(manifest.managedFiles, StringComparer.Ordinal);
            if (!managedFiles.Contains(ManifestFileName)
                || managedFiles.Any(pathValue => !IsSafeManagedPath(pathValue))) return false;

            foreach (var asset in manifest.assets)
            {
                if (asset == null
                    || !Guid.TryParse(asset.id, out _)
                    || !Guid.TryParse(asset.versionId, out _)) return false;
                if (!IsOwnedAssetPath(asset.file, managedFiles, asset.category == "road_tile")) return false;
                if (asset.terrainBlend != null
                    && (!IsOwnedAssetPath(asset.terrainBlend.atlasFile, managedFiles, false)
                        || !IsOwnedAssetPath(asset.terrainBlend.wallFile, managedFiles, false))) return false;
                if (asset.roadVariants == null) continue;
                if (asset.roadVariants.Any(variant => (
                    variant == null || !IsOwnedAssetPath(variant.file, managedFiles, false)
                ))) return false;
            }
            return true;
        }

        private static bool IsOwnedAssetPath(
            string pathValue,
            HashSet<string> managedFiles,
            bool allowEmpty)
        {
            return (allowEmpty && string.IsNullOrEmpty(pathValue))
                || (IsSafeManagedPath(pathValue) && managedFiles.Contains(pathValue));
        }

        private static bool IsSafeManagedPath(string pathValue)
        {
            if (string.IsNullOrWhiteSpace(pathValue)
                || pathValue.IndexOf('\0') >= 0
                || pathValue.Contains("\\")
                || pathValue.Contains(":")
                || pathValue.StartsWith("/", StringComparison.Ordinal)
                || pathValue.EndsWith(".meta", StringComparison.OrdinalIgnoreCase)) return false;
            var segments = pathValue.Split('/');
            if (segments.Any(segment => (
                string.IsNullOrEmpty(segment) || segment == "." || segment == ".."
            ))) return false;
            return !string.Equals(segments[0], "Generated", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(segments[0], "TilemapGeneratorIntegration", StringComparison.OrdinalIgnoreCase);
        }

        private static string NormalizeAssetPath(string pathValue)
        {
            return pathValue.Replace('\\', '/');
        }

        private static int DefaultPriority(IEnumerable<string> tags)
        {
            var normalized = new HashSet<string>((tags ?? Array.Empty<string>())
                .Select(tag => tag.Trim().ToLowerInvariant()));
            if (normalized.Overlaps(new[] { "woda", "rzeka", "water", "river" })) return 0;
            if (normalized.Overlaps(new[] { "piasek", "pustynia", "sand", "desert" })) return 10;
            if (normalized.Overlaps(new[] { "trawa", "łąka", "grass", "meadow" })) return 20;
            return 10;
        }

        private readonly struct NeighborSpec
        {
            public readonly int Bit;
            public readonly Vector3Int Position;
            private readonly int firstAdjacentEdge;
            private readonly int secondAdjacentEdge;

            public bool IsCorner => firstAdjacentEdge != 0;

            public NeighborSpec(int bit, Vector3Int position, int firstEdge, int secondEdge)
            {
                Bit = bit;
                Position = position;
                firstAdjacentEdge = firstEdge;
                secondAdjacentEdge = secondEdge;
            }

            public bool AdjacentEdgesPresent(int mask)
            {
                return (mask & firstAdjacentEdge) != 0 && (mask & secondAdjacentEdge) != 0;
            }
        }

        private readonly struct RoadNeighborSpec
        {
            public readonly int Bit;
            public readonly Vector3Int Position;

            public RoadNeighborSpec(int bit, Vector3Int position)
            {
                Bit = bit;
                Position = position;
            }
        }

        [Serializable]
        private sealed class ExportManifest
        {
            public int schemaVersion;
            public string[] managedFiles;
            public ProjectSettings project;
            public TileSettings tile;
            public TerrainAsset[] assets;
        }

        [Serializable]
        private sealed class GeneratedOwnership
        {
            public int schemaVersion;
            public string owner;
            public string projectId;
            public string manifestPath;
            public string[] managedFiles;
        }

        [Serializable]
        private sealed class ProjectSettings
        {
            public string id;
            public string projection;
        }

        [Serializable]
        private sealed class TileSettings
        {
            public int widthPx;
            public int heightPx;
            public int pixelsPerUnit;
        }

        [Serializable]
        private sealed class TerrainAsset
        {
            public string id;
            public string versionId;
            public string name;
            public string category;
            public int elevationLevels;
            public string[] tags;
            public string file;
            public FootprintData footprintCells;
            public PivotData pivotNormalized;
            public TerrainBlendData terrainBlend;
            public RoadVariantData[] roadVariants;
        }

        [Serializable]
        private sealed class RoadVariantData
        {
            public int mask;
            public string file;
        }

        [Serializable]
        private sealed class FootprintData
        {
            public int x;
            public int y;
        }

        [Serializable]
        private sealed class TerrainBlendData
        {
            public string atlasFile;
            public string wallFile;
            public PivotData pivotNormalized;
            public BlendVariant[] variants;
        }

        [Serializable]
        private sealed class BlendVariant
        {
            public int mask;
            public string spriteName;
            public RectData rect;
        }

        [Serializable]
        private sealed class RectData
        {
            public int x;
            public int y;
            public int width;
            public int height;
        }

        [Serializable]
        private sealed class PivotData
        {
            public float x;
            public float y;
        }
    }

    public sealed class TerrainBlendAssetPostprocessor : AssetPostprocessor
    {
        private static void OnPostprocessAllAssets(
            string[] importedAssets,
            string[] deletedAssets,
            string[] movedAssets,
            string[] movedFromAssetPaths)
        {
            foreach (var deletedManifest in deletedAssets
                .Concat(movedFromAssetPaths)
                .Where(path => Path.GetFileName(path) == "tilemap-assets.json"))
            {
                TerrainBlendImporter.ScheduleDeletedManifestCleanup(deletedManifest);
            }
            if (importedAssets.Concat(movedAssets)
                .Any(path => Path.GetFileName(path) == "tilemap-assets.json"))
            {
                TerrainBlendImporter.ScheduleRebuild();
            }
        }
    }
}
