import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectCharacterAnimationSource,
  normalizeCharacterAnimationSource,
} from '../main/services/character-animation-source';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('inspectCharacterAnimationSource', () => {
  it('ufa liczbowemu kanałowi alfa i ignoruje RGB ukryte pod alpha=0', async () => {
    const directory = temp();
    const source = path.join(directory, 'hidden-rgb.png');
    await createTransparentSheet(source, 100, 80, { hiddenBackground: { r: 91, g: 45, b: 24 } });

    const result = await inspectCharacterAnimationSource(source);

    expect(result).toMatchObject({
      width: 100,
      height: 80,
      hasAlpha: true,
      alphaMin: 0,
      usable: true,
    });
    expect(result.alphaMax).toBeGreaterThan(248);
    expect(result.cells).toHaveLength(20);
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

    const inspection = await inspectCharacterAnimationSource(source);
    expect(inspection.usable).toBe(false);
    expect(inspection.issues).toContain('Źródło animacji postaci nie ma kanału alfa.');
    await expect(normalizeCharacterAnimationSource({
      sourcePath: source,
      outputPath: path.join(directory, 'final.png'),
      frameWidthPx: 10,
      frameHeightPx: 20,
    })).rejects.toThrow(/nie ma kanału alfa/);
    expect(existsSync(path.join(directory, 'final.png'))).toBe(false);
  });

  it('odrzuca sylwetkę dotykającą proporcjonalnej granicy komórki', async () => {
    const directory = temp();
    const source = path.join(directory, 'touching.png');
    await createTransparentSheet(source, 103, 80, { touchFirstCellEdge: true });

    const result = await inspectCharacterAnimationSource(source);

    expect(result.usable).toBe(false);
    expect(result.issues).toContain('Sylwetka w komórce 1×1 dotyka granicy komórki.');
  });

  it('wymaga niepustej sylwetki w każdej z 20 komórek', async () => {
    const directory = temp();
    const source = path.join(directory, 'empty-cell.png');
    await createTransparentSheet(source, 100, 80, { emptyCell: { row: 2, column: 3 } });

    const result = await inspectCharacterAnimationSource(source);

    expect(result.usable).toBe(false);
    expect(result.cells).toHaveLength(20);
    expect(result.issues).toContain('Komórka 4×3 źródła animacji postaci jest pusta.');
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
    });

    expect(result.normalized).toBe(true);
    expect(result.scale).toBeGreaterThan(0.6);
    expect(result.scale).toBeLessThan(0.8);
    expect(result.sourceCellSize).toEqual({ width: 204.8, height: 384 });
    expect(result.outputCellSize.width).toBe(126);
    expect(result.outputCellSize.height).toBeLessThanOrEqual(126);
    expect(result.output).toMatchObject({ width: 640, height: 1536, hasAlpha: true, usable: true });
    expect(result.output.cells).toHaveLength(20);
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
    });

    expect(result.normalized).toBe(false);
    expect(digest(output)).toBe(digest(source));
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
    })).rejects.toThrow(/innym pliku niż niezmienione źródło/);
    expect(digest(source)).toBe(sourceHash);
  });
});

interface SheetOptions {
  hiddenBackground?: { r: number; g: number; b: number };
  touchFirstCellEdge?: boolean;
  emptyCell?: { row: number; column: number };
  fillRatio?: number;
}

async function createTransparentSheet(
  filePath: string,
  width: number,
  height: number,
  options: SheetOptions = {},
): Promise<void> {
  const composites: OverlayOptions[] = [];
  for (let row = 0; row < 4; row += 1) {
    const top = Math.round(row * height / 4);
    const bottom = Math.round((row + 1) * height / 4);
    for (let column = 0; column < 5; column += 1) {
      if (options.emptyCell?.row === row && options.emptyCell.column === column) continue;
      const left = Math.round(column * width / 5);
      const right = Math.round((column + 1) * width / 5);
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
