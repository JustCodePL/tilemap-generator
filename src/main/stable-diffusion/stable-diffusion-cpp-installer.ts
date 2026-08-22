import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import extractZip from 'extract-zip';
import type {
  StableDiffusionCppInstallEvent,
  StableDiffusionCppModelId,
  StableDiffusionCppModelOption,
  StableDiffusionCppSetupInfo,
} from '../../shared/domain';
import { stableDiffusionCppModelIds } from '../../shared/domain';
import { nullLogger, type Logger } from '../services/app-logger';

const GITHUB_RELEASE_API = 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest';
const Z_IMAGE_REVISION = 'c61c0e422dc8b541b7548cf33a4ef8302b0f8085';
const QWEN_REVISION = 'a06e946bb6b655725eafa393f4a9745d460374c9';
const COMFY_Z_IMAGE_REVISION = 'd24c4cf2a0cd98a42f23467e27e3d76ee9438b8e';
const MODEL_ORIGIN = 'https://huggingface.co';

export interface StableDiffusionCppManagedFile {
  role: 'model' | 'llm' | 'vae';
  fileName: string;
  relativePath: string;
  url: string;
  size: number;
  sha256: string;
  externalCandidates?: () => string[];
}

export interface StableDiffusionCppModelDefinition {
  id: StableDiffusionCppModelId;
  name: string;
  quantization: string;
  description: string;
  recommendedVramGb: number;
  files: StableDiffusionCppManagedFile[];
  usesExistingComfyModels: boolean;
}

interface InstallerConfig {
  selectedModelId?: StableDiffusionCppModelId;
  runtime?: { version: string; backend: 'vulkan'; executablePath: string };
}

export interface StableDiffusionCppRuntimeRelease {
  version: string;
  fileName: string;
  url: string;
  size: number;
  sha256: string;
}

export interface StableDiffusionCppHardwareInfo {
  gpuName: string | null;
  vramMb: number | null;
}

export interface StableDiffusionCppResolvedPaths {
  modelId: StableDiffusionCppModelId;
  executablePath: string;
  modelPath: string;
  llmPath: string;
  vaePath: string;
}

export interface StableDiffusionCppInstallerOptions {
  rootPath?: string;
  platform?: NodeJS.Platform;
  fetcher?: typeof fetch;
  extractArchive?: (archivePath: string, destinationPath: string) => Promise<void>;
  releaseResolver?: (signal: AbortSignal) => Promise<StableDiffusionCppRuntimeRelease>;
  hardwareDetector?: () => Promise<StableDiffusionCppHardwareInfo>;
  catalog?: StableDiffusionCppModelDefinition[];
}

export class StableDiffusionCppInstaller extends EventEmitter {
  readonly rootPath: string;
  private readonly fetcher: typeof fetch;
  private readonly extractArchive: (archivePath: string, destinationPath: string) => Promise<void>;
  private readonly releaseResolver: (signal: AbortSignal) => Promise<StableDiffusionCppRuntimeRelease>;
  private readonly hardwareDetector: () => Promise<StableDiffusionCppHardwareInfo>;
  private readonly catalog: StableDiffusionCppModelDefinition[];
  private readonly platform: NodeJS.Platform;
  private activeController: AbortController | null = null;
  private hardwarePromise: Promise<StableDiffusionCppHardwareInfo> | null = null;

  constructor(
    private readonly logger: Logger = nullLogger,
    options: StableDiffusionCppInstallerOptions = {},
  ) {
    super();
    this.platform = options.platform ?? process.platform;
    this.rootPath = options.rootPath ?? managedRoot(this.platform);
    this.fetcher = options.fetcher ?? fetch;
    this.extractArchive = options.extractArchive ?? ((archive, destination) => extractZip(archive, { dir: destination }));
    this.releaseResolver = options.releaseResolver ?? ((signal) => resolveLatestRuntime(this.fetcher, signal));
    this.hardwareDetector = options.hardwareDetector ?? (() => detectHardware(this.platform));
    this.catalog = options.catalog ?? createModelCatalog(this.platform);
  }

