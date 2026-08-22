import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRoadVariantsFromMaterial,
  createRoadVariantsFromSource,
  validateElevatedTerrainTile,
  validateRoadTile,
  validateTerrainPng,
  validateTerrainTile,
  validateTransparentPng,
  verifyTerrainSeams,
} from '../main/services/image-validator';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('validateTransparentPng', () => {
  it('akceptuje niepusty PNG z alfą i przezroczystymi narożnikami', async () => {
    const directory = temp();
    const file = path.join(directory, 'valid.png');
    await sharp({ create: { width: 48, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="20" height="20"><circle cx="10" cy="10" r="10" fill="red"/></svg>'), left: 14, top: 14 }])
      .png().toFile(file);
    await expect(validateTransparentPng(file)).resolves.toMatchObject({ width: 48, height: 48 });
  });

  it('odrzuca nieprzezroczysty PNG', async () => {
    const directory = temp();
    const file = path.join(directory, 'opaque.png');
    await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } } }).png().toFile(file);
    await expect(validateTransparentPng(file)).rejects.toThrow(/przezroczystych/);
  });
});

describe('validateTerrainTile', () => {
  it('akceptuje romb dochodzący do wszystkich krawędzi canvasa komórki', async () => {
    const directory = temp();
    const file = path.join(directory, 'terrain.png');
    await sharp({ create: { width: 256, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="256" height="128"><polygon points="128,0 255,64 128,127 0,64" fill="#75a842"/></svg>') }])
      .png().toFile(file);

    await expect(validateTerrainTile(file, 256, 128)).resolves.toMatchObject({
      left: 0,
      top: 0,
      right: 254,
      bottom: 126,
    });
  });

  it('odrzuca teren z zewnętrznym przezroczystym paddingiem', async () => {
    const directory = temp();
    const file = path.join(directory, 'padded-terrain.png');
    await sharp({ create: { width: 256, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="216" height="96"><polygon points="108,0 215,48 108,95 0,48" fill="#75a842"/></svg>'), left: 20, top: 16 }])
      .png().toFile(file);

    await expect(validateTerrainTile(file, 256, 128)).rejects.toThrow(/nie wypełnia komórki/);
  });

  it('odrzuca canvas terenu o wymiarach innych niż komórka projektu', async () => {
    const directory = temp();
    const file = path.join(directory, 'wrong-size.png');
    await sharp({ create: { width: 512, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="512" height="256"><polygon points="256,0 511,128 256,255 0,128" fill="#75a842"/></svg>') }])
      .png().toFile(file);

    await expect(validateTerrainTile(file, 256, 128)).rejects.toThrow(/dokładnie 256×128px/);
  });
});

describe('top-down terrain validation', () => {
  it('akceptuje pełny nieprzezroczysty kwadrat 1:1', async () => {
    const directory = temp();
    const file = path.join(directory, 'top-down.png');
    await sharp({
      create: { width: 128, height: 128, channels: 3, background: { r: 78, g: 132, b: 62 } },
    }).png().toFile(file);

    await expect(validateTerrainPng(file, 'top_down')).resolves.toMatchObject({
      width: 128,
      height: 128,
      alphaMin: 255,
      alphaMax: 255,
    });
    await expect(validateTerrainTile(file, 128, 128, 'top_down')).resolves.toEqual({
      left: 0,
      top: 0,
      right: 127,
      bottom: 127,
    });
  });

  it('odrzuca kwadrat top-down z przezroczystym paddingiem', async () => {
    const directory = temp();
    const file = path.join(directory, 'top-down-padded.png');
    await sharp({
      create: { width: 128, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: Buffer.from('<svg width="112" height="112"><rect width="112" height="112" fill="#4e843e"/></svg>'), left: 8, top: 8 }])
      .png().toFile(file);

    await expect(validateTerrainTile(file, 128, 128, 'top_down')).rejects.toThrow(/kwadrat/);
  });

  it('odrzuca top-down z choćby pojedynczymi przezroczystymi narożnikami', async () => {
    const directory = temp();
    const file = path.join(directory, 'top-down-transparent-corners.png');
    const pixels = Buffer.alloc(64 * 64 * 4, 255);
    for (const index of [0, 63, 63 * 64, 64 * 64 - 1]) pixels[index * 4 + 3] = 0;
    await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toFile(file);

    await expect(validateTerrainPng(file, 'top_down')).rejects.toThrow(/nieprzezroczysty.*narożnikach/);
  });
});

describe('validateRoadTile', () => {
  it('akceptuje transparentną drogę NW-SE przechodzącą przez środek kafla', async () => {
    const directory = temp();
    const file = path.join(directory, 'road.png');
    await writeRoad(file, '64,32 128,64 192,96');

    const result = await validateRoadTile(file, 256, 128, 1 | 4);
    expect(result.visibleRatio).toBeGreaterThan(0.02);
    expect(result.visibleRatio).toBeLessThan(0.68);
    expect(result.connections.filter((connection) => connection.expected)).toHaveLength(2);
  });

  it('odrzuca pełny romb materiału udający drogę', async () => {
    const directory = temp();
    const file = path.join(directory, 'full-diamond.png');
    await sharp({ create: { width: 256, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="256" height="128"><polygon points="128,0 256,64 128,128 0,64" fill="#c78b43"/></svg>') }])
      .png().toFile(file);

    await expect(validateRoadTile(file, 256, 128, 1 | 4)).rejects.toThrow(/cały romb|krawędzi/);
  });

  it('odrzuca drogę dochodzącą do niezadeklarowanych krawędzi', async () => {
    const directory = temp();
    const file = path.join(directory, 'wrong-connections.png');
    await writeRoad(file, '192,32 128,64 64,96');

    await expect(validateRoadTile(file, 256, 128, 1 | 4)).rejects.toThrow(/nie dochodzi|nie jest zaznaczona/);
  });
});

describe('createRoadVariantsFromSource', () => {
  it('wycina siedem baz z atlasu 4×4 o natywnej rozdzielczości i tworzy komplet odbić', async () => {
    const directory = temp();
    const source = path.join(directory, 'road-source.png');
    const sourceWidth = 1774;
    const sourceHeight = 887;
    const composites = Array.from({ length: 16 }, (_, mask) => {
      const column = mask % 4;
      const row = Math.floor(mask / 4);
      const left = Math.round(column * sourceWidth / 4);
      const top = Math.round(row * sourceHeight / 4);
      const right = Math.round((column + 1) * sourceWidth / 4);
      const bottom = Math.round((row + 1) * sourceHeight / 4);
      const width = right - left;
      const height = bottom - top;
      const centerX = width / 2;
      const centerY = height / 2;
      const anchors = [
        { bit: 1, x: width * 0.25, y: height * 0.25 },
        { bit: 2, x: width * 0.75, y: height * 0.25 },
        { bit: 4, x: width * 0.75, y: height * 0.75 },
        { bit: 8, x: width * 0.25, y: height * 0.75 },
      ];
      const shapes = mask === 0
        ? `<circle cx="${centerX}" cy="${centerY}" r="${height * 0.12}" fill="#c78b43"/>`
        : anchors.filter((anchor) => (mask & anchor.bit) !== 0)
          .map((anchor) => `<line x1="${centerX}" y1="${centerY}" x2="${anchor.x}" y2="${anchor.y}" stroke="#c78b43" stroke-width="${height * 0.18}" stroke-linecap="butt"/>`)
          .join('');
      const svg = `<svg width="${width}" height="${height}"><defs><clipPath id="cell"><polygon points="${centerX},0 ${width},${centerY} ${centerX},${height} 0,${centerY}"/></clipPath></defs><g clip-path="url(#cell)">${shapes}</g></svg>`;
      return { input: Buffer.from(svg), left, top };
    });
    await sharp({
      create: { width: sourceWidth, height: sourceHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite(composites).png().toFile(source);

    const variants = await createRoadVariantsFromSource(directory, source, 256, 128);

    expect(variants).toHaveLength(16);
    for (const variant of variants) {
      await expect(validateRoadTile(variant.filePath, 256, 128, variant.connectionMask)).resolves.toBeDefined();
    }
  });
});

describe('createRoadVariantsFromMaterial', () => {
  it('buduje wszystkie 16 spójnych geometrii z jednej pełnokadrowej próbki materiału', async () => {
    const directory = temp();
    const source = path.join(directory, 'road-material.png');
    await sharp({ create: { width: 640, height: 320, channels: 3, background: { r: 194, g: 139, b: 70 } } })
      .composite([{ input: Buffer.from(
        '<svg width="640" height="320"><g fill="#e4b067" opacity=".65"><circle cx="90" cy="70" r="24"/><circle cx="370" cy="210" r="31"/><path d="M0 270 Q180 210 340 290 T640 250 V320 H0Z"/></g></svg>',
      ) }])
      .png()
      .toFile(source);

    const variants = await createRoadVariantsFromMaterial(directory, source, 256, 128);

    expect(variants).toHaveLength(16);
    for (const variant of variants) {
      await expect(validateTransparentPng(variant.filePath)).resolves.toMatchObject({ width: 256, height: 128 });
      await expect(validateRoadTile(variant.filePath, 256, 128, variant.connectionMask)).resolves.toBeDefined();
    }
  });

  it('odrzuca zielony chroma-key zamiast materiału nawierzchni', async () => {
    const directory = temp();
    const source = path.join(directory, 'road-material.png');
    await sharp({ create: { width: 512, height: 256, channels: 3, background: { r: 0, g: 255, b: 0 } } })
      .png()
      .toFile(source);

    await expect(createRoadVariantsFromMaterial(directory, source, 256, 128)).rejects.toThrow(/chroma-key/);
  });

  it('buduje i waliduje komplet portów N-E-S-W dla top-down', async () => {
    const directory = temp();
    const source = path.join(directory, 'top-down-road-material.png');
    await sharp({
      create: { width: 512, height: 512, channels: 3, background: { r: 175, g: 122, b: 70 } },
    }).png().toFile(source);

    const variants = await createRoadVariantsFromMaterial(
      directory,
      source,
      128,
      128,
      'top_down',
    );

    expect(variants).toHaveLength(16);
    for (const variant of variants) {
      await expect(validateTransparentPng(variant.filePath)).resolves.toMatchObject({
        width: 128,
        height: 128,
      });
      await expect(validateRoadTile(
        variant.filePath,
        128,
        128,
        variant.connectionMask,
        'top_down',
      )).resolves.toBeDefined();
    }
  });

  it('zachowuje identyczne przeciwległe porty top-down dla nieparzystej komórki', async () => {
    const directory = temp();
    const source = path.join(directory, 'top-down-odd-road-material.png');
    const sourcePixels = Buffer.alloc(130 * 130 * 3);
    for (let y = 0; y < 130; y += 1) {
      for (let x = 0; x < 130; x += 1) {
        const offset = (y * 130 + x) * 3;
        sourcePixels[offset] = 70 + (x % 150);
        sourcePixels[offset + 1] = 50 + (y % 170);
        sourcePixels[offset + 2] = 35 + ((x + y) % 120);
      }
    }
    await sharp(sourcePixels, { raw: { width: 130, height: 130, channels: 3 } }).png().toFile(source);

    const variants = await createRoadVariantsFromMaterial(directory, source, 65, 65, 'top_down');
    const northSouth = variants.find((variant) => variant.connectionMask === 5)!;
    const eastWest = variants.find((variant) => variant.connectionMask === 10)!;
    const ns = await sharp(northSouth.filePath).ensureAlpha().raw().toBuffer();
    const ew = await sharp(eastWest.filePath).ensureAlpha().raw().toBuffer();

    expect(ns.subarray(0, 65 * 4)).toEqual(ns.subarray(64 * 65 * 4, 65 * 65 * 4));
    const leftColumn = Buffer.from(Array.from({ length: 65 }, (_, y) => [...ew.subarray(y * 65 * 4, y * 65 * 4 + 4)]).flat());
    const rightColumn = Buffer.from(Array.from({ length: 65 }, (_, y) => [...ew.subarray((y * 65 + 64) * 4, (y * 65 + 65) * 4)]).flat());
    expect(leftColumn).toEqual(rightColumn);
  });
});

describe('verifyTerrainSeams', () => {
  it('zalicza pełny romb i zapisuje deterministyczny podgląd 3×3', async () => {
    const directory = temp();
    const file = path.join(directory, 'seamless.png');
    const preview = path.join(directory, 'preview.png');
    await sharp({ create: { width: 256, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="256" height="128"><polygon points="128,0 256,64 128,128 0,64" fill="#75a842"/></svg>') }])
      .png().toFile(file);

    const result = await verifyTerrainSeams(file, preview);
    expect(result.passed).toBe(true);
    expect(result.gapRatio).toBeLessThanOrEqual(0.001);
    expect(result.colorSeamRatio).toBeLessThanOrEqual(0.03);
    expect(existsSync(preview)).toBe(true);
  });

  it('wykrywa przezroczyste szczeliny widoczne między kaflami', async () => {
    const directory = temp();
    const file = path.join(directory, 'gapped.png');
    const preview = path.join(directory, 'preview.png');
    await sharp({ create: { width: 256, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="236" height="108"><polygon points="118,0 236,54 118,108 0,54" fill="#75a842"/></svg>'), left: 10, top: 10 }])
      .png().toFile(file);

    const result = await verifyTerrainSeams(file, preview);
    expect(result.passed).toBe(false);
    expect(result.gapPixels).toBeGreaterThan(0);
  });

  it('odrzuca pełny romb z widocznym obrysem tworzącym siatkę po powtórzeniu', async () => {
    const directory = temp();
    const file = path.join(directory, 'outlined.png');
    const preview = path.join(directory, 'preview.png');
    await sharp({ create: { width: 256, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{
        input: Buffer.from('<svg width="256" height="128"><polygon points="128,0 256,64 128,128 0,64" fill="#75a842" stroke="#1a2710" stroke-width="5"/></svg>'),
      }])
      .png().toFile(file);

    const result = await verifyTerrainSeams(file, preview);
    expect(result.gapPixels).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.colorSeamRatio).toBeGreaterThan(0.03);
    expect(result.colorSeamPixels).toBeGreaterThan(0);
  });

  it('układa top-down na prostokątnej siatce 3×3 i wykrywa padding', async () => {
    const directory = temp();
    const valid = path.join(directory, 'top-down-seamless.png');
    const invalid = path.join(directory, 'top-down-gapped.png');
    await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 82, g: 139, b: 67 } },
    }).png().toFile(valid);
    await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: Buffer.from('<svg width="60" height="60"><rect width="60" height="60" fill="#528b43"/></svg>'), left: 2, top: 2 }])
      .png().toFile(invalid);

    const passed = await verifyTerrainSeams(
      valid,
      path.join(directory, 'top-down-preview.png'),
      64,
      64,
      'top_down',
    );
    const failed = await verifyTerrainSeams(
      invalid,
      path.join(directory, 'top-down-gap-preview.png'),
      64,
      64,
      'top_down',
    );

    expect(passed).toMatchObject({ passed: true, gapPixels: 0, colorSeamPixels: 0 });
    expect(failed.passed).toBe(false);
    expect(failed.gapPixels).toBeGreaterThan(0);
  });
});

describe('elevated terrain', () => {
  it('akceptuje górny romb z widocznymi ścianami na osobnym canvasie', async () => {
    const directory = temp();
    const file = path.join(directory, 'elevated.png');
    await writeElevatedTile(file);

    await expect(validateElevatedTerrainTile(file, 64, 32, 32)).resolves.toMatchObject({
      left: 0,
      top: 0,
    });
  });

  it('odrzuca płaski romb zapisany w canvasie elevated', async () => {
    const directory = temp();
    const file = path.join(directory, 'flat-in-elevated-canvas.png');
    await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="64" height="32"><polygon points="32,0 64,16 32,32 0,16" fill="#75a842"/></svg>') }])
      .png().toFile(file);

    await expect(validateElevatedTerrainTile(file, 64, 32, 32)).rejects.toThrow(/pełnego canvasa|ścian/);
  });

  it('układa elevated tile według wysokości rombu, a nie całego sprite', async () => {
    const directory = temp();
    const file = path.join(directory, 'elevated-seamless.png');
    const preview = path.join(directory, 'elevated-preview.png');
    await writeElevatedTile(file);

    const result = await verifyTerrainSeams(file, preview, 64, 32);
    expect(result.passed).toBe(true);
    expect(existsSync(preview)).toBe(true);
    await expect(sharp(preview).metadata()).resolves.toMatchObject({ width: 192, height: 128 });
  });
});

async function writeElevatedTile(file: string): Promise<void> {
  const svg = '<svg width="64" height="64">'
    + '<polygon points="32,0 64,16 32,32 0,16" fill="#75a842"/>'
    + '<polygon points="0,16 32,32 32,64 0,48" fill="#6d4b2c"/>'
    + '<polygon points="32,32 64,16 64,48 32,64" fill="#523823"/>'
    + '</svg>';
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(svg) }])
    .png().toFile(file);
}

async function writeRoad(file: string, points: string): Promise<void> {
  const svg = `<svg width="256" height="128"><defs><clipPath id="cell"><polygon points="128,0 256,64 128,128 0,64"/></clipPath></defs><polyline points="${points}" clip-path="url(#cell)" fill="none" stroke="#c78b43" stroke-width="20" stroke-linecap="butt" stroke-linejoin="round"/></svg>`;
  await sharp({ create: { width: 256, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(svg) }])
    .png().toFile(file);
}

function temp(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-image-'));
  directories.push(directory);
  return directory;
}
