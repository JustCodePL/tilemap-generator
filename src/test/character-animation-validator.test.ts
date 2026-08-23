import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { afterEach, expect, it } from 'vitest';
import {
  createCharacterAnimationAnalysisArtifacts,
  validateCharacterAnimationSheet,
} from '../main/services/character-animation-validator';

const directories: string[] = [];
const FIXTURE_FRAMES_PER_DIRECTION = 4;
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createSheet(options: {
  framesPerDirection?: number;
  staticWalk?: boolean;
  drift?: boolean;
  empty?: { row: number; column: number };
} = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tilemap-character-validator-'));
  directories.push(directory);
  const filePath = path.join(directory, 'character.png');
  const frameWidth = 32;
  const frameHeight = 48;
  const framesPerDirection = options.framesPerDirection ?? FIXTURE_FRAMES_PER_DIRECTION;
  const columns = framesPerDirection + 1;
  const composites: OverlayOptions[] = [];
  const colors = ['#7ec8ff', '#ffb86b', '#9ae68f', '#dc8cff'];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (options.empty?.row === row && options.empty.column === column) continue;
      const phase = options.staticWalk && column > 0 ? 1 : column;
      const legOffset = phase === 0 ? 0 : ((phase * 5) % 9) - 4;
      const verticalOffset = options.drift && row === 0 && column === columns - 1 ? -10 : 0;
      const svg = Buffer.from(
        `<svg width="${frameWidth}" height="${frameHeight}" xmlns="http://www.w3.org/2000/svg">`
        + `<circle cx="16" cy="${13 + verticalOffset}" r="5" fill="${colors[row]}"/>`
        + `<rect x="11" y="${18 + verticalOffset}" width="10" height="15" rx="3" fill="${colors[row]}"/>`
        + `<path d="M14 ${32 + verticalOffset} L${14 + legOffset} ${42 + verticalOffset} M18 ${32 + verticalOffset} L${18 - legOffset} ${42 + verticalOffset}" stroke="${colors[row]}" stroke-width="4" stroke-linecap="round"/>`
        + '</svg>',
      );
      composites.push({ input: svg, left: column * frameWidth, top: row * frameHeight });
    }
  }
  await sharp({
    create: {
      width: frameWidth * columns,
      height: frameHeight * 4,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites).png().toFile(filePath);
  return { directory, filePath, frameWidth, frameHeight, framesPerDirection, columns };
}

it('waliduje projektowy arkusz idle + 8 klatek w 4 kierunkach i buduje planszę pełnej pętli', async () => {
  const sheet = await createSheet({ framesPerDirection: 8 });
  const report = await validateCharacterAnimationSheet({
    filePath: sheet.filePath,
    projection: 'isometric',
    frameWidthPx: sheet.frameWidth,
    frameHeightPx: sheet.frameHeight,
    framesPerDirection: sheet.framesPerDirection,
  });
  expect(report).toMatchObject({
    width: sheet.frameWidth * sheet.columns,
    height: 192,
    framesPerDirection: 8,
    columns: 9,
    rows: 4,
  });
  expect(report.directions.map((item) => item.direction)).toEqual([
    'north_west', 'north_east', 'south_east', 'south_west',
  ]);
  expect(report.directions.every((item) => item.frames.length === sheet.columns)).toBe(true);
  expect(report.directions.every((item) => item.walkTransitionRatios.length === sheet.framesPerDirection)).toBe(true);

  const outputDirectory = path.join(sheet.directory, 'analysis');
  const artifacts = await createCharacterAnimationAnalysisArtifacts({
    filePath: sheet.filePath,
    projection: 'isometric',
    frameWidthPx: sheet.frameWidth,
    frameHeightPx: sheet.frameHeight,
    framesPerDirection: sheet.framesPerDirection,
    outputDirectory,
    report,
  });
  expect(existsSync(artifacts.boardPath)).toBe(true);
  expect(artifacts.directionStrips).toHaveLength(4);
  expect(artifacts.directionStrips.every((item) => existsSync(item.filePath))).toBe(true);
  await expect(sharp(artifacts.boardPath).metadata()).resolves.toMatchObject({
    width: 168 + sheet.frameWidth * (sheet.columns + 1),
    height: 42 + (sheet.frameHeight + 32) * 4,
  });
});

it('odrzuca arkusz o innym rozmiarze niż projektowa liczba kolumn i 4 kierunki', async () => {
  const sheet = await createSheet();
  await expect(validateCharacterAnimationSheet({
    filePath: sheet.filePath,
    projection: 'top_down',
    frameWidthPx: sheet.frameWidth + 1,
    frameHeightPx: sheet.frameHeight,
    framesPerDirection: sheet.framesPerDirection,
  })).rejects.toThrow(/idle \+ 4 klatek chodu × 4 kierunki/);
});

it('odrzuca arkusz wygenerowany z 4 klatkami, gdy projekt wymaga 8', async () => {
  const sheet = await createSheet({ framesPerDirection: 4 });
  await expect(validateCharacterAnimationSheet({
    filePath: sheet.filePath,
    projection: 'top_down',
    frameWidthPx: sheet.frameWidth,
    frameHeightPx: sheet.frameHeight,
    framesPerDirection: 8,
  })).rejects.toThrow(/9 kolumn: idle \+ 8 klatek chodu/);
});

it('odrzuca pustą komórkę oraz statyczne klatki chodu', async () => {
  const empty = await createSheet({ empty: { row: 2, column: 3 } });
  await expect(validateCharacterAnimationSheet({
    filePath: empty.filePath,
    projection: 'top_down',
    frameWidthPx: empty.frameWidth,
    frameHeightPx: empty.frameHeight,
    framesPerDirection: empty.framesPerDirection,
  })).rejects.toThrow(/jest pusta/);

  const staticSheet = await createSheet({ staticWalk: true });
  await expect(validateCharacterAnimationSheet({
    filePath: staticSheet.filePath,
    projection: 'top_down',
    frameWidthPx: staticSheet.frameWidth,
    frameHeightPx: staticSheet.frameHeight,
    framesPerDirection: staticSheet.framesPerDirection,
  })).rejects.toThrow(/identyczne lub niemal identyczne/);
});

it('odrzuca postać, której ground contact dryfuje między klatkami', async () => {
  const sheet = await createSheet({ drift: true });
  await expect(validateCharacterAnimationSheet({
    filePath: sheet.filePath,
    projection: 'isometric',
    frameWidthPx: sheet.frameWidth,
    frameHeightPx: sheet.frameHeight,
    framesPerDirection: sheet.framesPerDirection,
  })).rejects.toThrow(/dryfuje w pionie/);
});
