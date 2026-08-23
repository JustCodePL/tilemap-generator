import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectCharacterAnimationSource,
  normalizeCharacterAnimationSource,
  recoverCharacterAnimationTransparency,
} from '../main/services/character-animation-source';

const directories: string[] = [];
const FIXTURE_FRAMES_PER_DIRECTION = 4;
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('inspectCharacterAnimationSource', () => {
  it('ufa liczbowemu kanałowi alfa i ignoruje RGB ukryte pod alpha=0', async () => {
    const directory = temp();
    const source = path.join(directory, 'hidden-rgb.png');
    await createTransparentSheet(source, 100, 80, { hiddenBackground: { r: 91, g: 45, b: 24 } });

    const result = await inspectCharacterAnimationSource(source, FIXTURE_FRAMES_PER_DIRECTION);

    expect(result).toMatchObject({
      width: 100,
      height: 80,
      hasAlpha: true,
      alphaMin: 0,
      usable: true,
    });
    expect(result.alphaMax).toBeGreaterThan(248);
    expect(result.cells).toHaveLength((FIXTURE_FRAMES_PER_DIRECTION + 1) * 4);
    expect(result.cells.every((cell) => cell.visiblePixels > 0 && !cell.touchesCellEdge)).toBe(true);
  });

  it('odrzuca RGB checkerboard wypalony w obraz zamiast prawdziwej alfy', async () => {
    const directory = temp();
    const source = path.join(directory, 'checkerboard.png');
    const tile = 8;
    const svg = `<svg width="100" height="80" xmlns="http://www.w3.org/2000/svg">`
      + Array.from({ length: 10 }, (_, row) => Array.from({ length: 13 }, (_, column) => (
        `<rect x="${column * tile}" y="${row * tile}" width="${tile}" height="${tile}" `
        + `fill="${(row + column) % 2 ? '#ffffff' : '#cccccc'}"/>`
      )).join('')).join('')
      + '</svg>';
    await sharp(Buffer.from(svg)).removeAlpha().png().toFile(source);

    const inspection = await inspectCharacterAnimationSource(source, FIXTURE_FRAMES_PER_DIRECTION);
    expect(inspection.usable).toBe(false);
    expect(inspection.issues).toContain('Źródło animacji postaci nie ma kanału alfa.');
    await expect(normalizeCharacterAnimationSource({
      sourcePath: source,
      outputPath: path.join(directory, 'final.png'),
      frameWidthPx: 10,
      frameHeightPx: 20,
      framesPerDirection: FIXTURE_FRAMES_PER_DIRECTION,
    })).rejects.toThrow(/nie ma kanału alfa/);
    expect(existsSync(path.join(directory, 'final.png'))).toBe(false);
  });

  it('odrzuca sylwetkę dotykającą proporcjonalnej granicy komórki', async () => {
    const directory = temp();
    const source = path.join(directory, 'touching.png');
    await createTransparentSheet(source, 103, 80, { touchFirstCellEdge: true });

    const result = await inspectCharacterAnimationSource(source, FIXTURE_FRAMES_PER_DIRECTION);

    expect(result.usable).toBe(false);
    expect(result.issues).toContain('Sylwetka w komórce 1×1 dotyka granicy komórki.');
  });

  it('wymaga niepustej sylwetki w każdej z 20 komórek', async () => {
    const directory = temp();
    const source = path.join(directory, 'empty-cell.png');
    await createTransparentSheet(source, 100, 80, { emptyCell: { row: 2, column: 3 } });

    const result = await inspectCharacterAnimationSource(source, FIXTURE_FRAMES_PER_DIRECTION);

    expect(result.usable).toBe(false);
    expect(result.cells).toHaveLength((FIXTURE_FRAMES_PER_DIRECTION + 1) * 4);
    expect(result.issues).toContain('Komórka 4×3 źródła animacji postaci jest pusta.');
  });
});

