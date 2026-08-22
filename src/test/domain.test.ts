import { expect, it } from 'vitest';
import {
  assetPixelSize,
  defaultAssetSizing,
  enqueueGenerationSchema,
  normalizeTerrainBlendMask,
  roadCanonicalVariantMasks,
  roadVariantLabel,
  roadVariantMasks,
  terrainBlendVariantMasks,
} from '../shared/domain';

it('normalizuje brak opcjonalnego promptu do pustego tekstu', () => {
  const input = enqueueGenerationSchema.parse({ name: 'Kamienna droga' });

  expect(input.prompt).toBe('');
});

it('wylicza względne canvasy względem bazowego tile 2:1', () => {
  const project = { tileWidthPx: 256, tileHeightPx: 128 };
  const building = defaultAssetSizing('building');
  const character = defaultAssetSizing('character');

  expect(building).toEqual({ elevationLevels: 0, relativeWidth: 1, relativeHeight: 2 });
  expect(assetPixelSize(project, { category: 'building', ...building })).toEqual({ width: 256, height: 256 });
  expect(character).toEqual({ elevationLevels: 0, relativeWidth: 0.5, relativeHeight: 1.5 });
  expect(assetPixelSize(project, { category: 'character', ...character })).toEqual({ width: 128, height: 192 });
  expect(assetPixelSize(project, {
    category: 'elevated_tile', elevationLevels: 3, relativeWidth: 1, relativeHeight: 1,
  })).toEqual({ width: 256, height: 512 });
  expect(assetPixelSize(project, {
    category: 'road_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1,
  })).toEqual({ width: 256, height: 128 });
});

it('definiuje kompletny zestaw 16 wariantów road tile', () => {
  expect(roadVariantMasks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  expect(roadCanonicalVariantMasks).toEqual([0, 1, 3, 5, 6, 7, 15]);
  expect(roadVariantMasks.filter((mask) => roadVariantLabel(mask).startsWith('T ·'))).toEqual([7, 11, 13, 14]);
  expect(roadVariantLabel(1)).toBe('Koniec · NW');
  expect(roadVariantLabel(15)).toBe('Skrzyżowanie');
});

it('definiuje kanoniczny zestaw 47 wariantów terrain blend', () => {
  expect(terrainBlendVariantMasks).toHaveLength(47);
  expect(new Set(terrainBlendVariantMasks).size).toBe(47);
  expect(normalizeTerrainBlendMask(255)).toBe(255);
  expect(normalizeTerrainBlendMask(2 | 4)).toBe(4);
  expect(normalizeTerrainBlendMask(1 | 2 | 4)).toBe(7);
});
