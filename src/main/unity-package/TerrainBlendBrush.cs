using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEditor.Tilemaps;
using UnityEngine;
using UnityEngine.Tilemaps;
using Object = UnityEngine.Object;

namespace TilemapGenerator.TerrainBlend.Editor
{
    [CustomGridBrush(false, false, false, "Terrain Blend Brush")]
    public sealed class TerrainBlendBrush : GridBrushBase
    {
        [SerializeField] private TerrainBlendDefinition terrain;

        public TerrainBlendDefinition Terrain
        {
            get => terrain;
            set => terrain = value;
        }

        public override void Paint(GridLayout gridLayout, GameObject brushTarget, Vector3Int position)
        {
            if (!TryGetMap(brushTarget, out var map) || terrain == null) return;
            map.Paint(position, terrain);
            MarkDirty(map);
        }

        public override void Erase(GridLayout gridLayout, GameObject brushTarget, Vector3Int position)
        {
            if (!TryGetMap(brushTarget, out var map)) return;
            map.Erase(position);
            MarkDirty(map);
        }

        public override void BoxFill(GridLayout gridLayout, GameObject brushTarget, BoundsInt position)
        {
            if (!TryGetMap(brushTarget, out var map) || terrain == null) return;
            foreach (var cell in position.allPositionsWithin) map.Paint(cell, terrain);
            MarkDirty(map);
        }

        public override void BoxErase(GridLayout gridLayout, GameObject brushTarget, BoundsInt position)
        {
            if (!TryGetMap(brushTarget, out var map)) return;
            foreach (var cell in position.allPositionsWithin) map.Erase(cell);
            MarkDirty(map);
        }

        public override void FloodFill(GridLayout gridLayout, GameObject brushTarget, Vector3Int position)
        {
            if (!TryGetMap(brushTarget, out var map) || terrain == null) return;
            var replacedTerrain = map.GetTerrain(position);
            if (replacedTerrain == null)
            {
                map.Paint(position, terrain);
                MarkDirty(map);
                return;
            }
            if (replacedTerrain == terrain) return;

            var bounds = map.BaseTilemap.cellBounds;
            var pending = new Stack<Vector3Int>();
            var visited = new HashSet<Vector3Int>();
            pending.Push(position);
            while (pending.Count > 0)
            {
                var cell = pending.Pop();
                if (!bounds.Contains(cell) || !visited.Add(cell) || map.GetTerrain(cell) != replacedTerrain) continue;
                map.Paint(cell, terrain);
                pending.Push(cell + Vector3Int.left);
                pending.Push(cell + Vector3Int.right);
                pending.Push(cell + Vector3Int.up);
                pending.Push(cell + Vector3Int.down);
            }
            MarkDirty(map);
        }

        public override void Pick(GridLayout gridLayout, GameObject brushTarget, BoundsInt position, Vector3Int pickStart)
        {
            if (TryGetMap(brushTarget, out var map))
            {
                SelectTerrain(map.GetTerrain(position.position));
                return;
            }

            if (!TryGetMap(GridPaintingState.scenePaintTarget, out map)) return;
            var paletteTilemap = brushTarget == null ? null : brushTarget.GetComponent<Tilemap>();
            if (paletteTilemap == null || map.TerrainSet == null) return;

            TerrainBlendDefinition pickedTerrain = null;
            foreach (var cell in position.allPositionsWithin)
            {
                var tile = paletteTilemap.GetTile(cell);
                pickedTerrain = map.TerrainSet.Terrains.FirstOrDefault(item => item != null
                    && (item.BaseTile == tile || item.WallTile == tile || item.BlendRuleTile == tile));
                if (pickedTerrain == null) continue;
                break;
            }
            SelectTerrain(pickedTerrain);
        }

        private void SelectTerrain(TerrainBlendDefinition pickedTerrain)
        {
            if (pickedTerrain == terrain) return;
            Undo.RecordObject(this, "Select terrain brush");
            terrain = pickedTerrain;
            EditorUtility.SetDirty(this);
        }

        internal static bool TryGetMap(GameObject brushTarget, out TerrainBlendMap map)
        {
            map = null;
            if (brushTarget == null) return false;
            map = brushTarget.GetComponent<TerrainBlendMap>()
                ?? brushTarget.GetComponentInParent<TerrainBlendMap>();
            return map != null;
        }

        private static void MarkDirty(TerrainBlendMap map)
        {
            foreach (var tilemap in GetTilemaps(map)) EditorUtility.SetDirty(tilemap);
            if (map.gameObject.scene.IsValid()) EditorSceneManager.MarkSceneDirty(map.gameObject.scene);
        }

        internal static IEnumerable<Tilemap> GetTilemaps(TerrainBlendMap map)
        {
            if (map.BaseTilemap != null) yield return map.BaseTilemap;
            foreach (var tilemap in map.BlendTilemaps)
            {
                if (tilemap != null) yield return tilemap;
            }
            if (map.WallsTilemap != null) yield return map.WallsTilemap;
        }
    }

    [CustomEditor(typeof(TerrainBlendBrush))]
    public sealed class TerrainBlendBrushEditor : GridBrushEditorBase
    {
        private GameObject previewObject;
        private SpriteRenderer previewRenderer;

        private TerrainBlendBrush Brush => (TerrainBlendBrush)target;

        public override string tooltip => "Paints one terrain choice across the generated base, blend and walls Tilemaps.";

        public override bool canChangeZPosition
        {
            get => false;
            set { }
        }