  async setup(): Promise<StableDiffusionCppSetupInfo> {
    const hardware = await this.hardware();
    const recommendedModelId = recommendModel(hardware.vramMb);
    const selectedModelId = this.selectedModelId();
    const executablePath = this.resolveExecutablePath();
    const config = this.readConfig();
    return {
      runtime: {
        installed: Boolean(executablePath && existsSync(executablePath)),
        version: config.runtime?.version ?? null,
        backend: 'vulkan',
        executablePath: executablePath || null,
      },
      hardware: {
        ...hardware,
        recommendedModelId,
        recommendation: recommendationText(hardware, recommendedModelId),
      },
      models: this.catalog.map((model) => this.modelOption(model, selectedModelId, recommendedModelId)),
      selectedModelId,
      installRoot: this.rootPath,
    };
  }

  resolveSelectedPaths(): StableDiffusionCppResolvedPaths {
    const modelId = this.selectedModelId();
    const model = this.requireModel(modelId);
    return {
      modelId,
      executablePath: this.resolveExecutablePath(),
      modelPath: this.resolveFile(model.files.find((file) => file.role === 'model')!),
      llmPath: this.resolveFile(model.files.find((file) => file.role === 'llm')!),
      vaePath: this.resolveFile(model.files.find((file) => file.role === 'vae')!),
    };
  }

  async install(modelId: StableDiffusionCppModelId): Promise<StableDiffusionCppSetupInfo> {
    if (this.platform !== 'win32') {
      throw new Error(
        'Zarządzana instalacja stable-diffusion.cpp jest dostępna tylko na Windows. '
        + 'Na macOS zainstaluj binarium sd-cli ręcznie i ustaw TILEMAP_SD_CPP_EXE.',
      );
    }
    if (this.activeController) throw new Error('Instalacja stable-diffusion.cpp już trwa.');
    const controller = new AbortController();
    this.activeController = controller;
    try {
      await this.installRuntime(controller.signal, modelId);
      await this.installModel(modelId, controller.signal);
      this.writeConfig({ ...this.readConfig(), selectedModelId: modelId });
      this.emitProgress({
        phase: 'completed', modelId, fileName: null, downloadedBytes: 1, totalBytes: 1,
        message: 'stable-diffusion.cpp i wybrany model są gotowe.',
      });
      return await this.setup();
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.emitProgress({
        phase: cancelled ? 'cancelled' : 'failed', modelId, fileName: null,
        downloadedBytes: 0, totalBytes: 0,
        message: cancelled ? 'Pobieranie zostało anulowane. Można je później wznowić.' : errorMessage(error),
      });
      if (cancelled) throw abortError();
      throw error;
    } finally {
      this.activeController = null;
    }
  }

  async selectModel(modelId: StableDiffusionCppModelId): Promise<StableDiffusionCppSetupInfo> {
    const model = this.requireModel(modelId);
    if (!this.isModelInstalled(model)) throw new Error('Najpierw pobierz wybrany model.');
    this.writeConfig({ ...this.readConfig(), selectedModelId: modelId });
    return this.setup();
  }

  cancel(): void {
    this.activeController?.abort();
  }

