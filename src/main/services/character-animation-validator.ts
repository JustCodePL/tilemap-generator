import { mkdirSync } from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import {
  characterDirectionsForProjection,
  type CharacterDirectionId,
  type ProjectProjection,
} from '../../shared/domain';

const ALPHA_VISIBLE_THRESHOLD = 24;
const ALPHA_CORNER_THRESHOLD = 48;
const MAX_BASELINE_DRIFT_RATIO = 0.08;
const MAX_CENTROID_DRIFT_RATIO = 0.18;
const MAX_VISIBLE_AREA_RATIO = 1.75;
const MIN_CHANGED_PIXEL_RATIO = 0.002;
const MAX_LOOP_SPIKE_RATIO = 1.75;
const BOARD_LABEL_WIDTH = 168;
const BOARD_HEADER_HEIGHT = 42;

export interface CharacterAnimationValidationInput {
  filePath: string;
  projection: ProjectProjection;
  frameWidthPx: number;
  frameHeightPx: number;
  framesPerDirection: number;
}

export interface CharacterFrameMetrics {
  column: number;
  visiblePixels: number;
  transparentPixels: number;
  visibleAreaRatio: number;
  bounds: { left: number; top: number; right: number; bottom: number };
  centroid: { x: number; y: number };
}

export interface CharacterDirectionValidation {
  direction: CharacterDirectionId;
  row: number;
  frames: CharacterFrameMetrics[];
  maxBaselineDriftPx: number;
  maxCentroidDriftPx: { x: number; y: number };
  visibleAreaRatio: number;
  walkTransitionRatios: number[];
  loopTransitionRatio: number;
}

export interface CharacterAnimationValidationReport {
  width: number;
  height: number;
  frameWidthPx: number;
  frameHeightPx: number;
  framesPerDirection: number;
  columns: number;
  rows: 4;
  directions: CharacterDirectionValidation[];
}

export interface CharacterAnimationAnalysisArtifactsInput extends CharacterAnimationValidationInput {
  outputDirectory: string;
  report?: CharacterAnimationValidationReport;
}

export interface CharacterAnimationAnalysisArtifacts {
  report: CharacterAnimationValidationReport;
  boardPath: string;
  directionStrips: Array<{ direction: CharacterDirectionId; filePath: string }>;
}

