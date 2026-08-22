using UnityEngine;

namespace TilemapGenerator.Buildings
{
    [CreateAssetMenu(menuName = "Tilemap Generator/Building Definition")]
    public sealed class BuildingDefinition : UnityEngine.Tilemaps.Tile
    {
        [SerializeField] private string assetId = string.Empty;
        [SerializeField] private string versionId = string.Empty;
        [SerializeField] private string displayName = string.Empty;
        [SerializeField] private Vector2Int footprint = Vector2Int.one;
        [SerializeField] private Vector2 pivotNormalized = new(0.5f, 0f);
        [SerializeField] private Sprite buildingSprite;
        [SerializeField] private GameObject prefab;

        public string AssetId => assetId;
        public string VersionId => versionId;
        public string DisplayName => displayName;
        public Vector2Int Footprint => footprint;
        public Vector2 PivotNormalized => pivotNormalized;
        public Sprite Sprite => buildingSprite;
        public GameObject Prefab => prefab;

#if UNITY_EDITOR
        public void ConfigureGenerated(
            string generatedAssetId,
            string generatedVersionId,
            string generatedDisplayName,
            Vector2Int generatedFootprint,
            Vector2 generatedPivotNormalized,
            Sprite generatedSprite)
        {
            assetId = generatedAssetId;
            versionId = generatedVersionId;
            displayName = generatedDisplayName;
            footprint = new Vector2Int(
                Mathf.Max(1, generatedFootprint.x),
                Mathf.Max(1, generatedFootprint.y));
            pivotNormalized = generatedPivotNormalized;
            buildingSprite = generatedSprite;
            sprite = generatedSprite;
            color = Color.white;
            colliderType = ColliderType.None;
        }

        public void SetGeneratedPrefab(GameObject generatedPrefab)
        {
            prefab = generatedPrefab;
        }
#endif
    }
}