  private async installRuntime(signal: AbortSignal, modelId: StableDiffusionCppModelId): Promise<void> {
    const release = await this.releaseResolver(signal);
    assertRuntimeRelease(release);
    const current = this.readConfig().runtime;
    if (current?.version === release.version && existsSync(current.executablePath)) return;
    const downloadPath = path.join(this.rootPath, 'downloads', release.fileName);
    this.emitProgress({
      phase: 'runtime', modelId, fileName: release.fileName, downloadedBytes: 0, totalBytes: release.size,
      message: `Pobieranie stable-diffusion.cpp ${release.version} (Vulkan)…`,
    });
    await this.downloadFile(release.url, downloadPath, release.size, release.sha256, signal, 'runtime', modelId);
    const destination = path.join(this.rootPath, 'runtime', `${safeSegment(release.version)}-${randomUUID()}`);
    mkdirSync(destination, { recursive: true });
    this.emitProgress({
      phase: 'extracting', modelId, fileName: release.fileName,
      downloadedBytes: release.size, totalBytes: release.size, message: 'Rozpakowywanie silnika…',
    });
    await this.extractArchive(downloadPath, destination);
    const executablePath = findFile(destination, 'sd-cli.exe');
    if (!executablePath) throw new Error('Pobrany pakiet nie zawiera sd-cli.exe.');
    this.writeConfig({
      ...this.readConfig(),
      runtime: { version: release.version, backend: 'vulkan', executablePath },
    });
    rmSync(downloadPath, { force: true });
  }

  private async installModel(modelId: StableDiffusionCppModelId, signal: AbortSignal): Promise<void> {
    const model = this.requireModel(modelId);
    for (const file of model.files) {
      if (this.findExistingFile(file)) continue;
      const targetPath = path.join(this.rootPath, 'models', file.relativePath);
      this.emitProgress({
        phase: 'model', modelId, fileName: file.fileName, downloadedBytes: 0, totalBytes: file.size,
        message: `Pobieranie ${file.fileName}…`,
      });
      await this.downloadFile(file.url, targetPath, file.size, file.sha256, signal, 'model', modelId);
    }
  }

