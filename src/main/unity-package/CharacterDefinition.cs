using System;
using System.Collections.Generic;
using UnityEngine;

namespace TilemapGenerator.Characters
{
    [Serializable]
    public sealed class CharacterDirectionalAnimation
    {
        [SerializeField] private string directionId;
        [SerializeField] private Vector2 screenDirection;
        [SerializeField] private Vector2Int gridDirection;
        [SerializeField] private AnimationClip idleClip;
        [SerializeField] private AnimationClip walkClip;

        public string DirectionId => directionId;
        public Vector2 ScreenDirection => screenDirection;
        public Vector2Int GridDirection => gridDirection;
        public AnimationClip IdleClip => idleClip;
        public AnimationClip WalkClip => walkClip;

        public void ConfigureGenerated(
            string nextDirectionId,
            Vector2 nextScreenDirection,
            Vector2Int nextGridDirection,
            AnimationClip nextIdleClip,
            AnimationClip nextWalkClip)
        {
            directionId = nextDirectionId;
            screenDirection = nextScreenDirection;
            gridDirection = nextGridDirection;
            idleClip = nextIdleClip;
            walkClip = nextWalkClip;
        }
    }

    [CreateAssetMenu(menuName = "Tilemap Generator/Character Definition")]
    public sealed class CharacterDefinition : ScriptableObject
    {
        [SerializeField] private string assetId;
        [SerializeField] private string versionId;
        [SerializeField] private string displayName;
        [SerializeField] private string projection;
        [SerializeField] private Vector2 pivotNormalized;
        [SerializeField] private Texture2D sheet;
        [SerializeField] private RuntimeAnimatorController animatorController;
        [SerializeField] private GameObject generatedPrefab;
        [SerializeField] private List<CharacterDirectionalAnimation> directions = new();

        public string AssetId => assetId;
        public string VersionId => versionId;
        public string DisplayName => displayName;
        public string Projection => projection;
        public Vector2 PivotNormalized => pivotNormalized;
        public Texture2D Sheet => sheet;
        public RuntimeAnimatorController AnimatorController => animatorController;
        public GameObject GeneratedPrefab => generatedPrefab;
        public IReadOnlyList<CharacterDirectionalAnimation> Directions => directions;

        public void ConfigureGenerated(
            string nextAssetId,
            string nextVersionId,
            string nextDisplayName,
            string nextProjection,
            Vector2 nextPivot,
            Texture2D nextSheet,
            RuntimeAnimatorController nextController,
            IEnumerable<CharacterDirectionalAnimation> nextDirections)
        {
            assetId = nextAssetId;
            versionId = nextVersionId;
            displayName = nextDisplayName;
            projection = nextProjection;
            pivotNormalized = nextPivot;
            sheet = nextSheet;
            animatorController = nextController;
            directions = new List<CharacterDirectionalAnimation>(nextDirections);
        }

        public void SetGeneratedPrefab(GameObject value)
        {
            generatedPrefab = value;
        }
    }
}