describe('recoverCharacterAnimationTransparency', () => {
  it('odzyskuje prawdziwą alfę z jasnego checkerboardu bez zmiany źródła', async () => {
    const directory = temp();
    const source = path.join(directory, 'opaque-checkerboard.png');
    const output = path.join(directory, 'recovered.png');
    await createOpaqueSheet(source, 200, 128, 'checkerboard');
    const sourceHash = digest(source);

    const recovery = await recoverCharacterAnimationTransparency({
      sourcePath: source,
      outputPath: output,
      framesPerDirection: FIXTURE_FRAMES_PER_DIRECTION,
    });

    expect(recovery.method).toBe('light-neutral-border');
    expect(recovery.borderConfidence).toBeGreaterThanOrEqual(0.8);
    expect(recovery.output).toMatchObject({ hasAlpha: true, usable: true });
    expect(recovery.output.transparentPixels).toBeGreaterThan(0);
    expect(recovery.output.cells).toHaveLength((FIXTURE_FRAMES_PER_DIRECTION + 1) * 4);
    expect(digest(source)).toBe(sourceHash);
  });

  it('odzyskuje alfę z jednoznacznego tła chroma key', async () => {
    const directory = temp();
    const source = path.join(directory, 'opaque-magenta.png');
    const output = path.join(directory, 'recovered.png');
    await createOpaqueSheet(source, 200, 128, 'magenta');

    const recovery = await recoverCharacterAnimationTransparency({
      sourcePath: source,
      outputPath: output,
      framesPerDirection: FIXTURE_FRAMES_PER_DIRECTION,
    });

    expect(recovery.method).toBe('uniform-border-color');
    expect(recovery.output.usable).toBe(true);
  });

  it('odmawia usunięcia niejednoznacznego wielokolorowego tła', async () => {
    const directory = temp();
    const source = path.join(directory, 'ambiguous.png');
    const output = path.join(directory, 'recovered.png');
    const svg = '<svg width="200" height="128" xmlns="http://www.w3.org/2000/svg">'
      + '<defs><linearGradient id="g"><stop stop-color="#1020c0"/><stop offset=".5" stop-color="#ef3020"/><stop offset="1" stop-color="#10b040"/></linearGradient></defs>'
      + '<rect width="200" height="128" fill="url(#g)"/></svg>';
    await sharp(Buffer.from(svg)).removeAlpha().png().toFile(source);

    await expect(recoverCharacterAnimationTransparency({
      sourcePath: source,
      outputPath: output,
      framesPerDirection: FIXTURE_FRAMES_PER_DIRECTION,
    })).rejects.toThrow(/Nie można bezpiecznie odseparować tła/);
    expect(existsSync(output)).toBe(false);
  });
});

