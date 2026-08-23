import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';

const CHARACTER_ROWS = 4;
const ALPHA_VISIBLE_THRESHOLD = 24;

export interface CharacterAnimationSourceCellInspection {
  row: number;
  column: number;
  visiblePixels: number;
  transparentPixels: number;
  touchesCellEdge: boolean;
  bounds: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
}

export interface CharacterAnimationSourceInspection {
  width: number;
  height: number;
  columns: number;
  rows: 4;
  framesPerDirection: number;
  hasAlpha: boolean;
  alphaMin: number;
  alphaMax: number;
  visiblePixels: number;
  transparentPixels: number;
  cells: CharacterAnimationSourceCellInspection[];
  usable: boolean;
  issues: string[];
}

export interface NormalizeCharacterAnimationSourceInput {
  sourcePath: string;
  outputPath: string;
  frameWidthPx: number;
  frameHeightPx: number;
  framesPerDirection: number;
}

export interface CharacterAnimationSourceNormalization {
  source: CharacterAnimationSourceInspection;
  output: CharacterAnimationSourceInspection;
  normalized: boolean;
  scale: number;
  sourceCellSize: { width: number; height: number };
  outputCellSize: { width: number; height: number };
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

/**
 * Reads alpha numerically. RGB values hidden under alpha=0 are deliberately
 * ignored: they are not a background and must never trigger background removal.
 */
export async function inspectCharacterAnimationSource(
  filePath: string,
  framesPerDirection: number,
): Promise<CharacterAnimationSourceInspection> {
  assertFramesPerDirection(framesPerDirection);
  const columns = framesPerDirection + 1;
  const image = sharp(filePath, { failOn: 'error' });
  const metadata = await image.metadata();
  if (metadata.format !== 'png') throw new Error('Źródło animacji postaci nie jest plikiem PNG.');
  if (!metadata.width || !metadata.height) throw new Error('Źródło animacji postaci ma niepoprawne wymiary.');

  const rawResult = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw: RawImage = {
    data: rawResult.data,
    width: rawResult.info.width,
    height: rawResult.info.height,
    channels: rawResult.info.channels,
  };
  const hasAlpha = metadata.hasAlpha === true;
  let alphaMin = 255;
  let alphaMax = 0;
  let visiblePixels = 0;
  let transparentPixels = 0;
  for (let y = 0; y < raw.height; y += 1) {
    for (let x = 0; x < raw.width; x += 1) {
      const alpha = pixelAlpha(raw, x, y);
      alphaMin = Math.min(alphaMin, alpha);
      alphaMax = Math.max(alphaMax, alpha);
      if (alpha > ALPHA_VISIBLE_THRESHOLD) visiblePixels += 1;
      else transparentPixels += 1;
    }
  }

  const issues: string[] = [];
  if (!hasAlpha) issues.push('Źródło animacji postaci nie ma kanału alfa.');
  if (!transparentPixels) issues.push('Źródło animacji postaci nie zawiera rzeczywiście przezroczystych pikseli.');
  if (!visiblePixels) issues.push('Źródło animacji postaci jest całkowicie przezroczyste.');

  const cells: CharacterAnimationSourceCellInspection[] = [];
  if (hasAlpha && visiblePixels && transparentPixels) {
    for (let row = 0; row < CHARACTER_ROWS; row += 1) {
      const top = gridBoundary(row, raw.height, CHARACTER_ROWS);
      const bottom = gridBoundary(row + 1, raw.height, CHARACTER_ROWS);
      for (let column = 0; column < columns; column += 1) {
        const left = gridBoundary(column, raw.width, columns);
        const right = gridBoundary(column + 1, raw.width, columns);
        const cell = inspectCell(raw, row, column, left, top, right, bottom);
        cells.push(cell);
        if (!cell.visiblePixels) {
          issues.push(`Komórka ${column + 1}×${row + 1} źródła animacji postaci jest pusta.`);
        } else if (cell.touchesCellEdge) {
          issues.push(`Sylwetka w komórce ${column + 1}×${row + 1} dotyka granicy komórki.`);
        }
      }
    }
  }

  return {
    width: raw.width,
    height: raw.height,
    columns,
    rows: CHARACTER_ROWS,
    framesPerDirection,
    hasAlpha,
    alphaMin,
    alphaMax,
    visiblePixels,
    transparentPixels,
    cells,
    usable: issues.length === 0,
    issues,
  };
}

/**
 * Re-packs a generated (idle + walk frames) x 4 sheet without changing the source. Every cell uses
 * one common scale, keeps its aspect ratio, is centered horizontally and
 * bottom-aligned inside the target frame. No upscaling or background removal
 * is performed.
 */
export async function normalizeCharacterAnimationSource(
  input: NormalizeCharacterAnimationSourceInput,
): Promise<CharacterAnimationSourceNormalization> {
  assertFrameSize(input.frameWidthPx, input.frameHeightPx);
  assertFramesPerDirection(input.framesPerDirection);
  const columns = input.framesPerDirection + 1;
  const source = await inspectCharacterAnimationSource(input.sourcePath, input.framesPerDirection);
  if (!source.usable) throw new Error(source.issues.join(' '));

  const targetWidth = input.frameWidthPx * columns;
  const targetHeight = input.frameHeightPx * CHARACTER_ROWS;
  const samePath = path.resolve(input.sourcePath) === path.resolve(input.outputPath);
  const normalized = source.width !== targetWidth || source.height !== targetHeight;
  const sourceCellWidth = source.width / columns;
  const sourceCellHeight = source.height / CHARACTER_ROWS;
  const horizontalGutter = input.frameWidthPx >= 3 ? 1 : 0;
  const verticalGutter = input.frameHeightPx >= 2 ? 1 : 0;
  const availableWidth = input.frameWidthPx - horizontalGutter * 2;
  const availableHeight = input.frameHeightPx - verticalGutter * 2;
  const sourceRegions = source.cells.map((cell) => expandedCellRegion(
    cell,
    source.width,
    source.height,
    columns,
  ));
  const maxSourceRegionWidth = Math.max(...sourceRegions.map((region) => region.width));
  const maxSourceRegionHeight = Math.max(...sourceRegions.map((region) => region.height));
  const scale = normalized
    ? Math.min(1, availableWidth / maxSourceRegionWidth, availableHeight / maxSourceRegionHeight)
    : 1;
  const outputCellWidth = normalized
    ? Math.max(1, Math.min(availableWidth, Math.round(maxSourceRegionWidth * scale)))
    : input.frameWidthPx;
  const outputCellHeight = normalized
    ? Math.max(1, Math.min(availableHeight, Math.round(maxSourceRegionHeight * scale)))
    : input.frameHeightPx;

  if (samePath && normalized) {
    throw new Error('Znormalizowany arkusz musi zostać zapisany w innym pliku niż niezmienione źródło.');
  }

  if (samePath && !normalized) {
    return {
      source,
      output: source,
      normalized: false,
      scale,
      sourceCellSize: { width: sourceCellWidth, height: sourceCellHeight },
      outputCellSize: { width: outputCellWidth, height: outputCellHeight },
    };
  }

  mkdirSync(path.dirname(input.outputPath), { recursive: true });
  const temporaryPath = `${input.outputPath}.tmp-${process.pid}-${Date.now()}.png`;
  try {
    if (!normalized) {
      copyFileSync(input.sourcePath, temporaryPath);
    } else {
      const overlays: OverlayOptions[] = [];
      for (const [index, sourceRegion] of sourceRegions.entries()) {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const cellWidth = Math.max(1, Math.min(availableWidth, Math.round(sourceRegion.width * scale)));
        const cellHeight = Math.max(1, Math.min(availableHeight, Math.round(sourceRegion.height * scale)));
        const cell = await sharp(input.sourcePath, { failOn: 'error' })
          .extract({
            left: sourceRegion.left,
            top: sourceRegion.top,
            width: sourceRegion.width,
            height: sourceRegion.height,
          })
          .ensureAlpha()
          .resize({ width: cellWidth, height: cellHeight, fit: 'fill', kernel: 'lanczos3' })
          .png()
          .toBuffer();
        overlays.push({
          input: cell,
          left: column * input.frameWidthPx + Math.floor((input.frameWidthPx - cellWidth) / 2),
          top: row * input.frameHeightPx + input.frameHeightPx - verticalGutter - cellHeight,
        });
      }
      await sharp({
        create: {
          width: targetWidth,
          height: targetHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      }).composite(overlays).png().toFile(temporaryPath);
    }
    renameSync(temporaryPath, input.outputPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }

  const output = await inspectCharacterAnimationSource(input.outputPath, input.framesPerDirection);
  if (!output.usable) {
    rmSync(input.outputPath, { force: true });
    throw new Error(`Znormalizowany arkusz animacji jest niepoprawny. ${output.issues.join(' ')}`);
  }
  if (output.width !== targetWidth || output.height !== targetHeight) {
    rmSync(input.outputPath, { force: true });
    throw new Error(
      `Znormalizowany arkusz animacji musi mieć ${targetWidth}×${targetHeight}px; `
      + `otrzymano ${output.width}×${output.height}px.`,
    );
  }
  return {
    source,
    output,
    normalized,
    scale,
    sourceCellSize: { width: sourceCellWidth, height: sourceCellHeight },
    outputCellSize: { width: outputCellWidth, height: outputCellHeight },
  };
}

function inspectCell(
  raw: RawImage,
  row: number,
  column: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): CharacterAnimationSourceCellInspection {
  let visiblePixels = 0;
  let transparentPixels = 0;
  let touchesCellEdge = false;
  let minX = right - left;
  let minY = bottom - top;
  let maxX = -1;
  let maxY = -1;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const alpha = pixelAlpha(raw, x, y);
      if (alpha > ALPHA_VISIBLE_THRESHOLD) {
        visiblePixels += 1;
        minX = Math.min(minX, x - left);
        minY = Math.min(minY, y - top);
        maxX = Math.max(maxX, x - left);
        maxY = Math.max(maxY, y - top);
      } else transparentPixels += 1;
      if (alpha > ALPHA_VISIBLE_THRESHOLD
        && (x === left || x === right - 1 || y === top || y === bottom - 1)) {
        touchesCellEdge = true;
      }
    }
  }
  const bounds = visiblePixels
    ? {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    }
    : null;
  return { row, column, visiblePixels, transparentPixels, touchesCellEdge, bounds };
}

function expandedCellRegion(
  cell: CharacterAnimationSourceCellInspection,
  sourceWidth: number,
  sourceHeight: number,
  columns: number,
): { left: number; top: number; width: number; height: number } {
  if (!cell.bounds) throw new Error(`Komórka ${cell.column + 1}×${cell.row + 1} źródła animacji postaci jest pusta.`);
  const cellLeft = gridBoundary(cell.column, sourceWidth, columns);
  const cellRight = gridBoundary(cell.column + 1, sourceWidth, columns);
  const cellTop = gridBoundary(cell.row, sourceHeight, CHARACTER_ROWS);
  const cellBottom = gridBoundary(cell.row + 1, sourceHeight, CHARACTER_ROWS);
  const left = Math.max(cellLeft, cellLeft + cell.bounds.left - 1);
  const right = Math.min(cellRight, cellLeft + cell.bounds.right + 2);
  const top = Math.max(cellTop, cellTop + cell.bounds.top - 1);
  const bottom = Math.min(cellBottom, cellTop + cell.bounds.bottom + 2);
  return { left, top, width: right - left, height: bottom - top };
}

function pixelAlpha(raw: RawImage, x: number, y: number): number {
  return raw.data[(y * raw.width + x) * raw.channels + 3];
}

function gridBoundary(index: number, size: number, count: number): number {
  return Math.round(index * size / count);
}

function assertFrameSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Docelowe wymiary klatki animacji muszą być dodatnimi liczbami całkowitymi.');
  }
}

function assertFramesPerDirection(value: number): void {
  if (!Number.isInteger(value) || value < 2 || value > 16) {
    throw new Error('Liczba klatek chodu na kierunek musi być liczbą całkowitą od 2 do 16.');
  }
}
