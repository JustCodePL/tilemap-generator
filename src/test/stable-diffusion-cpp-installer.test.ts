import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  StableDiffusionCppInstaller,
  type StableDiffusionCppManagedFile,
  type StableDiffusionCppModelDefinition,
} from '../main/stable-diffusion/stable-diffusion-cpp-installer';
import type { StableDiffusionCppInstallEvent } from '../shared/domain';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('rekomenduje Q4_K dla karty 6 GB i rozpoznaje istniejący profil BF16', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-sd-setup-'));
  temporaryDirectories.push(root);
  const externalRoot = path.join(root, 'comfy');
  const bf16Files = createTestFiles('bf16', externalRoot, true);
  const catalog: StableDiffusionCppModelDefinition[] = [
    createTestModel('z_image_turbo_q4_k', 'Q4_K', createTestFiles('q4', root, false)),
    createTestModel('z_image_turbo_bf16', 'BF16', bf16Files, true),
  ];
  const installer = new StableDiffusionCppInstaller(undefined, {
    rootPath: path.join(root, 'managed'),
    catalog,
    hardwareDetector: async () => ({ gpuName: 'NVIDIA GeForce GTX 1660', vramMb: 6144 }),
  });

  const setup = await installer.setup();
  expect(setup.hardware).toMatchObject({
    gpuName: 'NVIDIA GeForce GTX 1660', vramMb: 6144, recommendedModelId: 'z_image_turbo_q4_k',
  });
  expect(setup.hardware.recommendation).toContain('Q4_K');
  expect(setup.selectedModelId).toBe('z_image_turbo_bf16');
  expect(setup.models.find((model) => model.id === 'z_image_turbo_bf16')).toMatchObject({
    installed: true, selected: true, usesExistingComfyModels: true,
  });
  expect(setup.models.find((model) => model.id === 'z_image_turbo_q4_k')).toMatchObject({
    installed: false, recommended: true,
  });
});

it('pobiera runtime i model, weryfikuje SHA-256 oraz zapisuje wybór', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-sd-install-'));
  temporaryDirectories.push(root);
  const runtime = Buffer.from('test-runtime-archive');
  const model = Buffer.from('test-model');
  const llm = Buffer.from('test-llm');
  const vae = Buffer.from('test-vae');
  const urls = new Map<string, Buffer>([
    ['https://github.com/leejet/stable-diffusion.cpp/releases/download/test/sd-test-bin-win-vulkan-x64.zip', runtime],
    ['https://huggingface.co/test/model/resolve/revision/model.gguf', model],
    ['https://huggingface.co/test/model/resolve/revision/llm.gguf', llm],
    ['https://huggingface.co/test/model/resolve/revision/vae.safetensors', vae],
  ]);
  const catalog: StableDiffusionCppModelDefinition[] = [{
    id: 'z_image_turbo_q3_k', name: 'Test Q3_K', quantization: 'Q3_K', description: 'Test',
    recommendedVramGb: 4, usesExistingComfyModels: false,
    files: [
      testManagedFile('model', 'model.gguf', model),
      testManagedFile('llm', 'llm.gguf', llm),
      testManagedFile('vae', 'vae.safetensors', vae),
    ],
  }];
  const events: StableDiffusionCppInstallEvent[] = [];
  const installer = new StableDiffusionCppInstaller(undefined, {
    rootPath: path.join(root, 'managed'),
    catalog,
    hardwareDetector: async () => ({ gpuName: null, vramMb: 4096 }),
    fetcher: vi.fn(async (input: string | URL | Request) => {
      const body = urls.get(String(input));
      return body ? new Response(body.toString('utf8'), { status: 200 }) : new Response('not found', { status: 404 });
    }) as typeof fetch,
    releaseResolver: async () => ({
      version: 'test-release', fileName: 'sd-test-bin-win-vulkan-x64.zip',
      url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/test/sd-test-bin-win-vulkan-x64.zip',
      size: runtime.length, sha256: sha256(runtime),
    }),
    extractArchive: async (_archivePath, destinationPath) => {
      mkdirSync(path.join(destinationPath, 'bin'), { recursive: true });
      writeFileSync(path.join(destinationPath, 'bin', 'sd-cli.exe'), 'test executable');
    },
  });
  installer.on('install-event', (event: StableDiffusionCppInstallEvent) => events.push(event));

  const setup = await installer.install('z_image_turbo_q3_k');
  expect(setup.runtime).toMatchObject({ installed: true, version: 'test-release', backend: 'vulkan' });
  expect(setup.selectedModelId).toBe('z_image_turbo_q3_k');
  expect(setup.models[0]).toMatchObject({ installed: true, selected: true, downloadBytesRemaining: 0 });
  expect(events.map((event) => event.phase)).toEqual(expect.arrayContaining([
    'runtime', 'extracting', 'model', 'verifying', 'completed',
  ]));
  expect(installer.resolveSelectedPaths()).toMatchObject({
    modelId: 'z_image_turbo_q3_k',
    executablePath: expect.stringMatching(/sd-cli\.exe$/),
    modelPath: expect.stringMatching(/model\.gguf$/),
    llmPath: expect.stringMatching(/llm\.gguf$/),
    vaePath: expect.stringMatching(/vae\.safetensors$/),
  });
});

function createTestModel(
  id: StableDiffusionCppModelDefinition['id'],
  quantization: string,
  files: StableDiffusionCppManagedFile[],
  usesExistingComfyModels = false,
): StableDiffusionCppModelDefinition {
  return {
    id, name: `Test ${quantization}`, quantization, description: 'Testowy profil',
    recommendedVramGb: quantization === 'Q4_K' ? 6 : 16, files, usesExistingComfyModels,
  };
}

function createTestFiles(prefix: string, root: string, installed: boolean): StableDiffusionCppManagedFile[] {
  return (['model', 'llm', 'vae'] as const).map((role) => {
    const data = Buffer.from(`${prefix}-${role}`);
    const externalPath = path.join(root, `${prefix}-${role}.bin`);
    if (installed) {
      mkdirSync(root, { recursive: true });
      writeFileSync(externalPath, data);
    }
    return {
      role,
      fileName: `${prefix}-${role}.bin`,
      relativePath: path.join(prefix, `${role}.bin`),
      url: `https://huggingface.co/test/${prefix}/resolve/revision/${role}.bin`,
      size: data.length,
      sha256: sha256(data),
      externalCandidates: () => [externalPath],
    };
  });
}

function testManagedFile(
  role: StableDiffusionCppManagedFile['role'],
  fileName: string,
  data: Buffer,
): StableDiffusionCppManagedFile {
  return {
    role, fileName, relativePath: path.join(role, fileName),
    url: `https://huggingface.co/test/model/resolve/revision/${fileName}`,
    size: data.length, sha256: sha256(data),
  };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
