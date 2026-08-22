import { expect, it } from 'vitest';
import {
  assetPixelSize,
  createProjectSchema,
  defaultAssetSizing,
  enqueueGenerationSchema,
  exportIntegrationSchema,
  exportIntegrations,
  exportPreviewSchema,
  normalizeTerrainBlendMask,
  roadCanonicalVariantMasks,
  roadConnectionDirectionsForProjection,
  roadVariantLabel,
  roadVariantMasks,
  terrainBlendVariantMasks,
  tileHeightForProjection,
  updateProjectSettingsSchema,
} from '../shared/domain';

it('definiuje neutralny kontrakt integracji eksportu', () => {
  expect(exportIntegrations).toEqual(['unity']);
  expect(exportIntegrationSchema.parse('unity')).toBe('unity');
  expect(exportPreviewSchema.parse({
    integration: 'unity',
    targetDirectory: '  /game/Assets/TilemapGenerator  ',
    assetIds: ['11111111-1111-4111-8111-111111111111'],
  })).toEqual({
    integration: 'unity',
    targetDirectory: '/game/Assets/TilemapGenerator',
    assetIds: ['11111111-1111-4111-8111-111111111111'],
  });
  expect(() => exportPreviewSchema.parse({
    integration: 'phaserjs',
    targetDirectory: '/game/public/assets',
  })).toThrow();
  expect(() => exportPreviewSchema.parse({
    targetAssetsDirectory: '/legacy/Assets',
  })).toThrow();
});

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

it('normalizuje projekcję projektu i wylicza wysokość siatki 2:1 lub 1:1', () => {
  expect(createProjectSchema.parse({ name: 'Stary projekt' }).projection).toBe('isometric');
  expect(createProjectSchema.parse({
    name: 'Widok z góry', projection: 'top_down', tileWidthPx: 255,
  })).toMatchObject({ projection: 'top_down', tileWidthPx: 255 });
  expect(() => createProjectSchema.parse({
    name: 'Krzywy romb', projection: 'isometric', tileWidthPx: 255,
  })).toThrow(/parzysta/);
  expect(tileHeightForProjection('isometric', 256)).toBe(128);
  expect(tileHeightForProjection('top_down', 256)).toBe(256);
  const update = updateProjectSettingsSchema.parse({
    name: 'Widok z góry',
    artBrief: '',
    projection: 'isometric',
    tileWidthPx: 255,
    pixelsPerUnit: 255,
    maxConcurrentJobs: 1,
    aiVerificationEnabled: true,
  });
  expect(update.tileWidthPx).toBe(255);
  expect(update).not.toHaveProperty('projection');
});

it('definiuje kompletny zestaw 16 wariantów road tile', () => {
  expect(roadVariantMasks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  expect(roadCanonicalVariantMasks).toEqual([0, 1, 3, 5, 6, 7, 15]);
  expect(roadVariantMasks.filter((mask) => roadVariantLabel(mask).startsWith('T ·'))).toEqual([7, 11, 13, 14]);
  expect(roadVariantLabel(1)).toBe('Koniec · NW');
  expect(roadVariantLabel(15)).toBe('Skrzyżowanie');
});

it('mapuje road tile top-down na kierunki N/E/S/W', () => {
  expect(roadConnectionDirectionsForProjection('top_down')).toEqual([
    { id: 'north', bit: 1, shortLabel: 'N', x: 0.5, y: 0 },
    { id: 'east', bit: 2, shortLabel: 'E', x: 1, y: 0.5 },
    { id: 'south', bit: 4, shortLabel: 'S', x: 0.5, y: 1 },
    { id: 'west', bit: 8, shortLabel: 'W', x: 0, y: 0.5 },
  ]);
  expect(roadVariantLabel(1, 'top_down')).toBe('Koniec · N');
  expect(roadVariantLabel(5, 'top_down')).toBe('Prosta · N–S');
  expect(roadVariantLabel(10, 'top_down')).toBe('Prosta · E–W');
  expect(roadVariantLabel(7, 'top_down')).toBe('T · N–E–S');
});

it('definiuje kanoniczny zestaw 47 wariantów terrain blend', () => {
  expect(terrainBlendVariantMasks).toHaveLength(47);
  expect(new Set(terrainBlendVariantMasks).size).toBe(47);
  expect(normalizeTerrainBlendMask(255)).toBe(255);
  expect(normalizeTerrainBlendMask(2 | 4)).toBe(4);
  expect(normalizeTerrainBlendMask(1 | 2 | 4)).toBe(7);
});