describe('normalizeCharacterAnimationSource', () => {
  it('normalizuje realny canvas 1024×1536 do 640×1536 bez zmiany źródła i bez rozciągania', async () => {
    const directory = temp();
    const source = path.join(directory, 'source.png');
    const output = path.join(directory, 'final.png');
    await createTransparentSheet(source, 1024, 1536, {
      hiddenBackground: { r: 62, g: 35, b: 19 },
      fillRatio: 0.88,
    });
    const sourceHash = digest(source);

    const result = await normalizeCharacterAnimationSource({
      sourcePath: source,
      outputPath: output,
      frameWidthPx: 128,
      frameHeightPx: 384,
      framesPerDirection: FIXTURE_FRAMES_PER_DIRECTION,
    });

    expect(result.normalized).toBe(true);
    expect(result.scale).toBeGreaterThan(0.6);
    expect(result.scale).toBeLessThan(0.8);
    expect(result.sourceCellSize).toEqual({ width: 204.8, height: 384 });
    expect(result.outputCellSize.width).toBe(126);
    expect(result.outputCellSize.height).toBeLessThanOrEqual(126);
    expect(result.output).toMatchObject({ width: 640, height: 1536, hasAlpha: true, usable: true });
    expect(result.output.cells).toHaveLength((FIXTURE_FRAMES_PER_DIRECTION + 1) * 4);
    expect(digest(source)).toBe(sourceHash);

    const firstBounds = await alphaBounds(output, 0, 0, 128, 384);
    expect(firstBounds.width / firstBounds.height).toBeCloseTo(1, 1);
    expect(firstBounds.bottom).toBeGreaterThanOrEqual(370);
    expect(firstBounds.top).toBeGreaterThan(200);
  });

  it('kopiuje już poprawny arkusz bez ponownego kodowania', async () => {
    const directory = temp();
    const source = path.join(directory, 'source.png');
    const output = path.join(directory, 'final.png');
    await createTransparentSheet(source, 50, 80);

    const result = await normalizeCharacterAnimationSource({
      sourcePath: source,
      outputPath: output,
      frameWidthPx: 10,
      frameHeightPx: 20,
      framesPerDirection: FIXTURE_FRAMES_PER_DIRECTION,
    });

    expect(result.normalized).toBe(false);
    expect(digest(output)).toBe(digest(source));
  });

  it('naprawia pełnokadrowe klatki w arkuszu o docelowym rozmiarze', async () => {
    const directory = temp();
    const source = path.join(directory, 'touching-target-size.png');
    const output = path.join(directory, 'normalized.png');
    const frameWidth = 64;
    const frameHeight = 80;
    await createTransparentSheet(source, frameWidth * 5, frameHeight * 4, {
      touchFirstCellEdge: true,
      fillRatio: 1,
    });

    const sourceInspection = await inspectCharacterAnimationSource(source, FIXTURE_FRAMES_PER_DIRECTION);
    expect(sourceInspection.usable).toBe(false);
    expect(sourceInspection.cells.some((cell) => cell.touchesCellEdge)).toBe(true);

    const result = await normalizeCharacterAnimationSource({
      sourcePath: source,
      outputPath: output,
      frameWidthPx: frameWidth,
      frameHeightPx: frameHeight,
      framesPerDirection: FIXTURE_FRAMES_PER_DIRECTION,
    });

    const horizontalPadding = Math.ceil(frameWidth * 0.08);
    const verticalPadding = Math.ceil(frameHeight * 0.08);
    expect(result.normalized).toBe(true);
    expect(result.scale).toBeLessThan(1);
    expect(result.output.usable).toBe(true);
    expect(result.output.cells.every((cell) => {
      if (!cell.bounds) return false;
      return cell.bounds.left >= horizontalPadding
        && frameWidth - 1 - cell.bounds.right >= horizontalPadding
        && cell.bounds.top >= verticalPadding
        && frameHeight - 1 - cell.bounds.bottom >= verticalPadding;
    })).toBe(true);
  });

  it('stabilizuje poziomy centroid asymetrycznych sylwetek między klatkami', async () => {
    const directory = temp();
    const source = path.join(directory, 'asymmetric-centroids.png');
    const output = path.join(directory, 'normalized.png');
    await createAsymmetricCentroidSheet(source, 500, 320);

    const result = await normalizeCharacterAnimationSource({
      sourcePath: source,
      outputPath: output,
      frameWidthPx: 64,
      frameHeightPx: 80,
      framesPerDirection: FIXTURE_FRAMES_PER_DIRECTION,
    });

    expect(result.normalized).toBe(true);
    expect(result.output.usable).toBe(true);
    for (let row = 0; row < 4; row += 1) {
      const centroids = result.output.cells
        .filter((cell) => cell.row === row)
        .map((cell) => cell.centroid?.x ?? Number.NaN);
      expect(Math.max(...centroids) - Math.min(...centroids)).toBeLessThanOrEqual(1.5);
    }
  });

  it('usuwa małe pionowo oderwane artefakty także z arkusza o docelowym rozmiarze', async () => {
    const directory = temp();
    const source = path.join(directory, 'detached-lower-artifacts.png');
    const output = path.join(directory, 'normalized.png');
    await createDetachedVerticalArtifactSheet(source, 320, 320);

    const sourceInspection = await inspectCharacterAnimationSource(source, FIXTURE_FRAMES_PER_DIRECTION);
    expect(sourceInspection.cells.some((cell) => cell.discardedPixels > 0)).toBe(true);

    const result = await normalizeCharacterAnimationSource({
      sourcePath: source,
      outputPath: output,
      frameWidthPx: 64,
      frameHeightPx: 80,
      framesPerDirection: FIXTURE_FRAMES_PER_DIRECTION,
    });

    expect(result.normalized).toBe(true);
    expect(result.output.usable).toBe(true);
    expect(result.output.cells.every((cell) => cell.discardedPixels === 0)).toBe(true);
    for (let row = 0; row < 4; row += 1) {
      const centroids = result.output.cells
        .filter((cell) => cell.row === row)
        .map((cell) => cell.centroid?.y ?? Number.NaN);
      expect(Math.max(...centroids) - Math.min(...centroids)).toBeLessThanOrEqual(1.5);
    }
  });

  it('nie nadpisuje źródła, gdy normalizacja wymaga innego canvasa', async () => {
    const directory = temp();
    const source = path.join(directory, 'source.png');
    await createTransparentSheet(source, 100, 80);
    const sourceHash = digest(source);

    await expect(normalizeCharacterAnimationSource({
      sourcePath: source,
      outputPath: source,
      frameWidthPx: 10,
      frameHeightPx: 20,
      framesPerDirection: FIXTURE_FRAMES_PER_DIRECTION,
    })).rejects.toThrow(/innym pliku niż niezmienione źródło/);
    expect(digest(source)).toBe(sourceHash);
  });

  it('normalizuje pełny projektowy kontrakt idle + 8 klatek dla czterech kierunków', async () => {
    const directory = temp();
    const source = path.join(directory, 'source-8.png');
    const output = path.join(directory, 'final-8.png');
    const framesPerDirection = 8;
    const columns = framesPerDirection + 1;
    await createTransparentSheet(source, 900, 320, { framesPerDirection });

    const result = await normalizeCharacterAnimationSource({
      sourcePath: source,
      outputPath: output,
      frameWidthPx: 64,
      frameHeightPx: 80,
      framesPerDirection,
    });

    expect(result.output).toMatchObject({
      width: 64 * columns,
      height: 80 * 4,
      columns,
      framesPerDirection,
      usable: true,
    });
    expect(result.output.cells).toHaveLength(columns * 4);
  });
});

