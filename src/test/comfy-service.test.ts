import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ComfyService,
  detectDesktopInstallation,
  type ComfyDesktopInstallation,
} from '../main/comfy/comfy-service';

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

it('wykrywa bundle Comfy Desktop na macOS niezależnie od stanu lokalnego API', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-comfy-macos-'));
  temporaryDirectories.push(root);
  const applicationsDirectory = path.join(root, 'Applications');
  const applicationBundle = path.join(applicationsDirectory, 'Comfy Desktop.app');
  const executable = path.join(applicationBundle, 'Contents', 'MacOS', 'Comfy Desktop');
  const resources = path.join(applicationBundle, 'Contents', 'Resources');
  mkdirSync(path.dirname(executable), { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(executable, 'desktop executable');
  writeFileSync(path.join(resources, 'app.asar'), 'desktop resources');
  writeFileSync(path.join(applicationBundle, 'Contents', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist><dict><key>CFBundleShortVersionString</key><string>1.0.39</string></dict></plist>',
  ].join(''));

  expect(detectDesktopInstallation({
    platform: 'darwin',
    homeDirectory: root,
    macApplicationDirectories: [applicationsDirectory],
  })).toEqual({
    installed: true,
    localBackendConfigured: false,
    updating: false,
    version: '1.0.39',
    missingModels: [
      'z_image_turbo_bf16.safetensors',
      'qwen_3_4b.safetensors',
      'ae.safetensors',
      'birefnet.safetensors',
    ],
  });
});

it('nie uznaje nieaktualnego installPath za lokalną instalację ComfyUI', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-comfy-stale-macos-'));
  temporaryDirectories.push(root);
  const applicationSupport = path.join(root, 'Library', 'Application Support', 'Comfy Desktop');
  mkdirSync(applicationSupport, { recursive: true });
  writeFileSync(path.join(applicationSupport, 'installations.json'), JSON.stringify([{
    id: 'stale-local',
    sourceId: 'standalone',
    installPath: path.join(root, 'missing-local-installation'),
    comfyVersion: { baseTag: '0.30.2' },
  }]));

  expect(detectDesktopInstallation({
    platform: 'darwin',
    homeDirectory: root,
    macApplicationDirectories: [path.join(root, 'Applications')],
  })).toMatchObject({
    installed: false,
    localBackendConfigured: false,
    updating: false,
  });
});

it('zachowuje wykrywanie aplikacji Comfy Desktop na Windows', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-comfy-windows-'));
  temporaryDirectories.push(root);
  const programFiles = path.join(root, 'Program Files');
  const executable = path.join(programFiles, 'Comfy Desktop', 'Comfy Desktop.exe');
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, 'desktop executable');

  expect(detectDesktopInstallation({
    platform: 'win32',
    homeDirectory: root,
    environment: {
      APPDATA: path.join(root, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
      ProgramFiles: programFiles,
    },
  })).toMatchObject({
    installed: true,
    localBackendConfigured: false,
    updating: false,
  });
});

it('raportuje zainstalowany Comfy Desktop osobno od niedziałającego API', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8188');
  }));
  const installation: ComfyDesktopInstallation = {
    installed: true,
    localBackendConfigured: false,
    updating: false,
    version: '1.0.39',
    missingModels: ['z_image_turbo_bf16.safetensors'],
  };

  const service = new ComfyService(
    undefined,
    'http://127.0.0.1:8188',
    () => installation,
  );
  await expect(service.refresh()).resolves.toMatchObject({
    state: 'detected',
    installed: true,
    server: false,
    version: '1.0.39',
    missingModels: ['z_image_turbo_bf16.safetensors'],
  });
  expect(service.health().message).toContain('Wykryto Comfy Desktop');
  expect(service.health().message).toContain('nie skonfigurowano lokalnej instancji ComfyUI');
  expect(service.health().message).toContain('Utwórz lokalną instalację');
});

it('odróżnia skonfigurowaną, ale wyłączoną lokalną instancję ComfyUI', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8188');
  }));
  const installation: ComfyDesktopInstallation = {
    installed: true,
    localBackendConfigured: true,
    updating: false,
    version: '1.0.39',
    missingModels: [],
  };

  const service = new ComfyService(
    undefined,
    'http://127.0.0.1:8188',
    () => installation,
  );
  await expect(service.refresh()).resolves.toMatchObject({
    state: 'detected', installed: true, server: false,
  });
  expect(service.health().message).toContain('skonfigurowaną lokalną instancję');
  expect(service.health().message).toContain('Uruchom tę instancję');
  expect(service.health().message).not.toContain('Utwórz lokalną instalację');
});

