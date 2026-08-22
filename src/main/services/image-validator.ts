import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  hasRoadConnection,
  roadCanonicalVariantMasks,
  roadConnectionDirections,
  roadVariantMasks,
} from '../../shared/domain';

export interface ValidatedImage {
  width: number;
  height: number;
  alphaMin: number;
  alphaMax: number;
}

export interface TerrainTileBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TerrainSeamValidation {
  passed: boolean;
  gapPixels: number;
  inspectedPixels: number;
  gapRatio: number;
  colorSeamPixels: number;
  colorInspectedPixels: number;
  colorSeamRatio: number;
  averageColorSeamScore: number;
  maxColorSeamScore: number;
}

export interface RoadTileValidation {
  visibleRatio: number;
  disconnectedRatio: number;
  connections: Array<{
    direction: string;
    expected: boolean;
    visibleRatio: number;
    boundaryRatio: number;
  }>;
}

const MAX_TERRAIN_GAP_RATIO = 0.001;
const MAX_TERRAIN_COLOR_SEAM_RATIO = 0.03;
const COLOR_SEAM_SCORE_THRESHOLD = 0.12;
const MAX_RGB_DISTANCE = Math.sqrt(3 * (255 ** 2));

const TERRAIN_PREVIEW_CELLS = Array.from({ length: 3 }, (_, row) => row - 1)
  .flatMap((y) => Array.from({ length: 3 }, (_, column) => ({ x: column - 1, y })))
  .sort((left, right) => (left.x + left.y) - (right.x + right.y) || left.x - right.x);

export async function validateTransparentPng(filePath: string): Promise<ValidatedImage> {
  const image = sharp(filePath, { failOn: 'error' });
  const metadata = await image.metadata();
  if (metadata.format !== 'png') throw new Error('Wynik nie jest plikiem PNG.');
  if (!metadata.width || !metadata.height) throw new Error('PNG nie zawiera poprawnych wymiarów.');
  if (!metadata.hasAlpha) throw new Error('PNG nie ma kanału alfa.');

  const stats = await image.stats();
  const alpha = stats.channels[3];
  if (!alpha || alpha.min >= 250) throw new Error('PNG nie zawiera przezroczystych pikseli.');
  if (alpha.max <= 5) throw new Error('PNG jest całkowicie przezroczysty.');

  const corners = [
    { left: 0, top: 0 },
    { left: metadata.width - 1, top: 0 },
    { left: 0, top: metadata.height - 1 },
    { left: metadata.width - 1, top: metadata.height - 1 },
  ];
  for (const corner of corners) {
    const pixel = await sharp(filePath).extract({ ...corner, width: 1, height: 1 }).ensureAlpha().raw().toBuffer();
    if (pixel[3] > 48) throw new Error('Co najmniej jeden narożnik PNG nie jest przezroczysty.');
  }
  return { width: metadata.width, height: metadata.height, alphaMin: alpha.min, alphaMax: alpha.max };
}

export async function validateTerrainTile(
  filePath: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<TerrainTileBounds> {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== expectedWidth || info.height !== expectedHeight) {
    throw new Error(
      `Tile terenu 1×1 musi mieć dokładnie ${expectedWidth}×${expectedHeight}px; otrzymano ${info.width}×${info.height}px.`,
    );
  }

  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3];
      if (alpha <= 24) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error('Tile terenu nie zawiera widocznych pikseli.');

  const widthCoverage = (right - left + 1) / info.width;
  const heightCoverage = (bottom - top + 1) / info.height;
  if (widthCoverage < 0.96 || heightCoverage < 0.96) {
    throw new Error(
      'Tile terenu nie wypełnia komórki: romb musi dochodzić do wszystkich czterech krawędzi canvasa bez zewnętrznego paddingu.',
    );
  }
  return { left, top, right, bottom };
}