interface RawSheet {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

/**
 * Validates the project character-sheet contract. Geometry and measurable
 * continuity are checked here; semantic facing and gait quality belong to the
 * mandatory final agent analysis.
 */
export async function validateCharacterAnimationSheet(
  input: CharacterAnimationValidationInput,
): Promise<CharacterAnimationValidationReport> {
  assertFrameSize(input.frameWidthPx, input.frameHeightPx);
  assertFramesPerDirection(input.framesPerDirection);
  const columns = input.framesPerDirection + 1;
  const expected = {
    width: input.frameWidthPx * columns,
    height: input.frameHeightPx * 4,
  };
  const image = sharp(input.filePath, { failOn: 'error' });
  const metadata = await image.metadata();
  if (metadata.format !== 'png') throw new Error('Arkusz animacji postaci nie jest plikiem PNG.');
  if (!metadata.hasAlpha) throw new Error('Arkusz animacji postaci nie ma kanału alfa.');
  if (metadata.width !== expected.width || metadata.height !== expected.height) {
    throw new Error(
      `Arkusz animacji postaci musi mieć dokładnie ${expected.width}×${expected.height}px `
      + `(${columns} kolumn: idle + ${input.framesPerDirection} klatek chodu × 4 kierunki); `
      + `otrzymano ${metadata.width ?? 0}×${metadata.height ?? 0}px.`,
    );
  }

  const rawResult = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw: RawSheet = {
    data: rawResult.data,
    width: rawResult.info.width,
    height: rawResult.info.height,
    channels: rawResult.info.channels,
  };
  const directions = characterDirectionsForProjection(input.projection);
  if (directions.length !== 4) throw new Error('Projekcja postaci musi definiować dokładnie cztery kierunki.');

  const directionReports = directions.map((direction, row) => {
    const frames = Array.from({ length: columns }, (_, column) => measureFrame(
      raw,
      row,
      column,
      input.frameWidthPx,
      input.frameHeightPx,
      String(direction.id),
    ));
    validateDirectionGeometry(String(direction.id), frames, input.frameWidthPx, input.frameHeightPx);
    const transitions = Array.from({ length: input.framesPerDirection - 1 }, (_, index) => (
      changedPixelRatio(
        raw,
        row,
        index + 1,
        row,
        index + 2,
        input.frameWidthPx,
        input.frameHeightPx,
      )
    ));
    const loopTransitionRatio = changedPixelRatio(
      raw,
      row,
      input.framesPerDirection,
      row,
      1,
      input.frameWidthPx,
      input.frameHeightPx,
    );
    validateWalkTransitions(String(direction.id), transitions, loopTransitionRatio);

    const baselines = frames.map((frame) => frame.bounds.bottom);
    const centroidXs = frames.map((frame) => frame.centroid.x);
    const centroidYs = frames.map((frame) => frame.centroid.y);
    const visibleAreas = frames.map((frame) => frame.visiblePixels);
    return {
      direction: direction.id,
      row,
      frames,
      maxBaselineDriftPx: spread(baselines),
      maxCentroidDriftPx: { x: spread(centroidXs), y: spread(centroidYs) },
      visibleAreaRatio: Math.max(...visibleAreas) / Math.min(...visibleAreas),
      walkTransitionRatios: [...transitions, loopTransitionRatio],
      loopTransitionRatio,
    } satisfies CharacterDirectionValidation;
  });

  return {
    width: raw.width,
    height: raw.height,
    frameWidthPx: input.frameWidthPx,
    frameHeightPx: input.frameHeightPx,
    framesPerDirection: input.framesPerDirection,
    columns,
    rows: 4,
    directions: directionReports,
  };
}

export async function createCharacterAnimationAnalysisArtifacts(
  input: CharacterAnimationAnalysisArtifactsInput,
): Promise<CharacterAnimationAnalysisArtifacts> {
  const report = input.report ?? await validateCharacterAnimationSheet(input);
  mkdirSync(input.outputDirectory, { recursive: true });
  const directionStrips: Array<{ direction: CharacterDirectionId; filePath: string }> = [];

  for (const direction of report.directions) {
    const filePath = path.join(input.outputDirectory, `movement-${direction.direction}.png`);
    await renderDirectionStrip(input.filePath, filePath, direction, report);
    directionStrips.push({ direction: direction.direction, filePath });
  }

  const boardPath = path.join(input.outputDirectory, 'movement-analysis-board.png');
  await renderAnalysisBoard(directionStrips, boardPath, report);
  return { report, boardPath, directionStrips };
}

function assertFrameSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Wymiary klatki animacji postaci muszą być dodatnimi liczbami całkowitymi.');
  }
}

function assertFramesPerDirection(value: number): void {
  if (!Number.isInteger(value) || value < 2 || value > 16) {
    throw new Error('Liczba klatek chodu na kierunek musi być liczbą całkowitą od 2 do 16.');
  }
}

function measureFrame(
  sheet: RawSheet,
  row: number,
  column: number,
  frameWidth: number,
  frameHeight: number,
  direction: string,
): CharacterFrameMetrics {
  let left = frameWidth;
  let top = frameHeight;
  let right = -1;
  let bottom = -1;
  let visiblePixels = 0;
  let weightedX = 0;
  let weightedY = 0;
  let alphaWeight = 0;
  const originX = column * frameWidth;
  const originY = row * frameHeight;

  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const alpha = pixelAlpha(sheet, originX + x, originY + y);
      if (alpha <= ALPHA_VISIBLE_THRESHOLD) continue;
      visiblePixels += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      weightedX += (x + 0.5) * alpha;
      weightedY += (y + 0.5) * alpha;
      alphaWeight += alpha;
    }
  }
  if (!visiblePixels || right < left || bottom < top) {
    throw new Error(`Klatka ${column} kierunku ${direction} jest pusta.`);
  }

  const corners = [
    [0, 0],
    [frameWidth - 1, 0],
    [0, frameHeight - 1],
    [frameWidth - 1, frameHeight - 1],
  ] as const;
  if (corners.some(([x, y]) => pixelAlpha(sheet, originX + x, originY + y) > ALPHA_CORNER_THRESHOLD)) {
    throw new Error(`Klatka ${column} kierunku ${direction} nie ma przezroczystych narożników.`);
  }
  const totalPixels = frameWidth * frameHeight;
  if (visiblePixels >= totalPixels) {
    throw new Error(`Klatka ${column} kierunku ${direction} nie zawiera przezroczystego tła.`);
  }
  return {
    column,
    visiblePixels,
    transparentPixels: totalPixels - visiblePixels,
    visibleAreaRatio: visiblePixels / totalPixels,
    bounds: { left, top, right, bottom },
    centroid: { x: weightedX / alphaWeight, y: weightedY / alphaWeight },
  };
}

