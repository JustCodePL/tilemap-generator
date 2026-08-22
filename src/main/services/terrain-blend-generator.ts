import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { terrainBlendVariantMasks } from '../../shared/domain';

const schemaVersion = 6;
const atlasColumns = 8;
const atlasRows = 6;
const blendWidthNormalized = 0.22;
const seamPaddingPixels = 2;
const opaqueSurfaceAlphaThreshold = 240;

export interface TerrainBlendVariantManifest {
  mask: number;
  spriteName: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface TerrainBlendAtlasManifest {
  schemaVersion: number;
  mode: 'blob47_top_overlay';
  sourceSha256: string;
  columns: number;
  rows: number;
  atlasWidthPx: number;
  atlasHeightPx: number;
  spriteWidthPx: number;
  spriteHeightPx: number;
  surfaceHeightPx: number;
  blendWidthNormalized: number;
  pivotNormalized: { x: number; y: number };
  variants: TerrainBlendVariantManifest[];
}

export interface TerrainBlendAtlasResult {
  atlasPath: string;
  wallPath: string;
  cacheManifestPath: string;
  manifest: TerrainBlendAtlasManifest;
}

export async function ensureTerrainBlendAtlas(input: {
  sourcePath: string;
  tileWidthPx: number;
  tileHeightPx: number;
}): Promise<TerrainBlendAtlasResult> {
  const source = await sharp(input.sourcePath, { failOn: 'error' }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  if (source.info.width !== input.tileWidthPx) {
    throw new Error(`Teren ${input.sourcePath} ma szerokość ${source.info.width}px zamiast ${input.tileWidthPx}px.`);
  }
  if (source.info.height < input.tileHeightPx) {
    throw new Error(`Teren ${input.sourcePath} jest niższy niż górna płaszczyzna ${input.tileHeightPx}px.`);
  }

  const derivedDirectory = path.join(path.dirname(input.sourcePath), 'derived');
  const atlasPath = path.join(derivedDirectory, `terrain-blend-v${schemaVersion}.png`);
  const wallPath = path.join(derivedDirectory, `terrain-walls-v${schemaVersion}.png`);
  const cacheManifestPath = path.join(derivedDirectory, `terrain-blend-v${schemaVersion}.json`);
  const sourceSha256 = createHash('sha256').update(readFileSync(input.sourcePath)).digest('hex');
  const manifest = buildManifest(
    sourceSha256,
    source.info.width,
    source.info.height,
    input.tileHeightPx,
  );

  if (existsSync(atlasPath) && existsSync(wallPath) && cacheManifestMatches(cacheManifestPath, manifest)) {
    return { atlasPath, wallPath, cacheManifestPath, manifest };
  }

  mkdirSync(derivedDirectory, { recursive: true });
  const atlas = buildAtlas(source.data, source.info.width, source.info.height, input.tileHeightPx);
  const temporaryAtlas = `${atlasPath}.tmp`;
  await sharp(atlas, {
    raw: {
      width: manifest.atlasWidthPx,
      height: manifest.atlasHeightPx,
      channels: 4,
    },
  }).png({ compressionLevel: 9 }).toFile(temporaryAtlas);
  renameSync(temporaryAtlas, atlasPath);

  const walls = buildWallSprite(source.data, source.info.width, source.info.height, input.tileHeightPx);
  const temporaryWall = `${wallPath}.tmp`;
  await sharp(walls, {
    raw: {
      width: source.info.width,
      height: source.info.height,
      channels: 4,
    },
  }).png({ compressionLevel: 9 }).toFile(temporaryWall);
  renameSync(temporaryWall, wallPath);

  const temporaryManifest = `${cacheManifestPath}.tmp`;
  writeFileSync(temporaryManifest, JSON.stringify(manifest, null, 2), 'utf8');
  renameSync(temporaryManifest, cacheManifestPath);
  return { atlasPath, wallPath, cacheManifestPath, manifest };
}

function buildManifest(
  sourceSha256: string,
  spriteWidthPx: number,
  spriteHeightPx: number,
  surfaceHeightPx: number,
): TerrainBlendAtlasManifest {
  const atlasWidthPx = spriteWidthPx * atlasColumns;
  const atlasHeightPx = spriteHeightPx * atlasRows;
  const variants = terrainBlendVariantMasks.map((mask, index) => {
    const column = index % atlasColumns;
    const rowFromTop = Math.floor(index / atlasColumns);
    return {
      mask,
      spriteName: `blend-${mask.toString().padStart(3, '0')}`,
      rect: {
        x: column * spriteWidthPx,
        y: atlasHeightPx - ((rowFromTop + 1) * spriteHeightPx),
        width: spriteWidthPx,
        height: spriteHeightPx,
      },
    };
  });
  return {
    schemaVersion,
    mode: 'blob47_top_overlay',
    sourceSha256,
    columns: atlasColumns,
    rows: atlasRows,
    atlasWidthPx,
    atlasHeightPx,
    spriteWidthPx,
    spriteHeightPx,
    surfaceHeightPx,
    blendWidthNormalized,
    pivotNormalized: {
      x: 0.5,
      y: 1 - ((surfaceHeightPx / 2) / spriteHeightPx),
    },
    variants,
  };
}

function cacheManifestMatches(cacheManifestPath: string, expected: TerrainBlendAtlasManifest): boolean {
  if (!existsSync(cacheManifestPath)) return false;
  try {
    const actual = JSON.parse(readFileSync(cacheManifestPath, 'utf8')) as TerrainBlendAtlasManifest;
    return actual.schemaVersion === expected.schemaVersion
      && actual.sourceSha256 === expected.sourceSha256
      && actual.spriteWidthPx === expected.spriteWidthPx
      && actual.spriteHeightPx === expected.spriteHeightPx
      && actual.surfaceHeightPx === expected.surfaceHeightPx
      && actual.blendWidthNormalized === expected.blendWidthNormalized
      && actual.variants?.length === terrainBlendVariantMasks.length;
  } catch {
    return false;
  }
}

function buildAtlas(source: Buffer, width: number, height: number, surfaceHeight: number): Buffer {
  const atlasWidth = width * atlasColumns;
  const atlasHeight = height * atlasRows;
  const atlas = Buffer.alloc(atlasWidth * atlasHeight * 4);
  const seamTolerance = seamPaddingPixels / Math.min(width, surfaceHeight);

  terrainBlendVariantMasks.forEach((mask, index) => {
    const column = index % atlasColumns;
    const row = Math.floor(index / atlasColumns);
    // The seam fringe may extend across the diagonal outline, but never below the
    // top-face canvas. Pixels below surfaceHeight belong to the elevated tile walls;
    // filling them with the top texture creates coloured spikes over adjacent walls.
    const renderHeight = Math.min(height, surfaceHeight);
    for (let y = 0; y < renderHeight; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const diamondX = (x + 0.5) / width;
        const diamondY = (y + 0.5) / surfaceHeight;
        const u = diamondY + diamondX - 0.5;
        const v = diamondY - diamondX + 0.5;
        // Equal terrain cells meet on a sub-pixel diagonal in Scene View. Extending only
        // connected edges by a few source pixels prevents the lower layer from leaking
        // through when the Tilemap is rendered at a non-integer zoom level.
        if (u < -seamTolerance || u > 1 + seamTolerance
          || v < -seamTolerance || v > 1 + seamTolerance) continue;

        const sourceOffset = findSurfacePixel(source, width, surfaceHeight, x, y);
        if (sourceOffset < 0) continue;
        const atlasX = (column * width) + x;
        const atlasY = (row * height) + y;
        const atlasOffset = ((atlasY * atlasWidth) + atlasX) * 4;
        const maskAlpha = terrainMaskAlpha(u, v, mask);
        atlas[atlasOffset] = source[sourceOffset];
        atlas[atlasOffset + 1] = source[sourceOffset + 1];
        atlas[atlasOffset + 2] = source[sourceOffset + 2];
        // A terrain surface is opaque by contract. Keeping the antialiased source alpha here
        // creates hairline gaps between adjacent sprites and exposes the lowest terrain layer.
        atlas[atlasOffset + 3] = Math.round(255 * maskAlpha);
      }
    }
  });
  return atlas;
}

function buildWallSprite(source: Buffer, width: number, height: number, surfaceHeight: number): Buffer {
  const walls = Buffer.from(source);
  const tolerance = 2 / Math.min(width, surfaceHeight);
  for (let y = 0; y < Math.min(surfaceHeight, height); y += 1) {
    for (let x = 0; x < width; x += 1) {
      const diamondX = (x + 0.5) / width;
      const diamondY = (y + 0.5) / surfaceHeight;
      const u = diamondY + diamondX - 0.5;
      const v = diamondY - diamondX + 0.5;
      if (u < -tolerance || u > 1 + tolerance || v < -tolerance || v > 1 + tolerance) continue;
      walls[((y * width) + x) * 4 + 3] = 0;
    }
  }
  return walls;
}

function findSurfacePixel(
  source: Buffer,
  width: number,
  surfaceHeight: number,
  x: number,
  y: number,
): number {
  const direct = ((y * width) + x) * 4;
  if (source[direct + 3] >= opaqueSurfaceAlphaThreshold) return direct;

  // Generated terrain tops are opaque. Do not promote a semi-transparent antialias
  // pixel to full opacity: its fringe RGB is visibly darker once made opaque. Copy
  // colour from the nearest solid surface pixel instead.
  const searchRadius = seamPaddingPixels * 2;
  let bestOffset = source[direct + 3] > 0 ? direct : -1;
  let bestAlpha = bestOffset >= 0 ? source[direct + 3] : 0;
  for (let radius = 1; radius <= searchRadius; radius += 1) {
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        if (Math.abs(offsetX) !== radius && Math.abs(offsetY) !== radius) continue;
        const sampleX = x + offsetX;
        const sampleY = y + offsetY;
        if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= surfaceHeight) continue;
        const sample = ((sampleY * width) + sampleX) * 4;
        const sampleAlpha = source[sample + 3];
        if (sampleAlpha >= opaqueSurfaceAlphaThreshold) return sample;
        if (sampleAlpha > bestAlpha) {
          bestOffset = sample;
          bestAlpha = sampleAlpha;
        }
      }
    }
  }
  return bestOffset;
}

