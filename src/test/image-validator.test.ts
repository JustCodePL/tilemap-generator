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
