using System.Collections.Generic;
using UnityEngine;

namespace TilemapGenerator.Buildings
{
    [CreateAssetMenu(menuName = "Tilemap Generator/Building Set")]
    public sealed class BuildingSet : ScriptableObject
    {
        [SerializeField] private List<BuildingDefinition> buildings = new();

        public IReadOnlyList<BuildingDefinition> Buildings => buildings;

#if UNITY_EDITOR
        public void ConfigureGenerated(IEnumerable<BuildingDefinition> generatedBuildings)
        {
            buildings.Clear();
            buildings.AddRange(generatedBuildings);
            buildings.Sort((left, right) => string.CompareOrdinal(left.DisplayName, right.DisplayName));
        }
#endif
    }
}