export async function validateElevatedTerrainTile(
  filePath: string,
  expectedWidth: number,
  topDiamondHeight: number,
  wallHeight: number,
): Promise<TerrainTileBounds> {
  const expectedHeight = topDiamondHeight + wallHeight;
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== expectedWidth || info.height !== expectedHeight) {
    throw new Error(
      `Elevated tile terenu 1×1 musi mieć dokładnie ${expectedWidth}×${expectedHeight}px `
      + `(romb ${expectedWidth}×${topDiamondHeight}px + ściany ${wallHeight}px); otrzymano ${info.width}×${info.height}px.`,
    );
  }

  const bounds = alphaBounds(data, info.width, info.height, info.channels);
  const widthCoverage = (bounds.right - bounds.left + 1) / info.width;
  const heightCoverage = (bounds.bottom - bounds.top + 1) / info.height;
  if (widthCoverage < 0.96 || heightCoverage < 0.96) {
    throw new Error('Elevated tile nie wykorzystuje pełnego canvasa: romb musi sięgać lewej i prawej krawędzi, a ściany dolnej.');
  }

  let wallPixels = 0;
  let expectedTopPixels = 0;
  let missingTopPixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3];
      if (y >= topDiamondHeight && alpha > 24) wallPixels += 1;
      if (y >= topDiamondHeight) continue;
      const normalizedX = Math.abs((x + 0.5 - expectedWidth / 2) / (expectedWidth / 2));
      const normalizedY = Math.abs((y + 0.5 - topDiamondHeight / 2) / (topDiamondHeight / 2));
      if (normalizedX + normalizedY > 0.98) continue;
      expectedTopPixels += 1;
      if (alpha <= 24) missingTopPixels += 1;
    }
  }
  if (wallPixels < expectedWidth * wallHeight * 0.05) {
    throw new Error('Elevated tile nie zawiera wystarczająco widocznych pionowych ścian poniżej górnego rombu.');
  }
  if (expectedTopPixels === 0 || missingTopPixels / expectedTopPixels > 0.01) {
    throw new Error('Górny romb elevated tile zawiera przezroczyste ubytki.');
  }
  return bounds;
}

export async function validateRoadTile(
  filePath: string,
  expectedWidth: number,
  expectedHeight: number,
  connectionMask: number,
): Promise<RoadTileValidation> {
  if (!Number.isInteger(connectionMask) || connectionMask < 0 || connectionMask > 15) {
    throw new Error('Maska połączeń road tile musi być liczbą od 0 do 15.');
  }
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== expectedWidth || info.height !== expectedHeight) {
    throw new Error(
      `Road tile musi mieć dokładnie ${expectedWidth}×${expectedHeight}px; otrzymano ${info.width}×${info.height}px.`,
    );
  }

  const pixelCount = info.width * info.height;
  const visible = new Uint8Array(pixelCount);
  let visiblePixels = 0;
  let diamondPixels = 0;
  let outsideDiamondPixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = y * info.width + x;
      const alpha = data[index * info.channels + 3];
      const diamondDistance = isometricDiamondDistance(x, y, info.width, info.height);
      if (diamondDistance <= 1) diamondPixels += 1;
      if (alpha <= 48) continue;
      visible[index] = 1;
      visiblePixels += 1;
      if (diamondDistance > 1.04) outsideDiamondPixels += 1;
    }
  }

  const visibleRatio = diamondPixels ? visiblePixels / diamondPixels : 1;
  if (visibleRatio < 0.02) throw new Error('Road tile jest pusty albo droga jest zbyt mała, by połączyć komórki.');
  if (visibleRatio > 0.68) {
    throw new Error('Road tile wypełnia prawie cały romb jak teren. Poza pasem drogi musi pozostać przezroczysty.');
  }
  if (outsideDiamondPixels / pixelCount > 0.002) {
    throw new Error('Road tile zawiera widoczne piksele poza rombem komórki. Usuń cień, padding lub dekoracje wychodzące poza tile.');
  }

  const centerIndices = regionIndices(info.width, info.height, 0.5, 0.5, 0.09, 0.18)
    .filter((index) => visible[index]);
  if (!centerIndices.length) throw new Error('Droga nie przechodzi przez środek komórki.');
  const reachable = connectedPixels(visible, info.width, info.height, centerIndices[0]);
  let reachableCount = 0;
  for (let index = 0; index < visible.length; index += 1) {
    if (visible[index] && reachable[index]) reachableCount += 1;
  }
  const disconnectedRatio = visiblePixels ? (visiblePixels - reachableCount) / visiblePixels : 1;
  if (disconnectedRatio > 0.2) {
    throw new Error('Road tile zawiera odłączone elementy. Wszystkie odcinki drogi muszą tworzyć jedną sieć przez środek komórki.');
  }

  const connections = roadConnectionDirections.map((direction) => {
    const expected = hasRoadConnection(connectionMask, direction.bit);
    const region = regionIndices(info.width, info.height, direction.x, direction.y, 0.085, 0.17)
      .filter((index) => {
        const x = index % info.width;
        const y = Math.floor(index / info.width);
        return isometricDiamondDistance(x, y, info.width, info.height) <= 1.02;
      });
    const boundary = region.filter((index) => {
      const x = index % info.width;
      const y = Math.floor(index / info.width);
      return isometricDiamondDistance(x, y, info.width, info.height) >= 0.88;
    });
    const visibleInRegion = region.filter((index) => visible[index] && reachable[index]).length;
    const visibleAtBoundary = boundary.filter((index) => visible[index] && reachable[index]).length;
    const visibleRegionRatio = region.length ? visibleInRegion / region.length : 0;
    const boundaryRatio = boundary.length ? visibleAtBoundary / boundary.length : 0;
    if (expected && (visibleRegionRatio < 0.12 || boundaryRatio < 0.08)) {
      throw new Error(
        `Droga nie dochodzi do zadeklarowanej krawędzi ${direction.shortLabel} pełną szerokością.`,
      );
    }
    if (!expected && boundaryRatio > 0.04) {
      throw new Error(
        `Droga dochodzi do krawędzi ${direction.shortLabel}, która nie jest zaznaczona jako połączenie.`,
      );
    }
    return { direction: direction.id, expected, visibleRatio: visibleRegionRatio, boundaryRatio };
  });

  return { visibleRatio, disconnectedRatio, connections };
}

