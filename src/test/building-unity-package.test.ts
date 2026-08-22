import { expect, it } from 'vitest';
import buildingPlacementBrushSource from '../main/unity-package/BuildingPlacementBrush.cs?raw';

it('czy\u015bci wyb\u00f3r budynku po wskazaniu pustej kom\u00f3rki palety', () => {
  expect(buildingPlacementBrushSource).toContain(
    'SelectBuilding(paletteTilemap.GetTile(position.position) as BuildingDefinition);',
  );
  expect(buildingPlacementBrushSource).toContain('if (selected == building) return;');
  expect(buildingPlacementBrushSource).not.toContain(
    'if (selected == null || selected == building) return;',
  );
});