interface SheetOptions {
  hiddenBackground?: { r: number; g: number; b: number };
  touchFirstCellEdge?: boolean;
  emptyCell?: { row: number; column: number };
  fillRatio?: number;
  framesPerDirection?: number;
}

async function createTransparentSheet(
  filePath: string,
  width: number,
  height: number,
  options: SheetOptions = {},
): Promise<void> {
  const columns = (options.framesPerDirection ?? FIXTURE_FRAMES_PER_DIRECTION) + 1;
  const composites: OverlayOptions[] = [];
  for (let row = 0; row < 4; row += 1) {
    const top = Math.round(row * height / 4);
    const bottom = Math.round((row + 1) * height / 4);
    for (let column = 0; column < columns; column += 1) {
      if (options.emptyCell?.row === row && options.emptyCell.column === column) continue;
      const left = Math.round(column * width / columns);
      const right = Math.round((column + 1) * width / columns);
      const cellWidth = right - left;
      const cellHeight = bottom - top;
      const size = Math.max(2, Math.floor(Math.min(cellWidth, cellHeight) * (options.fillRatio ?? 0.42)));
      const shapeLeft = options.touchFirstCellEdge && row === 0 && column === 0
        ? 0
        : Math.floor((cellWidth - size) / 2);
      const shapeTop = cellHeight - size - Math.max(1, Math.floor(cellHeight * 0.05));
      const color = `rgb(${80 + row * 35},${70 + column * 25},${120 + row * 15})`;
      composites.push({
        input: Buffer.from(
          `<svg width="${cellWidth}" height="${cellHeight}" xmlns="http://www.w3.org/2000/svg">`
          + `<rect x="${shapeLeft}" y="${shapeTop}" width="${size}" height="${size}" rx="1" fill="${color}"/>`
          + '</svg>',
        ),
        left,
        top,
      });
    }
  }
  const background = options.hiddenBackground ?? { r: 0, g: 0, b: 0 };
  await sharp({
    create: { width, height, channels: 4, background: { ...background, alpha: 0 } },
  }).composite(composites).png().toFile(filePath);
}

