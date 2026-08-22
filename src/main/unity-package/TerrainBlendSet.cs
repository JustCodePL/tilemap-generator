using System.Collections.Generic;
using UnityEngine;

namespace TilemapGenerator.TerrainBlend
{
    [CreateAssetMenu(menuName = "Tilemap Generator/Terrain Blend Set")]
    public sealed class TerrainBlendSet : ScriptableObject
    {
        [SerializeField] private List<TerrainBlendDefinition> terrains = new();

        public IReadOnlyList<TerrainBlendDefinition> Terrains => terrains;

#if UNITY_EDITOR
        public void ConfigureGenerated(IEnumerable<TerrainBlendDefinition> generatedTerrains)
        {
            terrains.Clear();
            terrains.AddRange(generatedTerrains);
            terrains.Sort((left, right) =>
            {
                var priority = left.BlendPriority.CompareTo(right.BlendPriority);
                return priority != 0
                    ? priority
                    : string.CompareOrdinal(left.AssetId, right.AssetId);
            });
        }
#endif
    }
}