function validateDirectionGeometry(
  direction: string,
  frames: CharacterFrameMetrics[],
  frameWidth: number,
  frameHeight: number,
): void {
  const baselineDrift = spread(frames.map((frame) => frame.bounds.bottom));
  const maxBaselineDrift = Math.max(2, Math.ceil(frameHeight * MAX_BASELINE_DRIFT_RATIO));
  if (baselineDrift > maxBaselineDrift) {
    throw new Error(
      `Postać w kierunku ${direction} dryfuje w pionie: linia kontaktu zmienia się o ${baselineDrift}px `
      + `(limit ${maxBaselineDrift}px).`,
    );
  }
  const centroidXDrift = spread(frames.map((frame) => frame.centroid.x));
  const centroidYDrift = spread(frames.map((frame) => frame.centroid.y));
  if (centroidXDrift > Math.max(2, frameWidth * MAX_CENTROID_DRIFT_RATIO)
    || centroidYDrift > Math.max(2, frameHeight * MAX_CENTROID_DRIFT_RATIO)) {
    throw new Error(
      `Postać w kierunku ${direction} przesuwa się między komórkami arkusza `
      + `(dryf centroidu ${centroidXDrift.toFixed(1)}×${centroidYDrift.toFixed(1)}px).`,
    );
  }
  const areas = frames.map((frame) => frame.visiblePixels);
  const areaRatio = Math.max(...areas) / Math.min(...areas);
  if (areaRatio > MAX_VISIBLE_AREA_RATIO) {
    throw new Error(
      `Sylwetka postaci w kierunku ${direction} zmienia powierzchnię ${areaRatio.toFixed(2)}×; `
      + 'klatki nie przedstawiają spójnej postaci.',
    );
  }
}

function validateWalkTransitions(direction: string, transitions: number[], loopTransition: number): void {
  const allTransitions = [...transitions, loopTransition];
  const staticTransition = allTransitions.findIndex((ratio) => ratio < MIN_CHANGED_PIXEL_RATIO);
  if (staticTransition >= 0) {
    throw new Error(
      `Animacja chodu ${direction} zawiera identyczne lub niemal identyczne sąsiednie klatki `
      + `(przejście ${staticTransition + 1}, zmiana ${(allTransitions[staticTransition] * 100).toFixed(2)}%).`,
    );
  }
  const largestInternal = Math.max(...transitions);
  if (loopTransition > 0.45
    && loopTransition > largestInternal * MAX_LOOP_SPIKE_RATIO) {
    throw new Error(
      `Pętla chodu ${direction} ma gwałtowne przejście ostatnia→pierwsza `
      + `(${(loopTransition * 100).toFixed(1)}% zmienionych pikseli).`,
    );
  }
}

function changedPixelRatio(
  sheet: RawSheet,
  firstRow: number,
  firstColumn: number,
  secondRow: number,
  secondColumn: number,
  frameWidth: number,
  frameHeight: number,
): number {
  let changed = 0;
  const total = frameWidth * frameHeight;
  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const first = pixelOffset(sheet, firstColumn * frameWidth + x, firstRow * frameHeight + y);
      const second = pixelOffset(sheet, secondColumn * frameWidth + x, secondRow * frameHeight + y);
      const firstAlpha = sheet.data[first + 3];
      const secondAlpha = sheet.data[second + 3];
      const alphaDifference = Math.abs(firstAlpha - secondAlpha);
      const colorDifference = Math.max(
        Math.abs(premultiply(sheet.data[first], firstAlpha) - premultiply(sheet.data[second], secondAlpha)),
        Math.abs(premultiply(sheet.data[first + 1], firstAlpha) - premultiply(sheet.data[second + 1], secondAlpha)),
        Math.abs(premultiply(sheet.data[first + 2], firstAlpha) - premultiply(sheet.data[second + 2], secondAlpha)),
      );
      if (alphaDifference > 12 || colorDifference > 12) changed += 1;
    }
  }
  return changed / total;
}

