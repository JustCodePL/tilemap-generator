using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEditor.Tilemaps;
using UnityEngine;
using UnityEngine.Tilemaps;

namespace TilemapGenerator.Buildings.Editor
{
    [CustomGridBrush(false, false, false, "Building Placement Brush")]
    public sealed class BuildingPlacementBrush : GridBrushBase
    {
        [SerializeField] private BuildingDefinition building;

        public BuildingDefinition Building
        {
            get => building;
            set => building = value;
        }

        public override void Paint(GridLayout gridLayout, GameObject brushTarget, Vector3Int position)
        {
            if (!TryGetMap(brushTarget, out var map)
                || building == null
                || building.Prefab == null
                || !map.CanPlace(building, position)) return;

            var created = PrefabUtility.InstantiatePrefab(building.Prefab, map.BuildingsRoot) as GameObject;
            if (created == null) return;
            Undo.RegisterCreatedObjectUndo(created, $"Place {building.DisplayName}");
            var instance = created.GetComponent<BuildingInstance>();
            if (instance == null)
            {
                Undo.DestroyObjectImmediate(created);
                return;
            }
            instance.ConfigurePlacement(map, position);
            created.name = building.DisplayName;
            EditorUtility.SetDirty(instance);
            MarkSceneDirty(map);
        }

        public override void Erase(GridLayout gridLayout, GameObject brushTarget, Vector3Int position)
        {
            if (!TryGetMap(brushTarget, out var map)) return;
            var instance = map.GetBuildingAt(position);
            if (instance == null) return;
            Undo.DestroyObjectImmediate(instance.gameObject);
            MarkSceneDirty(map);
        }

        public override void Pick(GridLayout gridLayout, GameObject brushTarget, BoundsInt position, Vector3Int pickStart)
        {
            var paletteTilemap = brushTarget == null
                ? null
                : brushTarget.GetComponent<Tilemap>() ?? brushTarget.GetComponentInChildren<Tilemap>();
            if (paletteTilemap != null)
            {
                SelectBuilding(paletteTilemap.GetTile(position.position) as BuildingDefinition);
                return;
            }

            if (!TryGetMap(brushTarget, out var map)) return;
            var instance = map.GetBuildingAt(position.position);
            if (instance == null) return;
            SelectBuilding(instance.Definition);
        }

        private void SelectBuilding(BuildingDefinition selected)
        {
            if (selected == building) return;
            Undo.RecordObject(this, "Select building brush");
            building = selected;
            EditorUtility.SetDirty(this);
        }

        internal static bool TryGetMap(GameObject brushTarget, out BuildingMap map)
        {
            map = null;
            if (brushTarget == null) return false;
            map = brushTarget.GetComponent<BuildingMap>()
                ?? brushTarget.GetComponentInParent<BuildingMap>();
            return map != null;
        }

        private static void MarkSceneDirty(BuildingMap map)
        {
            EditorUtility.SetDirty(map);
            if (map.gameObject.scene.IsValid()) EditorSceneManager.MarkSceneDirty(map.gameObject.scene);
        }
    }

    [CustomEditor(typeof(BuildingPlacementBrush))]
    public sealed class BuildingPlacementBrushEditor : GridBrushEditorBase
    {
        private GameObject previewObject;
        private SpriteRenderer previewRenderer;

        private BuildingPlacementBrush Brush => (BuildingPlacementBrush)target;

        public override string tooltip => "Places generated building prefabs on their shared isometric Grid and reserves their complete footprint.";

        public override bool canChangeZPosition
        {
            get => false;
            set { }
        }

        public override void OnPaintInspectorGUI()
        {
            if (!BuildingPlacementBrush.TryGetMap(GridPaintingState.scenePaintTarget, out var map))
            {
                EditorGUILayout.HelpBox(
                    "Add TerrainGrid.prefab to the scene and choose Terrain Grid as the Active Target.",
                    MessageType.Info);
                return;
            }

            var buildings = map.BuildingSet == null
                ? new List<BuildingDefinition>()
                : map.BuildingSet.Buildings.Where(item => item != null).ToList();
            if (buildings.Count == 0)
            {
                EditorGUILayout.HelpBox("The selected Terrain Grid has no generated buildings.", MessageType.Warning);
                return;
            }

            var selected = Brush.Building;
            if (selected == null)
            {
                EditorGUILayout.HelpBox(
                    "Pick a generated building in the Buildings palette above before painting.",
                    MessageType.Info);
                return;
            }
            EditorGUILayout.LabelField("Footprint", $"{selected.Footprint.x} x {selected.Footprint.y} cells");
            EditorGUILayout.LabelField("Anchor", "Sprite pivot -> origin cell center");
            EditorGUILayout.HelpBox(
                "Choose a building visually from the generated Buildings palette above. Paint places its prefab only when the whole footprint is free. Erase removes it from any occupied cell, and Pick can copy a type already placed in the scene.",
                MessageType.None);
        }

