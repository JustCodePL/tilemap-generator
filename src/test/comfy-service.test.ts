import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { ComfyService } from '../main/comfy/comfy-service';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('akceptuje wyłącznie lokalny endpoint ComfyUI', () => {
  expect(() => new ComfyService(undefined, 'https://comfy.example.com')).toThrow(/tylko z lokalnym ComfyUI/);
  expect(new ComfyService(undefined, 'http://localhost:8188/').endpoint).toBe('http://localhost:8188');
});

it('wykrywa gotowy profil Z-Image Turbo i zapisuje provenance workflow', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-comfy-'));
  temporaryDirectories.push(root);
  const outputPath = path.join(root, 'final.png');
  const png = await sharp({
    create: { width: 512, height: 512, channels: 4, background: { r: 80, g: 130, b: 70, alpha: 0.8 } },
  }).png().toBuffer();
  let submitted: Record<string, unknown> | null = null;

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/system_stats') {
      return jsonResponse({ system: { comfyui_version: '0.30.2' } });
    }
    if (url.pathname.startsWith('/object_info/')) {
      const node = decodeURIComponent(url.pathname.slice('/object_info/'.length));
      return jsonResponse({ [node]: { input: {} } });
    }
    if (url.pathname.startsWith('/models/')) {
      const models: Record<string, string[]> = {
        diffusion_models: ['z_image_turbo_bf16.safetensors'],
        text_encoders: ['qwen_3_4b.safetensors'],
        vae: ['ae.safetensors'],
        background_removal: ['birefnet.safetensors'],
      };
      return jsonResponse(models[url.pathname.slice('/models/'.length)] ?? []);
    }
    if (url.pathname === '/prompt') {
      submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ prompt_id: 'prompt-123' });
    }
    if (url.pathname === '/history/prompt-123') {
      return jsonResponse({
        'prompt-123': {
          status: { completed: true, status_str: 'success' },
          outputs: { '14': { images: [{ filename: 'asset.png', subfolder: 'TilemapGenerator', type: 'output' }] } },
        },
      });
    }
    if (url.pathname === '/view') return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    return new Response('not found', { status: 404 });
  }));

  const service = new ComfyService(undefined, 'http://127.0.0.1:8188');
  await expect(service.refresh()).resolves.toMatchObject({
    state: 'ready', server: true, version: '0.30.2', missingNodes: [], missingModels: [],
  });

  const result = await service.generate({
    assetName: 'Leśna chata', category: 'building', prompt: 'Drewno i mech', feedback: '',
    artBrief: 'Miękka malowana stylistyka', styleSummary: '', outputPath,
    outputSize: { width: 128, height: 192 }, roadAtlas: false, attempt: 1,
    verificationFeedback: '', signal: new AbortController().signal,
  });

  expect(existsSync(outputPath)).toBe(true);
  await expect(sharp(outputPath).metadata()).resolves.toMatchObject({ width: 128, height: 192, channels: 4 });
  expect(result).toMatchObject({
    promptId: 'prompt-123', model: 'z_image_turbo_bf16.safetensors',
    metadata: { profile: 'z_image_turbo', steps: 8, cfg: 1, comfyUiVersion: '0.30.2' },
  });
  expect(submitted).not.toBeNull();
  const workflow = (submitted as unknown as Record<string, unknown>).prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  expect(workflow['1']).toMatchObject({ class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors' } });
  expect(workflow['10']).toMatchObject({ class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: 'birefnet.safetensors' } });
  expect(workflow['14']).toMatchObject({ class_type: 'SaveImage', inputs: { images: ['13', 0] } });
});

it('raportuje brakujące node-y i modele zamiast oznaczać ComfyUI jako gotowe', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/system_stats') return jsonResponse({ system: { comfyui_version: '0.30.2' } });
    if (url.pathname === '/object_info/RemoveBackground') return jsonResponse({});
    if (url.pathname.startsWith('/object_info/')) return jsonResponse({ available: {} });
    if (url.pathname === '/models/background_removal') return jsonResponse([]);
    if (url.pathname.startsWith('/models/')) return jsonResponse([
      url.pathname.includes('diffusion_models') ? 'z_image_turbo_bf16.safetensors'
        : url.pathname.includes('text_encoders') ? 'qwen_3_4b.safetensors' : 'ae.safetensors',
    ]);
    return new Response('not found', { status: 404 });
  }));

  const service = new ComfyService(undefined, 'http://127.0.0.1:8188');
  await expect(service.refresh()).resolves.toMatchObject({
    state: 'detected', server: true,
    missingNodes: ['RemoveBackground'], missingModels: ['birefnet.safetensors'],
  });
});

it('automatycznie znajduje Comfy Desktop na następnym lokalnym porcie', async () => {
  vi.stubEnv('TILEMAP_COMFY_URL', undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.port === '8188') throw new Error('port 8188 zajęty');
    if (url.port !== '8189') return new Response('not found', { status: 404 });
    if (url.pathname === '/system_stats') return jsonResponse({ system: { comfyui_version: '0.30.2' } });
    if (url.pathname.startsWith('/object_info/')) return jsonResponse({ available: {} });
    if (url.pathname === '/models/diffusion_models') return jsonResponse(['z_image_turbo_bf16.safetensors']);
    if (url.pathname === '/models/text_encoders') return jsonResponse(['qwen_3_4b.safetensors']);
    if (url.pathname === '/models/vae') return jsonResponse(['ae.safetensors']);
    if (url.pathname === '/models/background_removal') return jsonResponse(['birefnet.safetensors']);
    return new Response('not found', { status: 404 });
  }));

  const service = new ComfyService();
  await expect(service.refresh()).resolves.toMatchObject({
    state: 'ready', endpoint: 'http://127.0.0.1:8189', server: true,
  });
  expect(service.endpoint).toBe('http://127.0.0.1:8189');
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
