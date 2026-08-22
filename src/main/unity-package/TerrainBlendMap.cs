using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Tilemaps;

namespace TilemapGenerator.TerrainBlend
{
    public sealed class TerrainBlendMap : MonoBehaviour
    {
        private static readonly Vector3Int[] NeighborOffsets =
        {
            new(-1, 0, 0),
            new(-1, -1, 0),
            new(0, -1, 0),
            new(1, -1, 0),
            new(1, 0, 0),
            new(1, 1, 0),
            new(0, 1, 0),
            new(-1, 1, 0),
        };

        [SerializeField] private TerrainBlendSet terrainSet;
        [SerializeField] private Tilemap baseTilemap;
        [SerializeField] private Tilemap[] blendTilemaps;
        [SerializeField] private Tilemap wallsTilemap;
        [SerializeField] private TerrainBlendSupportTile supportTile;

        public TerrainBlendSet TerrainSet => terrainSet;
        public Tilemap BaseTilemap => baseTilemap;
        public IReadOnlyList<Tilemap> BlendTilemaps => blendTilemaps;
        public Tilemap WallsTilemap => wallsTilemap;

        public TerrainBlendDefinition GetTerrain(Vector3Int cell)
        {
            var index = GetTerrainIndex(cell);
            return index >= 0 ? terrainSet.Terrains[index] : null;
        }

        public bool Paint(Vector3Int cell, TerrainBlendDefinition terrain)
        {
            if (!TryGetTerrainIndex(terrain, out _)) return false;
            if (!HasValidGeneratedLayers()) return false;

            wallsTilemap.SetTile(cell, terrain.WallTile != null ? terrain.WallTile : terrain.BaseTile);
            RebuildAround(cell);
            return true;
        }

        public void Erase(Vector3Int cell)
        {
            if (!HasValidGeneratedLayers()) return;
            wallsTilemap.SetTile(cell, null);
            RebuildAround(cell);
        }

        public void RefreshAllTiles()
        {
            if (!HasValidGeneratedLayers()) return;

            wallsTilemap.CompressBounds();
            var bounds = wallsTilemap.cellBounds;
            foreach (var tilemap in SurfaceTilemaps()) tilemap.ClearAllTiles();

            for (var z = bounds.zMin; z < bounds.zMax; z += 1)
            for (var y = bounds.yMin; y < bounds.yMax; y += 1)
            for (var x = bounds.xMin; x < bounds.xMax; x += 1)
            {
                var cell = new Vector3Int(x, y, z);
                var terrain = GetTerrain(cell);
                if (terrain == null || terrain.WallTile == null) continue;
                if (wallsTilemap.GetTile(cell) != terrain.WallTile) wallsTilemap.SetTile(cell, terrain.WallTile);
            }

            for (var z = bounds.zMin; z < bounds.zMax; z += 1)
            for (var y = bounds.yMin - 1; y <= bounds.yMax; y += 1)
            for (var x = bounds.xMin - 1; x <= bounds.xMax; x += 1)
            {
                RebuildCell(new Vector3Int(x, y, z));
            }

            foreach (var tilemap in SurfaceTilemaps()) tilemap.RefreshAllTiles();
            wallsTilemap.RefreshAllTiles();
        }

        private void RebuildAround(Vector3Int changedCell)
        {
            for (var y = -2; y <= 2; y += 1)
            for (var x = -2; x <= 2; x += 1)
            {
                RebuildCell(changedCell + new Vector3Int(x, y, 0));
            }

            foreach (var tilemap in SurfaceTilemaps())
            {
                for (var y = -3; y <= 3; y += 1)
                for (var x = -3; x <= 3; x += 1)
                {
                    tilemap.RefreshTile(changedCell + new Vector3Int(x, y, 0));
                }
            }
        }

        private void RebuildCell(Vector3Int cell)
        {
            var selectedIndex = GetTerrainIndex(cell);
            if (selectedIndex < 0)
            {
                var boundarySupport = HasPaintedNeighbor(cell) ? supportTile : null;
                for (var layerIndex = 0; layerIndex < terrainSet.Terrains.Count; layerIndex++)
                {
                    GetSurfaceTilemap(layerIndex).SetTile(cell, boundarySupport);
                }
                return;
            }

            for (var layerIndex = 0; layerIndex < terrainSet.Terrains.Count; layerIndex++)
            {
                var tile = ShouldOccupyLayer(cell, selectedIndex, layerIndex)
                    ? terrainSet.Terrains[layerIndex].BlendRuleTile
                    : null;
                GetSurfaceTilemap(layerIndex).SetTile(cell, tile);
            }
        }

        private bool ShouldOccupyLayer(Vector3Int cell, int selectedIndex, int layerIndex)
        {
            if (selectedIndex == layerIndex) return true;
            if (selectedIndex < layerIndex) return false;

            foreach (var offset in NeighborOffsets)
            {
                if (GetTerrainIndex(cell + offset) == layerIndex) return true;
            }
            return false;
        }

        private bool HasPaintedNeighbor(Vector3Int cell)
        {
            foreach (var offset in NeighborOffsets)
            {
                if (GetTerrainIndex(cell + offset) >= 0) return true;
            }
            return false;
        }

        private int GetTerrainIndex(Vector3Int cell)
        {
            if (terrainSet == null || wallsTilemap == null) return -1;
            var paintedTile = wallsTilemap.GetTile(cell);
            if (paintedTile == null) return -1;

            for (var index = 0; index < terrainSet.Terrains.Count; index += 1)
            {
                var terrain = terrainSet.Terrains[index];
                if (terrain != null && (terrain.WallTile == paintedTile || terrain.BaseTile == paintedTile)) return index;
            }
            return -1;
        }

        private bool TryGetTerrainIndex(TerrainBlendDefinition terrain, out int terrainIndex)
        {
            terrainIndex = -1;
            if (terrain == null || terrainSet == null) return false;
            for (var index = 0; index < terrainSet.Terrains.Count; index += 1)
            {
                if (terrainSet.Terrains[index] != terrain
                    && terrainSet.Terrains[index].AssetId != terrain.AssetId) continue;
                terrainIndex = index;
                return true;
            }
            return false;
        }

        private bool HasValidGeneratedLayers()
        {
            return terrainSet != null
                && baseTilemap != null
                && wallsTilemap != null
                && supportTile != null
                && blendTilemaps != null
                && blendTilemaps.Length == terrainSet.Terrains.Count - 1;
        }

        private Tilemap GetSurfaceTilemap(int terrainIndex)
        {
            return terrainIndex == 0 ? baseTilemap : blendTilemaps[terrainIndex - 1];
        }

        private IEnumerable<Tilemap> SurfaceTilemaps()
        {
            if (baseTilemap != null) yield return baseTilemap;
            if (blendTilemaps == null) yield break;
            foreach (var tilemap in blendTilemaps)
            {
                if (tilemap != null) yield return tilemap;
            }
        }

#if UNITY_EDITOR
        public void ConfigureGenerated(
            TerrainBlendSet generatedTerrainSet,
            Tilemap generatedBaseTilemap,
            Tilemap[] generatedBlendTilemaps,
            Tilemap generatedWallsTilemap,
            TerrainBlendSupportTile generatedSupportTile)
        {
            terrainSet = generatedTerrainSet;
            baseTilemap = generatedBaseTilemap;
            blendTilemaps = generatedBlendTilemaps;
            wallsTilemap = generatedWallsTilemap;
            supportTile = generatedSupportTile;
        }
#endif
    }
}