        public override void OnPaintSceneGUI(
            GridLayout gridLayout,
            GameObject brushTarget,
            BoundsInt position,
            GridBrushBase.Tool tool,
            bool executing)
        {
            if (!BuildingPlacementBrush.TryGetMap(brushTarget, out var map)
                || Brush.Building == null)
            {
                HidePreview();
                return;
            }

            var origin = position.position;
            var canPlace = tool == GridBrushBase.Tool.Erase || map.CanPlace(Brush.Building, origin);
            DrawFootprint(gridLayout, origin, Brush.Building.Footprint, canPlace);
            if (tool == GridBrushBase.Tool.Paint)
            {
                ShowPreview(map, origin, canPlace);
            }
            else
            {
                HidePreview();
            }
        }

        public override void OnMouseLeave()
        {
            HidePreview();
        }

        private void OnDisable()
        {
            if (previewObject != null) DestroyImmediate(previewObject);
        }

        private void ShowPreview(BuildingMap map, Vector3Int origin, bool canPlace)
        {
            if (previewObject == null)
            {
                previewObject = new GameObject("Building Placement Preview", typeof(SpriteRenderer))
                {
                    hideFlags = HideFlags.HideAndDontSave,
                };
                previewRenderer = previewObject.GetComponent<SpriteRenderer>();
                previewRenderer.spriteSortPoint = SpriteSortPoint.Pivot;
                previewRenderer.sortingOrder = short.MaxValue;
            }
            previewObject.SetActive(true);
            previewObject.transform.position = map.Grid.GetCellCenterWorld(origin);
            previewRenderer.sprite = Brush.Building.Sprite;
            previewRenderer.color = canPlace
                ? new Color(0.45f, 1f, 0.55f, 0.55f)
                : new Color(1f, 0.35f, 0.35f, 0.55f);
        }

        private void HidePreview()
        {
            if (previewObject != null) previewObject.SetActive(false);
        }

        private static void DrawFootprint(
            GridLayout gridLayout,
            Vector3Int origin,
            Vector2Int footprint,
            bool canPlace)
        {
            var fill = canPlace
                ? new Color(0.2f, 1f, 0.35f, 0.16f)
                : new Color(1f, 0.15f, 0.15f, 0.2f);
            var outline = canPlace
                ? new Color(0.2f, 1f, 0.35f, 0.9f)
                : new Color(1f, 0.15f, 0.15f, 0.95f);
            var right = gridLayout.transform.TransformVector(new Vector3(gridLayout.cellSize.x * 0.5f, 0f, 0f));
            var up = gridLayout.transform.TransformVector(new Vector3(0f, gridLayout.cellSize.y * 0.5f, 0f));

            for (var y = 0; y < footprint.y; y += 1)
            for (var x = 0; x < footprint.x; x += 1)
            {
                var cell = origin + new Vector3Int(x, y, 0);
                var center = gridLayout.LocalToWorld(
                    gridLayout.CellToLocalInterpolated(cell)
                    + gridLayout.CellToLocalInterpolated(new Vector3(0.5f, 0.5f, 0f)));
                var points = new[]
                {
                    center - right,
                    center + up,
                    center + right,
                    center - up,
                };
                Handles.color = fill;
                Handles.DrawAAConvexPolygon(points);
                Handles.color = outline;
                Handles.DrawAAPolyLine(2f, points[0], points[1], points[2], points[3], points[0]);
            }
        }

        public override GameObject[] validTargets => StageUtility.GetCurrentStageHandle()
            .FindComponentsOfType<BuildingMap>()
            .Where(item => item.gameObject.scene.isLoaded
                && item.gameObject.activeInHierarchy
                && !item.gameObject.hideFlags.HasFlag(HideFlags.NotEditable))
            .Select(item => item.gameObject)
            .ToArray();
    }
}
