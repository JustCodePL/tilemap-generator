using UnityEngine;
using UnityEngine.Tilemaps;

namespace TilemapGenerator.TerrainBlend
{
    [CreateAssetMenu(menuName = "Tilemap Generator/Terrain Blend Rule Tile")]
    public sealed class TerrainBlendRuleTile : IsometricRuleTile
    {
        public override bool RuleMatch(int neighbor, TileBase other)
        {
            if (other is TerrainBlendSupportTile) other = this;
            return base.RuleMatch(neighbor, other);
        }
    }
}