async function createOpaqueSheet(
  filePath: string,
  width: number,
  height: number,
  background: 'checkerboard' | 'magenta',
): Promise<void> {
  const transparentPath = path.join(path.dirname(filePath), `.transparent-${path.basename(filePath)}`);
  await createTransparentSheet(transparentPath, width, height);
  const tile = 12;
  const backgroundSvg = background === 'magenta'
    ? `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#ff00ff"/></svg>`
    : `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
      + Array.from({ length: Math.ceil(height / tile) }, (_, row) => (
        Array.from({ length: Math.ceil(width / tile) }, (_, column) => (
          `<rect x="${column * tile}" y="${row * tile}" width="${tile}" height="${tile}" fill="${(row + column) % 2 ? '#ffffff' : '#d8d8d8'}"/>`
        )).join('')
      )).join('')
      + '</svg>';
  await sharp(Buffer.from(backgroundSvg))
    .composite([{ input: transparentPath }])
    .removeAlpha()
    .png()
    .toFile(filePath);
  rmSync(transparentPath, { force: true });
}

async function createAsymmetricCentroidSheet(
  filePath: string,
  width: number,
  height: number,
): Promise<void> {
  const columns = FIXTURE_FRAMES_PER_DIRECTION + 1;
  const composites: OverlayOptions[] = [];
  for (let row = 0; row < 4; row += 1) {
    const top = Math.round(row * height / 4);
    const bottom = Math.round((row + 1) * height / 4);
    for (let column = 0; column < columns; column += 1) {
      const left = Math.round(column * width / columns);
      const right = Math.round((column + 1) * width / columns);
      const cellWidth = right - left;
      const cellHeight = bottom - top;
      const mirrored = column % 2 === 1;
      const bodyLeft = mirrored ? cellWidth - 23 : 5;
      const detailLeft = mirrored ? 16 : cellWidth - 20;
      composites.push({
        input: Buffer.from(
          `<svg width="${cellWidth}" height="${cellHeight}" xmlns="http://www.w3.org/2000/svg">`
          + `<rect x="${bodyLeft}" y="40" width="18" height="30" rx="2" fill="#4f8f46"/>`
          + `<rect x="${detailLeft}" y="52" width="4" height="4" fill="#d7b36a"/>`
          + '</svg>',
        ),
        left,
        top,
      });
    }
  }
  await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(composites).png().toFile(filePath);
}

async function createDetachedVerticalArtifactSheet(
  filePath: string,
  width: number,
  height: number,
): Promise<void> {
  const columns = FIXTURE_FRAMES_PER_DIRECTION + 1;
  const composites: OverlayOptions[] = [];
  for (let row = 0; row < 4; row += 1) {
    const top = Math.round(row * height / 4);
    const bottom = Math.round((row + 1) * height / 4);
    for (let column = 0; column < columns; column += 1) {
      const left = Math.round(column * width / columns);
      const right = Math.round((column + 1) * width / columns);
      const cellWidth = right - left;
      const cellHeight = bottom - top;
      const artifact = column % 3 === 1
        ? '<rect x="29" y="70" width="6" height="4" fill="#e46b32"/>'
        : column % 3 === 2
          ? '<rect x="29" y="2" width="6" height="4" fill="#e46b32"/>'
          : '';
      composites.push({
        input: Buffer.from(
          `<svg width="${cellWidth}" height="${cellHeight}" xmlns="http://www.w3.org/2000/svg">`
          + '<rect x="21" y="20" width="22" height="30" rx="3" fill="#4f8f46"/>'
          + '<rect x="48" y="30" width="4" height="5" fill="#d7b36a"/>'
          + artifact
          + '</svg>',
        ),
        left,
        top,
      });
    }
  }
  await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(composites).png().toFile(filePath);
}

async function alphaBounds(
  filePath: string,
  left: number,
  top: number,
  width: number,
  height: number,
): Promise<{ left: number; top: number; right: number; bottom: number; width: number; height: number }> {
  const { data, info } = await sharp(filePath)
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * info.channels + 3] <= 24) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    left: minX,
    top: minY,
    right: maxX,
    bottom: maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function digest(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function temp(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tilemap-character-source-'));
  directories.push(directory);
  return directory;
}