function terrainMaskAlpha(u: number, v: number, mask: number): number {
  let alpha = 1;
  alpha = Math.min(alpha, edgeAlpha(u, v, mask, 1, 0));
  alpha = Math.min(alpha, edgeAlpha(v, u, mask, 4, 1.7));
  alpha = Math.min(alpha, edgeAlpha(1 - u, 1 - v, mask, 16, 3.1));
  alpha = Math.min(alpha, edgeAlpha(1 - v, 1 - u, mask, 64, 4.6));

  alpha = Math.min(alpha, cornerAlpha(u, v, mask, 2, 1, 4));
  alpha = Math.min(alpha, cornerAlpha(1 - u, v, mask, 8, 4, 16));
  alpha = Math.min(alpha, cornerAlpha(1 - u, 1 - v, mask, 32, 16, 64));
  alpha = Math.min(alpha, cornerAlpha(u, 1 - v, mask, 128, 64, 1));
  return alpha;
}

function edgeAlpha(distance: number, along: number, mask: number, bit: number, phase: number): number {
  if ((mask & bit) !== 0) return 1;
  const width = noisyBlendWidth(along, phase);
  return smoothstep(0, width, distance);
}

function cornerAlpha(
  horizontalDistance: number,
  verticalDistance: number,
  mask: number,
  cornerBit: number,
  firstEdgeBit: number,
  secondEdgeBit: number,
): number {
  const adjacentEdgesPresent = (mask & firstEdgeBit) !== 0 && (mask & secondEdgeBit) !== 0;
  if (!adjacentEdgesPresent || (mask & cornerBit) !== 0) return 1;
  const distance = Math.hypot(horizontalDistance, verticalDistance);
  return smoothstep(0, blendWidthNormalized * 1.35, distance);
}

function noisyBlendWidth(along: number, phase: number): number {
  const first = Math.sin((along * Math.PI * 6) + phase) * 0.12;
  const second = Math.sin((along * Math.PI * 14) + (phase * 0.73)) * 0.05;
  return blendWidthNormalized * (1 + first + second);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const normalized = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return normalized * normalized * (3 - (2 * normalized));
}
