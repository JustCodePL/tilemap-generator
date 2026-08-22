using System.Collections.Generic;
using UnityEngine;

namespace TilemapGenerator.Buildings
{
    [DisallowMultipleComponent]
    [RequireComponent(typeof(Grid))]
    public sealed class BuildingMap : MonoBehaviour
    {
        [SerializeField] private BuildingSet buildingSet;
        [SerializeField] private Grid grid;
        [SerializeField] private Transform buildingsRoot;

        public BuildingSet BuildingSet => buildingSet;
        public Grid Grid => grid;
        public Transform BuildingsRoot => buildingsRoot;

        public bool CanPlace(
            BuildingDefinition definition,
            Vector3Int originCell,
            BuildingInstance ignoredInstance = null)
        {
            if (definition == null || buildingsRoot == null) return false;
            foreach (var existing in GetInstances())
            {
                if (existing == null || existing == ignoredInstance) continue;
                foreach (var occupied in existing.OccupiedCells)
                {
                    if (Contains(definition, originCell, occupied)) return false;
                }
            }
            return true;
        }

        public BuildingInstance GetBuildingAt(Vector3Int cell)
        {
            foreach (var instance in GetInstances())
            {
                if (instance == null) continue;
                foreach (var occupied in instance.OccupiedCells)
                {
                    if (occupied == cell) return instance;
                }
            }
            return null;
        }

        public IEnumerable<BuildingInstance> GetInstances()
        {
            if (buildingsRoot == null) yield break;
            foreach (var instance in buildingsRoot.GetComponentsInChildren<BuildingInstance>(true))
            {
                yield return instance;
            }
        }

        private static bool Contains(BuildingDefinition definition, Vector3Int originCell, Vector3Int cell)
        {
            var local = cell - originCell;
            return local.z == 0
                && local.x >= 0
                && local.y >= 0
                && local.x < definition.Footprint.x
                && local.y < definition.Footprint.y;
        }

#if UNITY_EDITOR
        public void ConfigureGenerated(
            BuildingSet generatedBuildingSet,
            Grid generatedGrid,
            Transform generatedBuildingsRoot)
        {
            buildingSet = generatedBuildingSet;
            grid = generatedGrid;
            buildingsRoot = generatedBuildingsRoot;
        }
#endif
    }
}