  private async downloadFile(
    url: string,
    targetPath: string,
    expectedSize: number,
    expectedSha256: string,
    signal: AbortSignal,
    phase: 'runtime' | 'model',
    modelId: StableDiffusionCppModelId,
  ): Promise<void> {
    assertDownloadUrl(url);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    if (existsSync(targetPath) && statSync(targetPath).size === expectedSize) return;
    const partialPath = `${targetPath}.part`;
    let existingBytes = existsSync(partialPath) ? statSync(partialPath).size : 0;
    if (existingBytes > expectedSize) {
      renameSync(partialPath, `${partialPath}.invalid-${Date.now()}`);
      existingBytes = 0;
    }
    if (existingBytes === expectedSize) {
      this.emitProgress({
        phase: 'verifying', modelId, fileName: path.basename(targetPath), downloadedBytes: expectedSize,
        totalBytes: expectedSize, message: `Weryfikacja wznowionego pliku: ${path.basename(targetPath)}…`,
      });
      const resumedSha256 = await hashFile(partialPath, signal);
      if (resumedSha256 === expectedSha256) {
        if (existsSync(targetPath)) renameSync(targetPath, `${targetPath}.replaced-${Date.now()}`);
        renameSync(partialPath, targetPath);
        return;
      }
      renameSync(partialPath, `${partialPath}.bad-hash-${Date.now()}`);
      existingBytes = 0;
    }
    ensureFreeSpace(this.rootPath, Math.max(1, expectedSize - existingBytes));
    const headers: Record<string, string> = { 'User-Agent': 'Tilemap-Generator/0.1' };
    if (existingBytes) headers.Range = `bytes=${existingBytes}-`;
    const response = await this.fetcher(url, { headers, signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Pobieranie nie powiodło się: HTTP ${response.status}.`);
    const resumed = existingBytes > 0 && response.status === 206;
    if (existingBytes > 0 && !resumed) {
      renameSync(partialPath, `${partialPath}.restart-${Date.now()}`);
      existingBytes = 0;
      ensureFreeSpace(this.rootPath, expectedSize);
    }
    let downloadedBytes = existingBytes;
    let lastProgressAt = 0;
    const progress = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastProgressAt >= 250 || downloadedBytes >= expectedSize) {
          lastProgressAt = now;
          this.emitProgress({
            phase, modelId, fileName: path.basename(targetPath), downloadedBytes,
            totalBytes: expectedSize, message: `Pobieranie ${path.basename(targetPath)}…`,
          });
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as never),
      progress,
      createWriteStream(partialPath, { flags: resumed ? 'a' : 'w' }),
      { signal },
    );
    if (statSync(partialPath).size !== expectedSize) {
      throw new Error(`Niepełny plik ${path.basename(targetPath)}: oczekiwano ${expectedSize} B.`);
    }
    this.emitProgress({
      phase: 'verifying', modelId, fileName: path.basename(targetPath), downloadedBytes: expectedSize,
      totalBytes: expectedSize, message: `Weryfikacja SHA-256: ${path.basename(targetPath)}…`,
    });
    const actualSha256 = await hashFile(partialPath, signal);
    if (actualSha256 !== expectedSha256) {
      renameSync(partialPath, `${partialPath}.bad-hash-${Date.now()}`);
      throw new Error(`Suma SHA-256 pliku ${path.basename(targetPath)} jest nieprawidłowa.`);
    }
    if (existsSync(targetPath)) renameSync(targetPath, `${targetPath}.replaced-${Date.now()}`);
    renameSync(partialPath, targetPath);
  }

  private modelOption(
    model: StableDiffusionCppModelDefinition,
    selectedModelId: StableDiffusionCppModelId,
    recommendedModelId: StableDiffusionCppModelId,
  ): StableDiffusionCppModelOption {
    const missing = model.files.filter((file) => !this.findExistingFile(file));
    return {
      id: model.id,
      name: model.name,
      quantization: model.quantization,
      description: model.description,
      recommendedVramGb: model.recommendedVramGb,
      totalSizeBytes: model.files.reduce((sum, file) => sum + file.size, 0),
      downloadBytesRemaining: missing.reduce((sum, file) => sum + file.size, 0),
      installed: missing.length === 0,
      selected: selectedModelId === model.id,
      recommended: recommendedModelId === model.id,
      usesExistingComfyModels: model.usesExistingComfyModels,
    };
  }

  private isModelInstalled(model: StableDiffusionCppModelDefinition): boolean {
    return model.files.every((file) => Boolean(this.findExistingFile(file)));
  }

  private resolveFile(file: StableDiffusionCppManagedFile): string {
    return this.findExistingFile(file) ?? path.join(this.rootPath, 'models', file.relativePath);
  }

  private findExistingFile(file: StableDiffusionCppManagedFile): string | null {
    const managed = path.join(this.rootPath, 'models', file.relativePath);
    if (fileMatches(managed, file.size)) return managed;
    for (const candidate of file.externalCandidates?.() ?? []) {
      if (fileMatches(candidate, file.size)) return candidate;
    }
    return null;
  }

  private selectedModelId(): StableDiffusionCppModelId {
    const configured = this.readConfig().selectedModelId;
    if (configured && stableDiffusionCppModelIds.includes(configured)) return configured;
    const bf16 = this.catalog.find((model) => model.id === 'z_image_turbo_bf16');
    return bf16 && this.isModelInstalled(bf16) ? 'z_image_turbo_bf16' : 'z_image_turbo_q4_k';
  }

  private resolveExecutablePath(): string {
    const explicit = process.env.TILEMAP_SD_CPP_EXE;
    if (explicit && existsSync(path.resolve(explicit))) return path.resolve(explicit);
    const configPath = this.readConfig().runtime?.executablePath;
    if (configPath && existsSync(configPath)) return configPath;
    const executableName = this.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
    const candidates = [
      path.join(process.cwd(), 'tools', 'stable-diffusion.cpp', executableName),
      path.join(process.cwd(), 'tools', 'stable-diffusion.cpp', 'bin', 'Release', executableName),
      path.join(this.rootPath, executableName),
      path.join(localApplicationDataRoot(this.platform), 'stable-diffusion.cpp', executableName),
      ...(this.platform === 'darwin' ? [
        path.join('/opt/homebrew/bin', executableName),
        path.join('/usr/local/bin', executableName),
      ] : []),
      ...String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, executableName)),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? (explicit ? path.resolve(explicit) : '');
  }

  private readConfig(): InstallerConfig {
    const configPath = path.join(this.rootPath, 'installation.json');
    if (!existsSync(configPath)) return {};
    try {
      return JSON.parse(readFileSync(configPath, 'utf8')) as InstallerConfig;
    } catch {
      return {};
    }
  }

  private writeConfig(config: InstallerConfig): void {
    mkdirSync(this.rootPath, { recursive: true });
    writeFileSync(path.join(this.rootPath, 'installation.json'), JSON.stringify(config, null, 2), 'utf8');
  }

  private requireModel(modelId: StableDiffusionCppModelId): StableDiffusionCppModelDefinition {
    const model = this.catalog.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`Nieznany profil stable-diffusion.cpp: ${modelId}.`);
    return model;
  }

  private hardware(): Promise<StableDiffusionCppHardwareInfo> {
    this.hardwarePromise ??= this.hardwareDetector().catch(() => ({ gpuName: null, vramMb: null }));
    return this.hardwarePromise;
  }

  private emitProgress(event: StableDiffusionCppInstallEvent): void {
    this.emit('install-event', event);
    this.logger.info('stable-diffusion-cpp.install', { ...event });
  }
}

function createModelCatalog(platform: NodeJS.Platform): StableDiffusionCppModelDefinition[] {
  const ggufModel = (quantization: 'Q3_K' | 'Q4_K' | 'Q6_K', size: number, sha256: string): StableDiffusionCppManagedFile => ({
    role: 'model',
    fileName: `z_image_turbo-${quantization}.gguf`,
    relativePath: path.join('diffusion_models', `z_image_turbo-${quantization}.gguf`),
    url: `${MODEL_ORIGIN}/leejet/Z-Image-Turbo-GGUF/resolve/${Z_IMAGE_REVISION}/z_image_turbo-${quantization}.gguf?download=true`,
    size,
    sha256,
  });
  const qwenGguf: StableDiffusionCppManagedFile = {
    role: 'llm',
    fileName: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    relativePath: path.join('text_encoders', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'),
    url: `${MODEL_ORIGIN}/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/${QWEN_REVISION}/Qwen3-4B-Instruct-2507-Q4_K_M.gguf?download=true`,
    size: 2_497_281_120,
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
  };
  const vae: StableDiffusionCppManagedFile = {
    role: 'vae',
    fileName: 'ae.safetensors',
    relativePath: path.join('vae', 'ae.safetensors'),
    url: `${MODEL_ORIGIN}/Comfy-Org/z_image_turbo/resolve/${COMFY_Z_IMAGE_REVISION}/split_files/vae/ae.safetensors?download=true`,
    size: 335_304_388,
    sha256: 'afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38',
    externalCandidates: () => [path.join(comfyModelsRoot(platform), 'vae', 'ae.safetensors')],
  };
  const bf16Model: StableDiffusionCppManagedFile = {
    role: 'model', fileName: 'z_image_turbo_bf16.safetensors',
    relativePath: path.join('diffusion_models', 'z_image_turbo_bf16.safetensors'),
    url: `${MODEL_ORIGIN}/Comfy-Org/z_image_turbo/resolve/${COMFY_Z_IMAGE_REVISION}/split_files/diffusion_models/z_image_turbo_bf16.safetensors?download=true`,
    size: 12_309_866_400,
    sha256: '2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6',
    externalCandidates: () => [path.join(comfyModelsRoot(platform), 'diffusion_models', 'z_image_turbo_bf16.safetensors')],
  };
  const bf16Llm: StableDiffusionCppManagedFile = {
    role: 'llm', fileName: 'qwen_3_4b.safetensors',
    relativePath: path.join('text_encoders', 'qwen_3_4b.safetensors'),
    url: `${MODEL_ORIGIN}/Comfy-Org/z_image_turbo/resolve/${COMFY_Z_IMAGE_REVISION}/split_files/text_encoders/qwen_3_4b.safetensors?download=true`,
    size: 8_044_982_048,
    sha256: '6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a',
    externalCandidates: () => [path.join(comfyModelsRoot(platform), 'text_encoders', 'qwen_3_4b.safetensors')],
  };
  return [
    {
      id: 'z_image_turbo_q3_k', name: 'Z-Image Turbo Q3_K', quantization: 'Q3_K',
      description: 'Oszczędny profil dla kart 4 GB. Najmniejszy rozsądny wariant do regularnej pracy.',
      recommendedVramGb: 4, files: [
        ggufModel('Q3_K', 3_143_559_104, '4b44bdaa7814f20d7cf144e3939bd93aa32f50660204dd0c2aea5c5376232980'),
        qwenGguf, vae,
      ], usesExistingComfyModels: false,
    },
    {
      id: 'z_image_turbo_q4_k', name: 'Z-Image Turbo Q4_K', quantization: 'Q4_K',
      description: 'Najlepszy balans jakości, szybkości i pamięci dla kart 6–8 GB.',
      recommendedVramGb: 6, files: [
        ggufModel('Q4_K', 3_864_250_304, '14b375ab4f226bc5378f68f37e899ef3c2242b8541e61e2bc1aff40976086fbd'),
        qwenGguf, vae,
      ], usesExistingComfyModels: false,
    },
    {
      id: 'z_image_turbo_q6_k', name: 'Z-Image Turbo Q6_K', quantization: 'Q6_K',
      description: 'Wyższa jakość kosztem większego pobierania i wolniejszego startu; najlepiej od 10 GB VRAM.',
      recommendedVramGb: 10, files: [
        ggufModel('Q6_K', 5_263_239_104, '319f627beac8059b7546f36a7b4d5097b7f4ee6a1fc37585d0f75ca1d12d01af'),
        qwenGguf, vae,
      ], usesExistingComfyModels: false,
    },
    {
      id: 'z_image_turbo_bf16', name: 'Z-Image Turbo BF16 (ComfyUI)', quantization: 'BF16',
      description: 'Oryginalne, bardzo duże pliki. Bez ponownego pobierania, jeśli są już zainstalowane przez ComfyUI.',
      recommendedVramGb: 16, files: [bf16Model, bf16Llm, vae], usesExistingComfyModels: true,
    },
  ];
}

async function resolveLatestRuntime(fetcher: typeof fetch, signal: AbortSignal): Promise<StableDiffusionCppRuntimeRelease> {
  const response = await fetcher(GITHUB_RELEASE_API, {
    signal,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Tilemap-Generator/0.1' },
  });
  if (!response.ok) throw new Error(`Nie udało się sprawdzić wydania stable-diffusion.cpp: HTTP ${response.status}.`);
  const release = await response.json() as {
    tag_name?: string;
    assets?: Array<{ name?: string; size?: number; digest?: string; browser_download_url?: string }>;
  };
  const asset = release.assets?.find((candidate) => /bin-win-vulkan-x64\.zip$/i.test(candidate.name ?? ''));
  const digest = asset?.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
  if (!release.tag_name || !asset?.name || !asset.browser_download_url || !asset.size || !digest) {
    throw new Error('Najnowsze wydanie nie zawiera kompletnego pakietu Windows Vulkan z sumą SHA-256.');
  }
  return {
    version: release.tag_name,
    fileName: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    sha256: digest,
  };
}

async function detectHardware(platform: NodeJS.Platform): Promise<StableDiffusionCppHardwareInfo> {
  if (platform !== 'win32') return { gpuName: null, vramMb: null };
  try {
    const output = await runSmallCommand('nvidia-smi.exe', [
      '--query-gpu=name,memory.total', '--format=csv,noheader,nounits',
    ]);
    const [firstLine] = output.split(/\r?\n/).filter(Boolean);
    const match = firstLine?.match(/^(.+),\s*(\d+)$/);
    if (match) return { gpuName: match[1].trim(), vramMb: Number(match[2]) };
  } catch {
    // Unknown or non-NVIDIA GPU: use the conservative recommendation below.
  }
  return { gpuName: null, vramMb: null };
}

function recommendModel(vramMb: number | null): StableDiffusionCppModelId {
  if (vramMb === null) return 'z_image_turbo_q3_k';
  if (vramMb < 5_500) return 'z_image_turbo_q3_k';
  if (vramMb < 9_500) return 'z_image_turbo_q4_k';
  return 'z_image_turbo_q6_k';
}

function recommendationText(hardware: StableDiffusionCppHardwareInfo, modelId: StableDiffusionCppModelId): string {
  const name = modelId === 'z_image_turbo_q4_k' ? 'Q4_K' : modelId === 'z_image_turbo_q6_k' ? 'Q6_K' : 'Q3_K';
  if (hardware.gpuName && hardware.vramMb) {
    return `${hardware.gpuName} · ${formatGb(hardware.vramMb * 1024 * 1024)} VRAM: polecam ${name}.`;
  }
  return `Nie udało się pewnie odczytać VRAM, dlatego polecam bezpieczny profil ${name}.`;
}

function managedRoot(platform: NodeJS.Platform): string {
  if (process.env.TILEMAP_SD_CPP_HOME) return path.resolve(process.env.TILEMAP_SD_CPP_HOME);
  return path.join(localApplicationDataRoot(platform), 'Tilemap Generator', 'stable-diffusion.cpp');
}

function comfyModelsRoot(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return path.join(localApplicationDataRoot(platform), 'ComfyUI', 'models');
  }
  return path.join(localApplicationDataRoot(platform), 'Comfy-Desktop', 'ComfyUI-Shared', 'models');
}

function localApplicationDataRoot(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  }
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
}

function fileMatches(filePath: string, expectedSize: number): boolean {
  try {
    return statSync(filePath).isFile() && statSync(filePath).size === expectedSize;
  } catch {
    return false;
  }
}

function findFile(rootPath: string, name: string): string | null {
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const candidate = path.join(rootPath, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return candidate;
    if (entry.isDirectory()) {
      const nested = findFile(candidate, name);
      if (nested) return nested;
    }
  }
  return null;
}

async function hashFile(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { signal })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function ensureFreeSpace(rootPath: string, requiredBytes: number): void {
  const existing = findExistingParent(rootPath);
  const stats = statfsSync(existing);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  if (freeBytes < requiredBytes * 1.1) {
    throw new Error(`Za mało wolnego miejsca. Potrzeba co najmniej ${formatGb(requiredBytes * 1.1)}.`);
  }
}

function findExistingParent(candidate: string): string {
  let current = path.resolve(candidate);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
  return current;
}

function assertRuntimeRelease(release: StableDiffusionCppRuntimeRelease): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(release.version)) throw new Error('Nieprawidłowa wersja pakietu runtime.');
  if (!/bin-win-vulkan-x64\.zip$/i.test(release.fileName)) throw new Error('Nieprawidłowy pakiet runtime.');
  assertDownloadUrl(release.url);
}

function assertDownloadUrl(value: string): void {
  const url = new URL(value);
  const githubRuntime = url.protocol === 'https:'
    && url.hostname === 'github.com'
    && url.pathname.startsWith('/leejet/stable-diffusion.cpp/releases/download/');
  const huggingFaceModel = url.protocol === 'https:' && url.hostname === 'huggingface.co';
  if (!githubRuntime && !huggingFaceModel) throw new Error('Instalator odrzucił nieautoryzowany adres pobierania.');
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function formatGb(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(1).replace('.', ',')} GB`;
}

function runSmallCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let output = '';
    const timeout = setTimeout(() => child.kill(), 5_000);
    child.stdout?.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-16_000); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} zakończył się kodem ${code}.`));
    });
  });
}

function abortError(): Error {
  const error = new Error('Instalacja została anulowana.');
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