export async function verifyTerrainSeams(
  filePath: string,
  previewPath: string,
  gridWidth?: number,
  gridHeight?: number,
): Promise<TerrainSeamValidation> {
  const metadata = await sharp(filePath).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Nie można odczytać wymiarów tile terenu.');
  const tileWidth = gridWidth ?? metadata.width;
  const tileHeight = gridHeight ?? metadata.height;
  if (metadata.width !== tileWidth || metadata.height < tileHeight) {
    throw new Error('Canvas tile nie jest zgodny z wymiarami komórki siatki projektu.');
  }
  const spriteHeight = metadata.height;
  const patchWidth = tileWidth * 3;
  const patchHeight = tileHeight * 3 + (spriteHeight - tileHeight);
  const placements = TERRAIN_PREVIEW_CELLS.map(({ x, y }) => ({
    input: filePath,
    left: Math.round(tileWidth + ((x - y) * tileWidth) / 2),
    top: Math.round(tileHeight + ((x + y) * tileHeight) / 2),
  }));

  const transparentPatch = sharp({
    create: { width: patchWidth, height: patchHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(placements);
  const { data, info } = await transparentPatch.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  await sharp({
    create: { width: patchWidth, height: patchHeight, channels: 4, background: { r: 240, g: 45, b: 167, alpha: 1 } },
  }).composite(placements).png().toFile(previewPath);

  const expected = new Uint8Array(patchWidth * patchHeight);
  for (const placement of placements) {
    for (let localY = 0; localY < tileHeight; localY += 1) {
      const normalizedY = Math.abs((localY + 0.5 - tileHeight / 2) / (tileHeight / 2));
      for (let localX = 0; localX < tileWidth; localX += 1) {
        const normalizedX = Math.abs((localX + 0.5 - tileWidth / 2) / (tileWidth / 2));
        if (normalizedX + normalizedY > 1) continue;
        const x = placement.left + localX;
        const y = placement.top + localY;
        if (x >= 0 && x < patchWidth && y >= 0 && y < patchHeight) expected[y * patchWidth + x] = 1;
      }
    }
  }

  let inspectedPixels = 0;
  let gapPixels = 0;
  for (let y = 1; y < patchHeight - 1; y += 1) {
    for (let x = 1; x < patchWidth - 1; x += 1) {
      const index = y * patchWidth + x;
      if (!expected[index]
        || !expected[index - 1]
        || !expected[index + 1]
        || !expected[index - patchWidth]
        || !expected[index + patchWidth]) continue;
      inspectedPixels += 1;
      if (data[index * info.channels + 3] <= 48) gapPixels += 1;
    }
  }

  const gapRatio = inspectedPixels ? gapPixels / inspectedPixels : 1;
  const colorSeams = inspectTerrainColorSeams(data, info.channels, patchWidth, patchHeight, tileWidth, tileHeight, placements);
  return {
    passed: gapRatio <= MAX_TERRAIN_GAP_RATIO && colorSeams.ratio <= MAX_TERRAIN_COLOR_SEAM_RATIO,
    gapPixels,
    inspectedPixels,
    gapRatio,
    colorSeamPixels: colorSeams.seamPixels,
    colorInspectedPixels: colorSeams.inspectedPixels,
    colorSeamRatio: colorSeams.ratio,
    averageColorSeamScore: colorSeams.averageScore,
    maxColorSeamScore: colorSeams.maxScore,
  };
}

interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

function isometricDiamondDistance(x: number, y: number, width: number, height: number): number {
  return Math.abs((x + 0.5 - width / 2) / (width / 2))
    + Math.abs((y + 0.5 - height / 2) / (height / 2));
}

function regionIndices(
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
): number[] {
  const indices: number[] = [];
  const left = Math.max(0, Math.floor((centerX - radiusX) * width));
  const right = Math.min(width - 1, Math.ceil((centerX + radiusX) * width));
  const top = Math.max(0, Math.floor((centerY - radiusY) * height));
  const bottom = Math.min(height - 1, Math.ceil((centerY + radiusY) * height));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const dx = (x + 0.5) / width - centerX;
      const dy = (y + 0.5) / height - centerY;
      if ((dx / radiusX) ** 2 + (dy / radiusY) ** 2 <= 1) indices.push(y * width + x);
    }
  }
  return indices;
}

function connectedPixels(visible: Uint8Array, width: number, height: number, seed: number): Uint8Array {
  const reached = new Uint8Array(visible.length);
  const queue = new Int32Array(visible.length);
  let head = 0;
  let tail = 0;
  queue[tail++] = seed;
  reached[seed] = 1;
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
        const next = nextY * width + nextX;
        if (!visible[next] || reached[next]) continue;
        reached[next] = 1;
        queue[tail++] = next;
      }
    }
  }
  return reached;
}

