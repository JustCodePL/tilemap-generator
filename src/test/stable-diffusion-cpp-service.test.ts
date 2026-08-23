import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import {
  buildPrompt,
  StableDiffusionCppService,
} from '../main/stable-diffusion/stable-diffusion-cpp-service';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('wykrywa lokalne Z-Image Turbo, uruchamia sd-cli i zapisuje przezroczysty wynik z provenance', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-sd-cpp-'));
  temporaryDirectories.push(root);
  const executablePath = path.join(root, 'sd-cli.exe');
  const modelPath = path.join(root, 'z_image_turbo_bf16.safetensors');
  const llmPath = path.join(root, 'qwen_3_4b.safetensors');
  const vaePath = path.join(root, 'ae.safetensors');
  for (const filePath of [executablePath, modelPath, llmPath, vaePath]) writeFileSync(filePath, 'test');
  const outputPath = path.join(root, 'final.png');
  let invokedArgs: string[] = [];

  const service = new StableDiffusionCppService(undefined, {
    executablePath,
    modelPath,
    llmPath,
    vaePath,
    commandRunner: async (_command, args) => {
      invokedArgs = args;
      const rawPath = args[args.indexOf('-o') + 1];
      await sharp({
        create: { width: 512, height: 512, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } },
      }).composite([{
        input: Buffer.from('<svg width="256" height="256"><rect width="256" height="256" fill="#528f45"/></svg>'),
        left: 128,
        top: 128,
      }]).png().toFile(rawPath);
      return { stdout: 'done', stderr: '' };
    },
  });

  await expect(service.refresh()).resolves.toMatchObject({
    state: 'ready', installed: true, profile: 'z_image_turbo', missingFiles: [],
  });
  const result = await service.generate({
    assetName: 'Leśna chata', category: 'building', projection: 'isometric', prompt: 'Drewno i mech', feedback: '',
    artBrief: 'Miękka malowana stylistyka', styleSummary: '', outputPath,
    outputSize: { width: 128, height: 192 }, roadAtlas: false, attempt: 1,
    verificationFeedback: '', signal: new AbortController().signal,
  });

  expect(existsSync(outputPath)).toBe(true);
  expect(invokedArgs).toEqual(expect.arrayContaining([
    '--diffusion-model', modelPath, '--llm', llmPath, '--vae', vaePath,
    '--offload-to-cpu', '--vae-on-cpu', '--diffusion-fa', '--steps', '8', '--cfg-scale', '1',
  ]));
  expect(invokedArgs.join(' ')).toContain('#ff00ff');
  const { data, info } = await sharp(outputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(info).toMatchObject({ width: 128, height: 192, channels: 4 });
  expect(data[3]).toBe(0);
  const center = ((Math.floor(info.height / 2) * info.width) + Math.floor(info.width / 2)) * info.channels;
  expect(data[center + 3]).toBeGreaterThan(200);
  expect(result).toMatchObject({
    model: 'z_image_turbo_bf16.safetensors',
    metadata: { profile: 'z_image_turbo', steps: 8, cfg: 1, workflowVersion: expect.any(String) },
  });
  expect(result.workflowHash).toMatch(/^[a-f0-9]{64}$/);

  const topDownOutput = path.join(root, 'top-down.png');
  const topDownResult = await service.generate({
    assetName: 'Łąka', category: 'flat_tile', projection: 'top_down', prompt: 'Soczysta trawa', feedback: '',
    artBrief: '', styleSummary: '', outputPath: topDownOutput,
    outputSize: { width: 128, height: 128 }, roadAtlas: false, attempt: 1,
    verificationFeedback: '', signal: new AbortController().signal,
  });
  const topDownImage = await sharp(topDownOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(topDownImage.info).toMatchObject({ width: 128, height: 128, channels: 4 });
  expect(topDownImage.data[3]).toBe(255);
  expect(invokedArgs.join(' ')).toContain('square top-down terrain tile');
  expect(topDownResult.metadata).toMatchObject({ chromaBackground: null });
});

it('raportuje brak programu i modeli bez uruchamiania procesu', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-sd-cpp-missing-'));
  temporaryDirectories.push(root);
  const service = new StableDiffusionCppService(undefined, {
    executablePath: path.join(root, 'sd-cli.exe'),
    modelPath: path.join(root, 'model.safetensors'),
    llmPath: path.join(root, 'llm.safetensors'),
    vaePath: path.join(root, 'vae.safetensors'),
  });

  await expect(service.refresh()).resolves.toMatchObject({
    state: 'unavailable', installed: false,
    missingFiles: ['sd-cli.exe', 'model.safetensors', 'llm.safetensors', 'vae.safetensors'],
  });
});

it('opisuje kompletny arkusz animacji postaci top-down', () => {
  const prompt = buildPrompt({
    assetName: 'Łowca', category: 'character', projection: 'top_down', prompt: '', feedback: '',
    artBrief: 'Czytelne sylwetki', styleSummary: '', outputPath: '/tmp/character.png',
    outputSize: { width: 400, height: 256 },
    characterAnimation: { action: 'walk', framesPerDirection: 4, framesPerSecond: 10 },
    roadAtlas: false, attempt: 1, verificationFeedback: '', signal: new AbortController().signal,
  });

  expect(prompt).toContain('5-column by 4-row');
  expect(prompt).toContain('Every frame cell is exactly 80x64px');
  expect(prompt).toContain('N (north), E (east), S (south), W (west)');
  expect(prompt).toContain('Column 1 is a grounded idle pose');
  expect(prompt).toContain('last walk frame loop smoothly into the first walk frame');
});
