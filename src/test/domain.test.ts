import { expect, it } from 'vitest';
import {
  assetPixelSize,
  characterAnimationFrameSize,
  characterAnimationSettingsSchema,
  characterAnimationSheetSize,
  characterDirectionsForProjection,
  createProjectSchema,
  defaultCharacterAnimationSettings,
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
  expect(exportIntegrations).toEqual(['unity', 'phaser']);
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

it('waliduje niepusty zestaw generatorów wybrany dla nowego assetu', () => {
  expect(enqueueGenerationSchema.parse({
    name: 'Kamienna droga',
    generatorProviders: ['stable_diffusion_cpp', 'codex'],
  }).generatorProviders).toEqual(['codex', 'stable_diffusion_cpp']);
  expect(() => enqueueGenerationSchema.parse({
    name: 'Kamienna droga', generatorProviders: [],
  })).toThrow(/co najmniej jeden generator/);
  expect(() => enqueueGenerationSchema.parse({
    name: 'Kamienna droga', generatorProviders: ['codex', 'codex'],
  })).toThrow(/tylko raz/);
  expect(() => enqueueGenerationSchema.parse({
    name: 'Kamienna droga', generatorProvider: 'codex', generatorProviders: ['comfyui'],
  })).toThrow(/Nie można łączyć/);
  expect(() => enqueueGenerationSchema.parse({
    assetId: '11111111-1111-4111-8111-111111111111',
    name: 'Kamienna droga', generatorProviders: ['comfyui'],
  })).toThrow(/tylko dla nowego assetu/);
});

it('definiuje projektowy kontrakt kierunkowej animacji postaci', () => {
  expect(characterDirectionsForProjection('isometric').map((direction) => direction.id)).toEqual([
    'north_west', 'north_east', 'south_east', 'south_west',
  ]);
  expect(characterDirectionsForProjection('top_down').map((direction) => direction.id)).toEqual([
    'north', 'east', 'south', 'west',
  ]);
  expect(characterDirectionsForProjection('isometric').map((direction) => direction.gridDelta)).toEqual([
    { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 },
  ]);
  expect(characterDirectionsForProjection('top_down').map((direction) => direction.gridDelta)).toEqual([
    { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 },
  ]);
  expect(defaultCharacterAnimationSettings).toEqual({
    action: 'walk', framesPerDirection: 8, framesPerSecond: 8,
  });
  expect(characterAnimationSettingsSchema.parse({})).toEqual(defaultCharacterAnimationSettings);
  expect(characterAnimationSettingsSchema.parse({ framesPerDirection: 16, framesPerSecond: 24 })).toEqual({
    action: 'walk', framesPerDirection: 16, framesPerSecond: 24,
  });
  expect(characterAnimationSettingsSchema.parse({ framesPerDirection: 2 }).framesPerDirection).toBe(2);
  expect(() => characterAnimationSettingsSchema.parse({ framesPerDirection: 1 })).toThrow();
  expect(() => characterAnimationSettingsSchema.parse({ framesPerDirection: 17 })).toThrow();
  expect(() => characterAnimationSettingsSchema.parse({ framesPerDirection: 2.5 })).toThrow();
  expect(() => characterAnimationSettingsSchema.parse({ framesPerSecond: 25 })).toThrow();
});

it('wylicza klatkę i arkusz postaci jako idle plus projektowe klatki chodu w czterech kierunkach', () => {
  const project = { tileWidthPx: 256, tileHeightPx: 128 };
  const asset = { relativeWidth: 0.5, relativeHeight: 1.5 };
  expect(characterAnimationFrameSize(project, asset)).toEqual({ width: 128, height: 192 });
  expect(characterAnimationSheetSize(project, asset, defaultCharacterAnimationSettings)).toEqual({
    width: 1152,
    height: 768,
  });
  expect(characterAnimationSheetSize(
    { width: 128, height: 192 },
    defaultCharacterAnimationSettings,
  )).toEqual({ width: 1152, height: 768 });
});

it('odrzuca ustawienia animacji dla assetu innego niż postać', () => {
  expect(() => enqueueGenerationSchema.parse({
    name: 'Kamień',
    category: 'prop',
    characterAnimation: { action: 'walk', framesPerDirection: 8, framesPerSecond: 8 },
  })).toThrow(/tylko dla kategorii character/);
  expect(enqueueGenerationSchema.parse({
    name: 'Rycerz',
    category: 'character',
    characterAnimation: { action: 'walk', framesPerDirection: 6, framesPerSecond: 12 },
  }).characterAnimation).toEqual({ action: 'walk', framesPerDirection: 6, framesPerSecond: 12 });
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

it('normalizuje projekcję projektu, liczbę klatek postaci i wysokość siatki 2:1 lub 1:1', () => {
  expect(createProjectSchema.parse({ name: 'Stary projekt' })).toMatchObject({
    projection: 'isometric', characterFramesPerDirection: 8,
  });
  expect(createProjectSchema.parse({
    name: 'Widok z góry', projection: 'top_down', tileWidthPx: 255,
    characterFramesPerDirection: 16,
  })).toMatchObject({ projection: 'top_down', tileWidthPx: 255, characterFramesPerDirection: 16 });
  expect(() => createProjectSchema.parse({
    name: 'Za mało klatek', characterFramesPerDirection: 1,
  })).toThrow();
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
  expect(update.characterFramesPerDirection).toBe(8);
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
