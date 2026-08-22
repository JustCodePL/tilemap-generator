using System.Collections.Generic;
using UnityEngine;

namespace TilemapGenerator.Buildings
{
    [DisallowMultipleComponent]
    public sealed class BuildingInstance : MonoBehaviour
    {
        [SerializeField] private BuildingDefinition definition;
        [SerializeField] private BuildingMap map;
        [SerializeField] private Vector3Int originCell;

        public BuildingDefinition Definition => definition;
        public BuildingMap Map => map;
        public Vector3Int OriginCell => originCell;

        public IEnumerable<Vector3Int> OccupiedCells
        {
            get
            {
                if (definition == null) yield break;
                for (var y = 0; y < definition.Footprint.y; y += 1)
                for (var x = 0; x < definition.Footprint.x; x += 1)
                {
                    yield return originCell + new Vector3Int(x, y, 0);
                }
            }
        }

        public void ConfigurePlacement(BuildingMap targetMap, Vector3Int targetOriginCell)
        {
            map = targetMap;
            originCell = targetOriginCell;
            SnapToGrid();
        }

        public void SnapToGrid()
        {
            if (map == null || map.Grid == null) return;
            transform.position = map.Grid.GetCellCenterWorld(originCell);
        }

#if UNITY_EDITOR
        public void ConfigureGenerated(BuildingDefinition generatedDefinition)
        {
            definition = generatedDefinition;
        }
#endif
    }
}
