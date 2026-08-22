using UnityEngine;
using UnityEngine.Tilemaps;

namespace TilemapGenerator.TerrainBlend
{
    [CreateAssetMenu(menuName = "Tilemap Generator/Terrain Blend Definition")]
    public sealed class TerrainBlendDefinition : ScriptableObject
    {
        [SerializeField] private string assetId = string.Empty;
        [SerializeField] private string versionId = string.Empty;
        [SerializeField] private string displayName = string.Empty;
        [SerializeField] private int blendPriority;
        [SerializeField] private bool elevated;
        [SerializeField] private int elevationLevels;
        [SerializeField] private Tile baseTile;
        [SerializeField] private Tile wallTile;
        [SerializeField] private TerrainBlendRuleTile blendRuleTile;

        public string AssetId => assetId;
        public string VersionId => versionId;
        public string DisplayName => displayName;
        public int BlendPriority => blendPriority;
        public bool Elevated => elevated;
        public int ElevationLevels => elevationLevels;
        public Tile BaseTile => baseTile;
        public Tile WallTile => wallTile;
        public TerrainBlendRuleTile BlendRuleTile => blendRuleTile;

#if UNITY_EDITOR
        public void ConfigureGenerated(
            string generatedAssetId,
            string generatedVersionId,
            string generatedDisplayName,
            bool isElevated,
            int generatedElevationLevels,
            Tile generatedBaseTile,
            Tile generatedWallTile,
            TerrainBlendRuleTile generatedBlendRuleTile,
            int defaultPriority,
            bool initializePriority)
        {
            assetId = generatedAssetId;
            versionId = generatedVersionId;
            displayName = generatedDisplayName;
            elevated = isElevated;
            elevationLevels = generatedElevationLevels;
            baseTile = generatedBaseTile;
            wallTile = generatedWallTile;
            blendRuleTile = generatedBlendRuleTile;
            if (initializePriority) blendPriority = defaultPriority;
        }
#endif
    }
}
