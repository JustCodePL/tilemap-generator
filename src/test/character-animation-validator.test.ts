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
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createSheet(options: { staticWalk?: boolean; drift?: boolean; empty?: { row: number; column: number } } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tilemap-character-validator-'));
  directories.push(directory);
  const filePath = path.join(directory, 'character.png');
  const frameWidth = 32;
  const frameHeight = 48;
  const composites: OverlayOptions[] = [];
  const colors = ['#7ec8ff', '#ffb86b', '#9ae68f', '#dc8cff'];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      if (options.empty?.row === row && options.empty.column === column) continue;
      const phase = options.staticWalk && column > 0 ? 1 : column;
      const legOffset = phase === 1 ? -3 : phase === 2 ? 0 : phase === 3 ? 3 : phase === 4 ? 1 : 0;
      const verticalOffset = options.drift && row === 0 && column === 4 ? -10 : 0;
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
      width: frameWidth * 5,
      height: frameHeight * 4,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites).png().toFile(filePath);
  return { directory, filePath, frameWidth, frameHeight };
}

it('waliduje kanoniczny arkusz 5×4 i buduje planszę analizy z powtórzoną pierwszą klatką pętli', async () => {
  const sheet = await createSheet();
  const report = await validateCharacterAnimationSheet({
    filePath: sheet.filePath,
    projection: 'isometric',
    frameWidthPx: sheet.frameWidth,
    frameHeightPx: sheet.frameHeight,
  });
  expect(report).toMatchObject({ width: 160, height: 192, columns: 5, rows: 4 });
  expect(report.directions.map((item) => item.direction)).toEqual([
    'north_west', 'north_east', 'south_east', 'south_west',
  ]);
  expect(report.directions.every((item) => item.frames.length === 5)).toBe(true);
  expect(report.directions.every((item) => item.walkTransitionRatios.length === 4)).toBe(true);

  const outputDirectory = path.join(sheet.directory, 'analysis');
  const artifacts = await createCharacterAnimationAnalysisArtifacts({
    filePath: sheet.filePath,
    projection: 'isometric',
    frameWidthPx: sheet.frameWidth,
    frameHeightPx: sheet.frameHeight,
    outputDirectory,
    report,
  });
  expect(existsSync(artifacts.boardPath)).toBe(true);
  expect(artifacts.directionStrips).toHaveLength(4);
  expect(artifacts.directionStrips.every((item) => existsSync(item.filePath))).toBe(true);
  await expect(sharp(artifacts.boardPath).metadata()).resolves.toMatchObject({
    width: 168 + sheet.frameWidth * 6,
    height: 42 + (sheet.frameHeight + 32) * 4,
  });
});

it('odrzuca arkusz o innym rozmiarze niż 5 kolumn i 4 kierunki', async () => {
  const sheet = await createSheet();
  await expect(validateCharacterAnimationSheet({
    filePath: sheet.filePath,
    projection: 'top_down',
    frameWidthPx: sheet.frameWidth + 1,
    frameHeightPx: sheet.frameHeight,
  })).rejects.toThrow(/5 kolumn × 4 kierunki/);
});

it('odrzuca pustą komórkę oraz statyczne klatki chodu', async () => {
  const empty = await createSheet({ empty: { row: 2, column: 3 } });
  await expect(validateCharacterAnimationSheet({
    filePath: empty.filePath,
    projection: 'top_down',
    frameWidthPx: empty.frameWidth,
    frameHeightPx: empty.frameHeight,
  })).rejects.toThrow(/jest pusta/);

  const staticSheet = await createSheet({ staticWalk: true });
  await expect(validateCharacterAnimationSheet({
    filePath: staticSheet.filePath,
    projection: 'top_down',
    frameWidthPx: staticSheet.frameWidth,
    frameHeightPx: staticSheet.frameHeight,
  })).rejects.toThrow(/identyczne lub niemal identyczne/);
});

it('odrzuca postać, której ground contact dryfuje między klatkami', async () => {
  const sheet = await createSheet({ drift: true });
  await expect(validateCharacterAnimationSheet({
    filePath: sheet.filePath,
    projection: 'isometric',
    frameWidthPx: sheet.frameWidth,
    frameHeightPx: sheet.frameHeight,
  })).rejects.toThrow(/dryfuje w pionie/);
});