interface ColorSeamResult {
  seamPixels: number;
  inspectedPixels: number;
  ratio: number;
  averageScore: number;
  maxScore: number;
}

function inspectTerrainColorSeams(
  data: Buffer,
  channels: number,
  patchWidth: number,
  patchHeight: number,
  tileWidth: number,
  tileHeight: number,
  placements: Array<{ left: number; top: number }>,
): ColorSeamResult {
  const cells = TERRAIN_PREVIEW_CELLS.map((cell, index) => ({ ...cell, ...placements[index] }));
  const nearOffset = Math.max(1, Math.round(tileHeight / 64));
  const farOffset = Math.max(nearOffset + 1, Math.round(tileHeight * 3 / 64));
  const sampleCount = Math.max(2, Math.round(tileWidth / 2));
  const endpointMargin = Math.max(2, Math.round(sampleCount * 0.08));
  let seamPixels = 0;
  let inspectedPixels = 0;
  let scoreTotal = 0;
  let maxScore = 0;

  for (const cell of cells) {
    if (cell.x < 1) {
      inspectSharedEdge(
        { x: cell.left + tileWidth, y: cell.top + tileHeight / 2 },
        { x: cell.left + tileWidth / 2, y: cell.top + tileHeight },
        { x: tileHeight / 2, y: tileWidth / 2 },
      );
    }
    if (cell.y < 1) {
      inspectSharedEdge(
        { x: cell.left, y: cell.top + tileHeight / 2 },
        { x: cell.left + tileWidth / 2, y: cell.top + tileHeight },
        { x: -tileHeight / 2, y: tileWidth / 2 },
      );
    }
  }

  const ratio = inspectedPixels ? seamPixels / inspectedPixels : 1;
  return {
    seamPixels,
    inspectedPixels,
    ratio,
    averageScore: inspectedPixels ? scoreTotal / inspectedPixels : 1,
    maxScore,
  };

  function inspectSharedEdge(
    start: { x: number; y: number },
    end: { x: number; y: number },
    normal: { x: number; y: number },
  ): void {
    const normalLength = Math.hypot(normal.x, normal.y);
    const normalX = normal.x / normalLength;
    const normalY = normal.y / normalLength;
    for (let sample = endpointMargin; sample < sampleCount - endpointMargin; sample += 1) {
      const progress = sample / sampleCount;
      const x = start.x + (end.x - start.x) * progress;
      const y = start.y + (end.y - start.y) * progress;
      const nearA = pixelAt(x - normalX * nearOffset, y - normalY * nearOffset);
      const nearB = pixelAt(x + normalX * nearOffset, y + normalY * nearOffset);
      const farA = pixelAt(x - normalX * farOffset, y - normalY * farOffset);
      const farB = pixelAt(x + normalX * farOffset, y + normalY * farOffset);
      const center = pixelAt(x, y);
      const centerA = pixelAt(x - normalX, y - normalY);
      const centerB = pixelAt(x + normalX, y + normalY);
      if ([nearA, nearB, farA, farB, center, centerA, centerB].some((pixel) => pixel.a <= 48)) continue;

      const localTextureScore = (colorDistance(nearA, farA) + colorDistance(nearB, farB)) / 2;
      const acrossEdgeScore = colorDistance(nearA, nearB);
      const edgeLineScore = Math.max(
        colorDistance(center, nearA),
        colorDistance(center, nearB),
        colorDistance(centerA, nearA),
        colorDistance(centerB, nearB),
      );
      const seamScore = Math.max(0, Math.max(acrossEdgeScore, edgeLineScore) - localTextureScore);
      inspectedPixels += 1;
      scoreTotal += seamScore;
      maxScore = Math.max(maxScore, seamScore);
      if (seamScore > COLOR_SEAM_SCORE_THRESHOLD) seamPixels += 1;
    }
  }

  function pixelAt(x: number, y: number): Pixel {
    const roundedX = Math.max(0, Math.min(patchWidth - 1, Math.round(x)));
    const roundedY = Math.max(0, Math.min(patchHeight - 1, Math.round(y)));
    const offset = (roundedY * patchWidth + roundedX) * channels;
    return { r: data[offset], g: data[offset + 1], b: data[offset + 2], a: data[offset + 3] };
  }
}