        public override void OnPaintInspectorGUI()
        {
            var brush = (TerrainBlendBrush)target;
            if (!TerrainBlendBrush.TryGetMap(GridPaintingState.scenePaintTarget, out var map))
            {
                EditorGUILayout.HelpBox(
                    "Add TerrainGrid.prefab to the scene and choose Terrain Grid as the Active Target.",
                    MessageType.Info);
                return;
            }

            var terrains = map.TerrainSet == null
                ? new List<TerrainBlendDefinition>()
                : map.TerrainSet.Terrains.Where(item => item != null).ToList();
            if (terrains.Count == 0)
            {
                EditorGUILayout.HelpBox("The selected Terrain Grid has no generated terrains.", MessageType.Warning);
                return;
            }

            if (brush.Terrain == null || !terrains.Contains(brush.Terrain))
            {
                EditorGUILayout.HelpBox(
                    "Pick a generated terrain tile in the Tile Palette or in the scene before painting.",
                    MessageType.Info);
                return;
            }

            EditorGUILayout.HelpBox(
                "Pick another generated tile in the Tile Palette or a painted scene cell to change terrain. Paint, Erase, Box and Flood Fill update every generated terrain layer together.",
                MessageType.None);
        }

        public override void OnPaintSceneGUI(
            GridLayout gridLayout,
            GameObject brushTarget,
            BoundsInt position,
            GridBrushBase.Tool tool,
            bool executing)
        {
            if (!TerrainBlendBrush.TryGetMap(brushTarget, out var map))
            {
                HidePreview();
                return;
            }

            var origin = position.position;
            if (tool == GridBrushBase.Tool.Paint && Brush.Terrain != null)
            {
                DrawCellPreview(gridLayout, origin, true);
                ShowPreview(map, origin);
                return;
            }
            if (tool == GridBrushBase.Tool.Erase)
            {
                DrawCellPreview(gridLayout, origin, false);
            }
            HidePreview();
        }

        public override void OnMouseLeave()
        {
            HidePreview();
        }

        private void OnDisable()
        {
            if (previewObject != null) DestroyImmediate(previewObject);
        }

        private void ShowPreview(TerrainBlendMap map, Vector3Int origin)
        {
            var sprite = Brush.Terrain.BlendRuleTile == null
                ? null
                : Brush.Terrain.BlendRuleTile.m_DefaultSprite;
            if (sprite == null)
            {
                HidePreview();
                return;
            }
            if (previewObject == null)
            {
                previewObject = new GameObject("Terrain Placement Preview", typeof(SpriteRenderer))
                {
                    hideFlags = HideFlags.HideAndDontSave,
                };
                previewRenderer = previewObject.GetComponent<SpriteRenderer>();
                previewRenderer.spriteSortPoint = SpriteSortPoint.Pivot;
                previewRenderer.sortingOrder = short.MaxValue;
            }
            previewObject.SetActive(true);
            previewObject.transform.position = map.BaseTilemap.GetCellCenterWorld(origin);
            previewRenderer.sprite = sprite;
            previewRenderer.color = new Color(1f, 1f, 1f, 0.55f);
        }

        private void HidePreview()
        {
            if (previewObject != null) previewObject.SetActive(false);
        }

        private static void DrawCellPreview(GridLayout gridLayout, Vector3Int cell, bool painting)
        {
            var center = gridLayout.LocalToWorld(
                gridLayout.CellToLocalInterpolated(cell)
                + gridLayout.CellToLocalInterpolated(new Vector3(0.5f, 0.5f, 0f)));
            var right = gridLayout.transform.TransformVector(new Vector3(gridLayout.cellSize.x * 0.5f, 0f, 0f));
            var up = gridLayout.transform.TransformVector(new Vector3(0f, gridLayout.cellSize.y * 0.5f, 0f));
            var points = gridLayout.cellLayout == GridLayout.CellLayout.Rectangle
                ? new[]
                {
                    center - right - up,
                    center - right + up,
                    center + right + up,
                    center + right - up,
                }
                : new[]
                {
                    center - right,
                    center + up,
                    center + right,
                    center - up,
                };
            Handles.color = painting
                ? new Color(0.2f, 1f, 0.35f, 0.16f)
                : new Color(1f, 0.15f, 0.15f, 0.2f);
            Handles.DrawAAConvexPolygon(points);
            Handles.color = painting
                ? new Color(0.2f, 1f, 0.35f, 0.9f)
                : new Color(1f, 0.15f, 0.15f, 0.95f);
            Handles.DrawAAPolyLine(2f, points[0], points[1], points[2], points[3], points[0]);
        }

        public override void RegisterUndo(GameObject brushTarget, GridBrushBase.Tool tool)
        {
            if (!TerrainBlendBrush.TryGetMap(brushTarget, out var map)) return;
            var undoObjects = TerrainBlendBrush.GetTilemaps(map)
                .SelectMany(tilemap => new Object[] { tilemap, tilemap.gameObject })
                .Distinct()
                .ToArray();
            if (undoObjects.Length > 0) Undo.RegisterCompleteObjectUndo(undoObjects, $"Terrain Blend {tool}");
        }

        public override GameObject[] validTargets => StageUtility.GetCurrentStageHandle()
            .FindComponentsOfType<TerrainBlendMap>()
            .Where(item => item.gameObject.scene.isLoaded
                && item.gameObject.activeInHierarchy
                && !item.gameObject.hideFlags.HasFlag(HideFlags.NotEditable))
            .Select(item => item.gameObject)
            .ToArray();
    }
}
