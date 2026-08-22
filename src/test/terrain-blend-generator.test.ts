import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { ensureTerrainBlendAtlas } from '../main/services/terrain-blend-generator';
import { normalizeTerrainBlendMask, terrainBlendVariantMasks } from '../shared/domain';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

it('redukuje 256 masek sąsiedztwa do kanonicznych 47 blob variants', () => {
  expect(terrainBlendVariantMasks).toHaveLength(47);
  expect(terrainBlendVariantMasks[0]).toBe(0);
  expect(terrainBlendVariantMasks.at(-1)).toBe(255);
  expect(normalizeTerrainBlendMask(2)).toBe(0);
  expect(normalizeTerrainBlendMask(7)).toBe(7);
  expect(normalizeTerrainBlendMask(255)).toBe(255);
});

it('generuje top-only atlas 8x6 i zachowuje pivot elevated tile', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'terrain-blend-atlas-'));
  directories.push(directory);
  const sourcePath = path.join(directory, 'elevated.png');
  const top = Buffer.from('<svg width="64" height="32"><polygon points="32,0 64,16 32,32 0,16" fill="#7aaa42"/></svg>');
  const walls = Buffer.from('<svg width="64" height="64"><polygon points="0,16 32,32 32,64 0,48" fill="#5b3a20"/><polygon points="64,16 32,32 32,64 64,48" fill="#7a4d2a"/></svg>');
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: walls }, { input: top, top: 0, left: 0 }]).png().toFile(sourcePath);

  const result = await ensureTerrainBlendAtlas({ sourcePath, tileWidthPx: 64, tileHeightPx: 32 });
  const metadata = await sharp(result.atlasPath).metadata();
  const wallMetadata = await sharp(result.wallPath).metadata();
  expect(metadata.width).toBe(512);
  expect(metadata.height).toBe(384);
  expect(wallMetadata.width).toBe(64);
  expect(wallMetadata.height).toBe(64);
  expect(result.manifest.variants).toHaveLength(47);
  expect(result.manifest).toMatchObject({ schemaVersion: 7, projection: 'isometric' });
  expect(result.manifest.pivotNormalized).toEqual({ x: 0.5, y: 0.75 });
  expect(result.manifest.variants[0].rect).toEqual({ x: 0, y: 320, width: 64, height: 64 });

  const atlas = await sharp(result.atlasPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const wallPixelOffset = (((48 * atlas.info.width) + 32) * 4) + 3;
  expect(atlas.data[wallPixelOffset]).toBe(0);

  const solidVariant = result.manifest.variants.find((variant) => variant.mask === 255)!;
  const emptyVariant = result.manifest.variants.find((variant) => variant.mask === 0)!;
  const rawTop = (variant: typeof solidVariant) => result.manifest.atlasHeightPx
    - variant.rect.y - variant.rect.height;
  const alphaAt = (variant: typeof solidVariant, x: number, y: number) => atlas.data[
    ((((rawTop(variant) + y) * atlas.info.width) + variant.rect.x + x) * 4) + 3
  ];
  const rgbaAt = (variant: typeof solidVariant, x: number, y: number) => {
    const offset = (((rawTop(variant) + y) * atlas.info.width) + variant.rect.x + x) * 4;
    return [...atlas.data.subarray(offset, offset + 4)];
  };
  expect(alphaAt(solidVariant, 29, 0)).toBe(255);
  expect(rgbaAt(solidVariant, 29, 0)).toEqual([122, 170, 66, 255]);
  expect(alphaAt(emptyVariant, 29, 0)).toBe(0);
  expect(alphaAt(solidVariant, 32, 31)).toBe(255);
  expect(alphaAt(solidVariant, 32, 32)).toBe(0);
  expect(alphaAt(emptyVariant, 32, 32)).toBe(0);

  const wall = await sharp(result.wallPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(wall.data[(((16 * wall.info.width) + 32) * 4) + 3]).toBe(0);
  expect(wall.data[(((48 * wall.info.width) + 16) * 4) + 3]).toBeGreaterThan(0);

  const cached = await ensureTerrainBlendAtlas({ sourcePath, tileWidthPx: 64, tileHeightPx: 32 });
  expect(readFileSync(cached.atlasPath).equals(readFileSync(result.atlasPath))).toBe(true);
  expect(readFileSync(cached.wallPath).equals(readFileSync(result.wallPath))).toBe(true);
});

it('generuje prostokątny blob47 dla kwadratowego terenu top-down bez ścian', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'terrain-blend-top-down-'));
  directories.push(directory);
  const sourcePath = path.join(directory, 'grass.png');
  await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 64, g: 128, b: 48, alpha: 1 },
    },
  }).png().toFile(sourcePath);

  const result = await ensureTerrainBlendAtlas({
    sourcePath,
    tileWidthPx: 32,
    tileHeightPx: 32,
    projection: 'top_down',
  });
  expect(result.manifest).toMatchObject({
    schemaVersion: 7,
    projection: 'top_down',
    atlasWidthPx: 256,
    atlasHeightPx: 192,
    spriteWidthPx: 32,
    spriteHeightPx: 32,
    surfaceHeightPx: 32,
    pivotNormalized: { x: 0.5, y: 0.5 },
  });

  const atlas = await sharp(result.atlasPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const solidVariant = result.manifest.variants.find((variant) => variant.mask === 255)!;
  const emptyVariant = result.manifest.variants.find((variant) => variant.mask === 0)!;
  const rawTop = (variant: typeof solidVariant) => result.manifest.atlasHeightPx
    - variant.rect.y - variant.rect.height;
  const alphaAt = (variant: typeof solidVariant, x: number, y: number) => atlas.data[
    ((((rawTop(variant) + y) * atlas.info.width) + variant.rect.x + x) * 4) + 3
  ];
  expect(alphaAt(solidVariant, 0, 0)).toBe(255);
  expect(alphaAt(solidVariant, 31, 31)).toBe(255);
  expect(alphaAt(emptyVariant, 0, 0)).toBeLessThan(10);
  expect(alphaAt(emptyVariant, 16, 16)).toBe(255);

  const walls = await sharp(result.wallPath).ensureAlpha().raw().toBuffer();
  expect(walls.every((channel) => channel === 0)).toBe(true);

  const elevatedPath = path.join(directory, 'elevated.png');
  await sharp({
    create: {
      width: 32,
      height: 64,
      channels: 4,
      background: { r: 64, g: 128, b: 48, alpha: 1 },
    },
  }).png().toFile(elevatedPath);
  await expect(ensureTerrainBlendAtlas({
    sourcePath: elevatedPath,
    tileWidthPx: 32,
    tileHeightPx: 32,
    projection: 'top_down',
  })).rejects.toThrow(/kwadratowy canvas/);
});
