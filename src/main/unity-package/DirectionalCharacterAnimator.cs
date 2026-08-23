using UnityEngine;

namespace TilemapGenerator.Characters
{
    [DisallowMultipleComponent]
    [RequireComponent(typeof(Animator))]
    public sealed class DirectionalCharacterAnimator : MonoBehaviour
    {
        private static readonly int DirectionX = Animator.StringToHash("DirectionX");
        private static readonly int DirectionY = Animator.StringToHash("DirectionY");
        private static readonly int Speed = Animator.StringToHash("Speed");
        private static readonly int IsMoving = Animator.StringToHash("IsMoving");

        [SerializeField] private CharacterDefinition definition;
        [SerializeField] private Animator targetAnimator;
        [SerializeField] private Vector2 lastVisualDirection = new(0f, -1f);

        public CharacterDefinition Definition => definition;

        private void Awake()
        {
            if (targetAnimator == null) targetAnimator = GetComponent<Animator>();
            ApplyDirection(lastVisualDirection);
        }

        public void ConfigureGenerated(CharacterDefinition nextDefinition, Vector2 defaultVisualDirection)
        {
            definition = nextDefinition;
            targetAnimator = GetComponent<Animator>();
            lastVisualDirection = defaultVisualDirection.sqrMagnitude > 0f
                ? defaultVisualDirection.normalized
                : Vector2.down;
            ApplyDirection(lastVisualDirection);
            targetAnimator.SetFloat(Speed, 0f);
            targetAnimator.SetBool(IsMoving, false);
        }

        /// <summary>
        /// Selects animation only. Call this from the game's movement code with
        /// a visual/screen-space movement direction; this component never moves
        /// the transform or applies physics.
        /// </summary>
        public void SetMovement(Vector2 visualDirection, float speed)
        {
            if (targetAnimator == null) targetAnimator = GetComponent<Animator>();
            if (visualDirection.sqrMagnitude > 0.0001f)
            {
                lastVisualDirection = visualDirection.normalized;
                ApplyDirection(lastVisualDirection);
            }
            var normalizedSpeed = Mathf.Max(0f, speed);
            targetAnimator.SetFloat(Speed, normalizedSpeed);
            targetAnimator.SetBool(IsMoving, normalizedSpeed > 0.01f);
        }

        public void SetIdle()
        {
            if (targetAnimator == null) targetAnimator = GetComponent<Animator>();
            targetAnimator.SetFloat(Speed, 0f);
            targetAnimator.SetBool(IsMoving, false);
        }

        private void ApplyDirection(Vector2 value)
        {
            if (targetAnimator == null) return;
            targetAnimator.SetFloat(DirectionX, value.x);
            // Manifest screen-space Y grows downwards; Animator/Unity Y grows upwards.
            targetAnimator.SetFloat(DirectionY, -value.y);
        }
    }
}