function colorDistance(left: Pixel, right: Pixel): number {
  return Math.sqrt(
    ((left.r - right.r) ** 2)
    + ((left.g - right.g) ** 2)
    + ((left.b - right.b) ** 2),
  ) / MAX_RGB_DISTANCE;
}

function alphaBounds(data: Buffer, width: number, height: number, channels: number): TerrainTileBounds {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * channels + 3];
      if (alpha <= 24) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error('Tile terenu nie zawiera widocznych pikseli.');
  return { left, top, right, bottom };
}

export async function createThumbnail(inputPath: string, outputPath: string): Promise<void> {
  await sharp(inputPath).resize({ width: 480, height: 360, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 }).toFile(outputPath);
}

export interface RoadVariantFile {
  connectionMask: number;
  filePath: string;
}

export async function createRoadVariantsFromMaterial(
  stagingPath: string,
  sourcePath: string | null,
  tileWidth: number,
  tileHeight: number,
): Promise<RoadVariantFile[]> {
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error('Imagegen nie zapisał pełnokadrowej próbki materiału drogi.');
  }

  await validateRoadMaterialSource(sourcePath);
  const texture = await createPeriodicRoadTexture(sourcePath, tileWidth, tileHeight);
  const shoulderTexture = await sharp(texture)
    .modulate({ brightness: 0.78, saturation: 0.92 })
    .png()
    .toBuffer();
  const outerWidth = Math.max(4, tileHeight * 0.26);
  const innerWidth = Math.max(2, outerWidth * 0.72);

  for (const connectionMask of roadVariantMasks) {
    const outerMask = roadGeometryMask(connectionMask, tileWidth, tileHeight, outerWidth);
    const innerMask = roadGeometryMask(connectionMask, tileWidth, tileHeight, innerWidth);
    const shoulder = await sharp(shoulderTexture)
      .ensureAlpha()
      .composite([{ input: outerMask, blend: 'dest-in' }])
      .png()
      .toBuffer();
    const surface = await sharp(texture)
      .ensureAlpha()
      .composite([{ input: innerMask, blend: 'dest-in' }])
      .png()
      .toBuffer();

    await sharp({
      create: {
        width: tileWidth,
        height: tileHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).composite([{ input: shoulder }, { input: surface }])
      .png()
      .toFile(roadVariantPath(stagingPath, connectionMask));
  }

  return roadVariantMasks.map((connectionMask) => ({
    connectionMask,
    filePath: roadVariantPath(stagingPath, connectionMask),
  }));
}

async function validateRoadMaterialSource(sourcePath: string): Promise<void> {
  const { data, info } = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;
  let opaquePixels = 0;
  let chromaPixels = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * info.channels;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = data[offset + 3];
    if (alpha > 220) opaquePixels += 1;
    const greenKey = green >= 230 && red <= 40 && blue <= 40;
    const magentaKey = red >= 230 && green <= 40 && blue >= 230;
    if (greenKey || magentaKey) chromaPixels += 1;
  }

  if (opaquePixels / pixelCount < 0.9) {
    throw new Error(
      'Źródło drogi nie jest pełnokadrową, nieprzezroczystą próbką materiału. Nie generuj atlasu ani przezroczystego wycięcia.',
    );
  }
  if (chromaPixels / pixelCount > 0.2) {
    throw new Error(
      'Źródło drogi zawiera dominujące zielone lub różowe tło chroma-key. Wygeneruj sam materiał nawierzchni wypełniający cały obraz.',
    );
  }
}