async function renderDirectionStrip(
  sourcePath: string,
  destinationPath: string,
  direction: CharacterDirectionValidation,
  report: CharacterAnimationValidationReport,
): Promise<void> {
  const labels = [
    'IDLE',
    ...Array.from({ length: report.framesPerDirection }, (_, index) => `W${index + 1}`),
    'W1 LOOP',
  ];
  const sourceColumns = [
    0,
    ...Array.from({ length: report.framesPerDirection }, (_, index) => index + 1),
    1,
  ];
  const header = 32;
  const width = report.frameWidthPx * sourceColumns.length;
  const height = report.frameHeightPx + header;
  const composites: OverlayOptions[] = [];
  for (let index = 0; index < sourceColumns.length; index += 1) {
    composites.push({
      input: await sharp(sourcePath).extract({
        left: sourceColumns[index] * report.frameWidthPx,
        top: direction.row * report.frameHeightPx,
        width: report.frameWidthPx,
        height: report.frameHeightPx,
      }).png().toBuffer(),
      left: index * report.frameWidthPx,
      top: header,
    });
  }
  composites.push({ input: stripHeaderSvg(width, header, labels, report.frameWidthPx), left: 0, top: 0 });
  await sharp({
    create: { width, height, channels: 4, background: { r: 25, g: 28, b: 36, alpha: 1 } },
  }).composite(composites).png().toFile(destinationPath);
}

async function renderAnalysisBoard(
  strips: Array<{ direction: CharacterDirectionId; filePath: string }>,
  destinationPath: string,
  report: CharacterAnimationValidationReport,
): Promise<void> {
  const stripWidth = report.frameWidthPx * (report.columns + 1);
  const stripHeight = report.frameHeightPx + 32;
  const width = BOARD_LABEL_WIDTH + stripWidth;
  const height = BOARD_HEADER_HEIGHT + stripHeight * strips.length;
  const composites: OverlayOptions[] = [
    { input: boardHeaderSvg(width, BOARD_HEADER_HEIGHT), left: 0, top: 0 },
  ];
  for (let row = 0; row < strips.length; row += 1) {
    composites.push({ input: strips[row].filePath, left: BOARD_LABEL_WIDTH, top: BOARD_HEADER_HEIGHT + row * stripHeight });
    composites.push({
      input: directionLabelSvg(BOARD_LABEL_WIDTH, stripHeight, String(strips[row].direction)),
      left: 0,
      top: BOARD_HEADER_HEIGHT + row * stripHeight,
    });
  }
  await sharp({
    create: { width, height, channels: 4, background: { r: 17, g: 19, b: 25, alpha: 1 } },
  }).composite(composites).png().toFile(destinationPath);
}

function stripHeaderSvg(width: number, height: number, labels: string[], cellWidth: number): Buffer {
  const text = labels.map((label, index) => (
    `<text x="${index * cellWidth + cellWidth / 2}" y="21" text-anchor="middle" `
    + 'font-family="sans-serif" font-size="12" fill="#dfe7f5">'
    + `${escapeXml(label)}</text>`
  )).join('');
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
    + '<rect width="100%" height="100%" fill="#202532"/>' + text + '</svg>');
}

function boardHeaderSvg(width: number, height: number): Buffer {
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
    + '<rect width="100%" height="100%" fill="#10131a"/>'
    + '<text x="16" y="27" font-family="sans-serif" font-size="16" font-weight="bold" fill="#ffffff">'
    + 'CHARACTER MOVEMENT ANALYSIS · idle + walk loop</text></svg>');
}

function directionLabelSvg(width: number, height: number, label: string): Buffer {
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
    + '<rect width="100%" height="100%" fill="#171b25"/>'
    + `<text x="16" y="${Math.round(height / 2)}" dominant-baseline="middle" `
    + 'font-family="sans-serif" font-size="15" font-weight="bold" fill="#91b7ff">'
    + `${escapeXml(label.toUpperCase())}</text></svg>`);
}

function pixelAlpha(sheet: RawSheet, x: number, y: number): number {
  return sheet.data[pixelOffset(sheet, x, y) + 3];
}

function pixelOffset(sheet: RawSheet, x: number, y: number): number {
  return (y * sheet.width + x) * sheet.channels;
}

function premultiply(channel: number, alpha: number): number {
  return channel * alpha / 255;
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[character]!);
}