it('nie myli działającego standalone ComfyUI API z instalacją Comfy Desktop', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/system_stats') return jsonResponse({ system: { comfyui_version: '0.30.2' } });
    if (url.pathname.startsWith('/object_info/')) return jsonResponse({ available: {} });
    if (url.pathname === '/models/diffusion_models') return jsonResponse(['z_image_turbo_bf16.safetensors']);
    if (url.pathname === '/models/text_encoders') return jsonResponse(['qwen_3_4b.safetensors']);
    if (url.pathname === '/models/vae') return jsonResponse(['ae.safetensors']);
    if (url.pathname === '/models/background_removal') return jsonResponse(['birefnet.safetensors']);
    return new Response('not found', { status: 404 });
  }));
  const installation: ComfyDesktopInstallation = {
    installed: false,
    localBackendConfigured: false,
    updating: false,
    version: null,
    missingModels: [],
  };

  const service = new ComfyService(
    undefined,
    'http://127.0.0.1:8188',
    () => installation,
  );
  await expect(service.refresh()).resolves.toMatchObject({
    state: 'ready', installed: false, server: true,
  });
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
    assetName: 'Leśna chata', category: 'building', projection: 'isometric', prompt: 'Drewno i mech', feedback: '',
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

  const topDownOutput = path.join(root, 'top-down.png');
  submitted = null;
  await service.generate({
    assetName: 'Łąka', category: 'flat_tile', projection: 'top_down', prompt: 'Soczysta trawa', feedback: '',
    artBrief: '', styleSummary: '', outputPath: topDownOutput,
    outputSize: { width: 128, height: 128 }, roadAtlas: false, attempt: 1,
    verificationFeedback: '', signal: new AbortController().signal,
  });
  const topDownWorkflow = (submitted as unknown as Record<string, unknown>).prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  expect(topDownWorkflow['10']).toBeUndefined();
  expect(topDownWorkflow['14']).toMatchObject({ class_type: 'SaveImage', inputs: { images: ['9', 0] } });
  expect(topDownWorkflow['5'].inputs.text).toContain('square top-down terrain tile');

  const characterOutput = path.join(root, 'character.png');
  submitted = null;
  await service.generate({
    assetName: 'Strażniczka', category: 'character', projection: 'isometric', prompt: 'Czerwona peleryna', feedback: '',
    artBrief: '', styleSummary: '', outputPath: characterOutput,
    outputSize: { width: 576, height: 128 },
    characterAnimation: { action: 'walk', framesPerDirection: 8, framesPerSecond: 8 },
    roadAtlas: false, attempt: 1, verificationFeedback: '', signal: new AbortController().signal,
  });
  const characterWorkflow = (submitted as unknown as Record<string, unknown>).prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const characterPrompt = String(characterWorkflow['5'].inputs.text);
  expect(characterPrompt).toContain('9-column by 4-row');
  expect(characterPrompt).toContain('Every frame cell is exactly 64x32px');
  expect(characterPrompt).toContain('NW (north_west), NE (north_east), SE (south_east), SW (south_west)');
  expect(characterPrompt).toContain('Column 1 is one grounded idle pose');
  expect(characterPrompt).toContain('Columns 2-9 are exactly 8 chronological');
  expect(characterPrompt).toContain('make W8 loop smoothly into W1');
});

it('pozwala generować opaque top-down bez BiRefNet, ale blokuje workflow z przezroczystością', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-comfy-opaque-'));
  temporaryDirectories.push(root);
  const outputPath = path.join(root, 'top-down.png');
  const png = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 40, g: 100, b: 50, alpha: 1 } },
  }).png().toBuffer();
  let promptRequests = 0;

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
    if (url.pathname === '/prompt') {
      promptRequests += 1;
      return jsonResponse({ prompt_id: 'opaque-prompt' });
    }
    if (url.pathname === '/history/opaque-prompt') {
      return jsonResponse({
        'opaque-prompt': {
          status: { completed: true, status_str: 'success' },
          outputs: { '14': { images: [{ filename: 'opaque.png', type: 'output' }] } },
        },
      });
    }
    if (url.pathname === '/view') return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    return new Response('not found', { status: 404 });
  }));

  const service = new ComfyService(undefined, 'http://127.0.0.1:8188');
  await expect(service.refresh()).resolves.toMatchObject({
    state: 'ready', server: true,
    missingNodes: ['RemoveBackground'], missingModels: ['birefnet.safetensors'],
  });
  expect(service.health().message).toContain('gotowe dla nieprzezroczystych kafli top-down');

  await expect(service.generate({
    assetName: 'Łąka', category: 'flat_tile', projection: 'top_down', prompt: '', feedback: '',
    artBrief: '', styleSummary: '', outputPath, outputSize: { width: 64, height: 64 },
    roadAtlas: false, attempt: 1, verificationFeedback: '', signal: new AbortController().signal,
  })).resolves.toMatchObject({ promptId: 'opaque-prompt' });
  expect(existsSync(outputPath)).toBe(true);

  await expect(service.generate({
    assetName: 'Chata', category: 'building', projection: 'top_down', prompt: '', feedback: '',
    artBrief: '', styleSummary: '', outputPath: path.join(root, 'building.png'),
    outputSize: { width: 64, height: 64 }, roadAtlas: false, attempt: 1,
    verificationFeedback: '', signal: new AbortController().signal,
  })).rejects.toThrow(/Workflow z przezroczystością.*RemoveBackground.*birefnet/);
  expect(promptRequests).toBe(1);
});

it('nie oznacza ComfyUI jako gotowego, gdy brakuje zależności bazowego workflow', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/system_stats') return jsonResponse({ system: { comfyui_version: '0.30.2' } });
    if (url.pathname === '/object_info/KSampler') return jsonResponse({});
    if (url.pathname.startsWith('/object_info/')) return jsonResponse({ available: {} });
    if (url.pathname === '/models/diffusion_models') return jsonResponse([]);
    if (url.pathname === '/models/text_encoders') return jsonResponse(['qwen_3_4b.safetensors']);
    if (url.pathname === '/models/vae') return jsonResponse(['ae.safetensors']);
    if (url.pathname === '/models/background_removal') return jsonResponse(['birefnet.safetensors']);
    return new Response('not found', { status: 404 });
  }));

  const service = new ComfyService(undefined, 'http://127.0.0.1:8188');
  await expect(service.refresh()).resolves.toMatchObject({
    state: 'detected', server: true,
    missingNodes: ['KSampler'], missingModels: ['z_image_turbo_bf16.safetensors'],
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