async function createPeriodicRoadTexture(
  sourcePath: string,
  tileWidth: number,
  tileHeight: number,
): Promise<Buffer> {
  // A half-tile period makes opposite ports sample identical pixels after an
  // isometric neighbour offset. Mirroring the quarter patch closes the period
  // without asking imagegen to produce mathematically seamless borders.
  const periodWidth = Math.max(4, Math.round(tileWidth / 2));
  const periodHeight = Math.max(4, Math.round(tileHeight / 2));
  const leftWidth = Math.ceil(periodWidth / 2);
  const rightWidth = periodWidth - leftWidth;
  const topHeight = Math.ceil(periodHeight / 2);
  const bottomHeight = periodHeight - topHeight;
  const base = await sharp(sourcePath)
    .flatten({ background: '#808080' })
    .resize(leftWidth, topHeight, { fit: 'cover' })
    .removeAlpha()
    .png()
    .toBuffer();
  const topRight = await sharp(base).flop().resize(rightWidth, topHeight, { fit: 'fill' }).png().toBuffer();
  const bottomLeft = await sharp(base).flip().resize(leftWidth, bottomHeight, { fit: 'fill' }).png().toBuffer();
  const bottomRight = await sharp(base).flip().flop().resize(rightWidth, bottomHeight, { fit: 'fill' }).png().toBuffer();
  const period = await sharp({
    create: {
      width: periodWidth,
      height: periodHeight,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  }).composite([
    { input: base, left: 0, top: 0 },
    { input: topRight, left: leftWidth, top: 0 },
    { input: bottomLeft, left: 0, top: topHeight },
    { input: bottomRight, left: leftWidth, top: topHeight },
  ]).png().toBuffer();

  const repeatColumns = Math.ceil(tileWidth / periodWidth);
  const repeatRows = Math.ceil(tileHeight / periodHeight);
  const repeated = await sharp({
    create: {
      width: repeatColumns * periodWidth,
      height: repeatRows * periodHeight,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  }).composite(Array.from({ length: repeatRows }, (_, row) => (
    Array.from({ length: repeatColumns }, (_, column) => ({
      input: period,
      left: column * periodWidth,
      top: row * periodHeight,
    }))
  )).flat()).png().toBuffer();

  return sharp(repeated)
    .extract({ left: 0, top: 0, width: tileWidth, height: tileHeight })
    .png()
    .toBuffer();
}

function roadGeometryMask(
  connectionMask: number,
  tileWidth: number,
  tileHeight: number,
  roadWidth: number,
): Buffer {
  const centerX = tileWidth / 2;
  const centerY = tileHeight / 2;
  const arms = roadConnectionDirections
    .filter((direction) => hasRoadConnection(connectionMask, direction.bit))
    .map((direction) => {
      const anchorX = direction.x * tileWidth;
      const anchorY = direction.y * tileHeight;
      const endX = centerX + (anchorX - centerX) * 1.35;
      const endY = centerY + (anchorY - centerY) * 1.35;
      return `<line x1="${centerX}" y1="${centerY}" x2="${endX}" y2="${endY}"/>`;
    })
    .join('');
  const isolated = connectionMask === 0
    ? `<ellipse cx="${centerX}" cy="${centerY}" rx="${roadWidth * 0.58}" ry="${roadWidth * 0.34}"/>`
    : '';
  return Buffer.from(
    `<svg width="${tileWidth}" height="${tileHeight}" xmlns="http://www.w3.org/2000/svg">`
    + `<defs><clipPath id="diamond"><polygon points="${centerX},0 ${tileWidth},${centerY} ${centerX},${tileHeight} 0,${centerY}"/></clipPath></defs>`
    + `<g clip-path="url(#diamond)" fill="white" stroke="white" stroke-width="${roadWidth}" stroke-linecap="round" stroke-linejoin="round">`
    + `${isolated}${arms}</g></svg>`,
  );
}

const reflectedRoadVariants = [
  { target: 2, source: 1, flip: false, flop: true },
  { target: 4, source: 1, flip: true, flop: true },
  { target: 8, source: 1, flip: true, flop: false },
  { target: 9, source: 6, flip: false, flop: true },
  { target: 10, source: 5, flip: false, flop: true },
  { target: 11, source: 7, flip: false, flop: true },
  { target: 12, source: 3, flip: true, flop: false },
  { target: 13, source: 7, flip: true, flop: true },
  { target: 14, source: 7, flip: true, flop: false },
] as const;

export async function createReflectedRoadVariants(
  stagingPath: string,
  tileWidth: number,
  tileHeight: number,
): Promise<RoadVariantFile[]> {
  for (const connectionMask of roadCanonicalVariantMasks) {
    const filePath = roadVariantPath(stagingPath, connectionMask);
    if (!existsSync(filePath)) {
      throw new Error(
        `Brakuje kanonicznego wariantu road-${connectionMask.toString().padStart(2, '0')}.png; `
        + 'imagegen musi zwrócić siedem masek 00, 01, 03, 05, 06, 07 i 15.',
      );
    }
    const metadata = await sharp(filePath).metadata();
    if (metadata.width !== tileWidth || metadata.height !== tileHeight) {
      throw new Error(
        `Kanoniczny road-${connectionMask.toString().padStart(2, '0')}.png musi mieć `
        + `${tileWidth}×${tileHeight}px; otrzymano ${metadata.width ?? '?'}×${metadata.height ?? '?'}px.`,
      );
    }
  }

  for (const reflected of reflectedRoadVariants) {
    let image = sharp(roadVariantPath(stagingPath, reflected.source));
    if (reflected.flip) image = image.flip();
    if (reflected.flop) image = image.flop();
    await image.png().toFile(roadVariantPath(stagingPath, reflected.target));
  }

  return roadVariantMasks.map((connectionMask) => ({
    connectionMask,
    filePath: roadVariantPath(stagingPath, connectionMask),
  }));
}

export async function createRoadVariantsFromSource(
  stagingPath: string,
  sourcePath: string | null,
  tileWidth: number,
  tileHeight: number,
): Promise<RoadVariantFile[]> {
  const canonicalReady = await canonicalRoadVariantsAreReady(stagingPath, tileWidth, tileHeight);
  if (!canonicalReady) {
    if (!sourcePath || !existsSync(sourcePath)) {
      throw new Error(
        'Imagegen nie zapisał surowego atlasu drogi ani kompletu siedmiu kanonicznych plików.',
      );
    }
    await extractCanonicalRoadVariants(sourcePath, stagingPath, tileWidth, tileHeight);
  }
  return createReflectedRoadVariants(stagingPath, tileWidth, tileHeight);
}

async function canonicalRoadVariantsAreReady(
  stagingPath: string,
  tileWidth: number,
  tileHeight: number,
): Promise<boolean> {
  for (const connectionMask of roadCanonicalVariantMasks) {
    const filePath = roadVariantPath(stagingPath, connectionMask);
    if (!existsSync(filePath)) return false;
    const metadata = await sharp(filePath).metadata();
    if (metadata.width !== tileWidth || metadata.height !== tileHeight) return false;
  }
  return true;
}

async function extractCanonicalRoadVariants(
  sourcePath: string,
  stagingPath: string,
  tileWidth: number,
  tileHeight: number,
): Promise<void> {
  const { data, info } = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const gridSize = detectRoadSourceGrid(data, info.width, info.height, info.channels);
  const diamondMask = Buffer.from(
    `<svg width="${tileWidth}" height="${tileHeight}"><polygon points="${tileWidth / 2},0 ${tileWidth},${tileHeight / 2} ${tileWidth / 2},${tileHeight} 0,${tileHeight / 2}" fill="white"/></svg>`,
  );

  for (let index = 0; index < roadCanonicalVariantMasks.length; index += 1) {
    const connectionMask = roadCanonicalVariantMasks[index];
    const position = gridSize === 4 ? connectionMask : index;
    const column = position % gridSize;
    const row = Math.floor(position / gridSize);
    const left = Math.round(column * info.width / gridSize);
    const top = Math.round(row * info.height / gridSize);
    const right = Math.round((column + 1) * info.width / gridSize);
    const bottom = Math.round((row + 1) * info.height / gridSize);
    await sharp(sourcePath)
      .extract({ left, top, width: right - left, height: bottom - top })
      .resize(tileWidth, tileHeight, { fit: 'fill' })
      .ensureAlpha()
      .composite([{ input: diamondMask, blend: 'dest-in' }])
      .png()
      .toFile(roadVariantPath(stagingPath, connectionMask));
  }
}

function detectRoadSourceGrid(data: Buffer, width: number, height: number, channels: number): 3 | 4 {
  const threeByThree = visibleRoadCells(data, width, height, channels, 3);
  const canonicalCellsPresent = threeByThree.slice(0, 7).every((ratio) => ratio >= 0.002);
  const unusedCellsEmpty = threeByThree.slice(7).every((ratio) => ratio < 0.002);
  if (canonicalCellsPresent && unusedCellsEmpty) return 3;

  const fourByFour = visibleRoadCells(data, width, height, channels, 4);
  if (fourByFour.filter((ratio) => ratio >= 0.002).length >= 12) return 4;

  throw new Error(
    'Nie rozpoznano atlasu drogi. Oczekiwano siatki 3×3 z siedmioma bazami albo pełnej siatki 4×4.',
  );
}

function visibleRoadCells(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  gridSize: number,
): number[] {
  const ratios: number[] = [];
  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const left = Math.round(column * width / gridSize);
      const top = Math.round(row * height / gridSize);
      const right = Math.round((column + 1) * width / gridSize);
      const bottom = Math.round((row + 1) * height / gridSize);
      let visible = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          if (data[(y * width + x) * channels + 3] > 24) visible += 1;
        }
      }
      ratios.push(visible / Math.max(1, (right - left) * (bottom - top)));
    }
  }
  return ratios;
}

function roadVariantPath(stagingPath: string, connectionMask: number): string {
  return path.join(stagingPath, `road-${connectionMask.toString().padStart(2, '0')}.png`);
}

export async function createRoadVariantGrid(
  variants: RoadVariantFile[],
  outputPath: string,
  tileWidth: number,
  tileHeight: number,
): Promise<void> {
  if (variants.length !== 16) throw new Error('Siatka drogi wymaga dokładnie 16 wariantów.');
  await sharp({
    create: {
      width: tileWidth * 4,
      height: tileHeight * 4,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(variants.map((variant) => ({
    input: variant.filePath,
    left: (variant.connectionMask % 4) * tileWidth,
    top: Math.floor(variant.connectionMask / 4) * tileHeight,
  }))).png().toFile(outputPath);
}
