import { spawn } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type {
  AssetCategory,
  ProjectProjection,
  StableDiffusionCppHealth,
  StableDiffusionCppInstallEvent,
  StableDiffusionCppModelId,
  StableDiffusionCppSetupInfo,
} from '../../shared/domain';
import { nullLogger, type Logger } from '../services/app-logger';
import {
  StableDiffusionCppInstaller,
  type StableDiffusionCppResolvedPaths,
} from './stable-diffusion-cpp-installer';

const PROFILE = 'z_image_turbo';
const WORKFLOW_VERSION = 'stable-diffusion-cpp-z-image-turbo-chroma-v1';
const DEFAULT_MODEL = 'z_image_turbo_bf16.safetensors';
const DEFAULT_LLM = 'qwen_3_4b.safetensors';
const DEFAULT_VAE = 'ae.safetensors';
const GENERATION_TIMEOUT_MS = 25 * 60_000;
const CHROMA_BACKGROUND = '#ff00ff';

export interface StableDiffusionCppGenerationRequest {
  assetName: string;
  category: AssetCategory;
  projection: ProjectProjection;
  prompt: string;
  feedback: string;
  artBrief: string;
  styleSummary: string;
  outputPath: string;
  outputSize: { width: number; height: number } | null;
  roadAtlas: boolean;
  attempt: number;
  verificationFeedback: string;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface StableDiffusionCppGenerationResult {
  finalPath: string;
  runId: string;
  model: string;
  workflowHash: string;
  metadata: Record<string, unknown>;
}

interface ServicePaths {
  modelId: StableDiffusionCppModelId;
  executablePath: string;
  modelPath: string;
  llmPath: string;
  vaePath: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { signal: AbortSignal; onOutput?: (line: string) => void },
) => Promise<CommandResult>;

export interface StableDiffusionCppServiceOptions {
  executablePath?: string;
  modelPath?: string;
  llmPath?: string;
  vaePath?: string;
  commandRunner?: CommandRunner;
  installer?: StableDiffusionCppInstaller;
}

export class StableDiffusionCppService extends EventEmitter {
  private healthValue: StableDiffusionCppHealth;
  private paths: ServicePaths;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly commandRunner: CommandRunner;
  private readonly installer: StableDiffusionCppInstaller;
  private readonly pathOverrides: Pick<StableDiffusionCppServiceOptions, 'executablePath' | 'modelPath' | 'llmPath' | 'vaePath'>;

  constructor(
    private readonly logger: Logger = nullLogger,
    options: StableDiffusionCppServiceOptions = {},
  ) {
    super();
    this.installer = options.installer ?? new StableDiffusionCppInstaller(logger);
    this.pathOverrides = options;
    this.paths = resolvePaths(this.pathOverrides, this.installer.resolveSelectedPaths());
    this.commandRunner = options.commandRunner ?? runCommand;
    this.healthValue = checkingHealth(this.paths);
    this.installer.on('install-event', (event: StableDiffusionCppInstallEvent) => this.emit('install-event', event));
  }

  health(): StableDiffusionCppHealth {
    return this.healthValue;
  }

  async refresh(): Promise<StableDiffusionCppHealth> {
    this.paths = resolvePaths(this.pathOverrides, this.installer.resolveSelectedPaths());
    const executableName = path.basename(
      this.paths.executablePath || (process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'),
    );
    const missingFiles = [
      [executableName, this.paths.executablePath],
      [path.basename(this.paths.modelPath || DEFAULT_MODEL), this.paths.modelPath],
      [path.basename(this.paths.llmPath || DEFAULT_LLM), this.paths.llmPath],
      [path.basename(this.paths.vaePath || DEFAULT_VAE), this.paths.vaePath],
    ].filter(([, filePath]) => !filePath || !existsSync(filePath)).map(([label]) => label);
    const installed = Boolean(this.paths.executablePath && existsSync(this.paths.executablePath));
    const ready = installed && missingFiles.length === 0;
    this.healthValue = {
      state: ready ? 'ready' : installed ? 'detected' : 'unavailable',
      installed,
      executablePath: this.paths.executablePath || null,
      profile: PROFILE,
      model: path.basename(this.paths.modelPath || DEFAULT_MODEL),
      llm: path.basename(this.paths.llmPath || DEFAULT_LLM),
      vae: path.basename(this.paths.vaePath || DEFAULT_VAE),
      missingFiles,
      message: ready
        ? 'stable-diffusion.cpp i profil Z-Image Turbo są gotowe.'
        : installed
          ? `Wykryto stable-diffusion.cpp, ale brakuje plików: ${missingFiles.join(', ')}.`
          : `Nie wykryto ${executableName}. Ustaw TILEMAP_SD_CPP_EXE albo umieść program w katalogu tools/stable-diffusion.cpp.`,
    };
    this.logger.info('stable-diffusion-cpp.health', {
      state: this.healthValue.state,
      executablePath: this.healthValue.executablePath,
      model: this.healthValue.model,
      missingFiles,
    });
    return this.healthValue;
  }

  setup(): Promise<StableDiffusionCppSetupInfo> {
    return this.installer.setup();
  }

  async install(modelId: StableDiffusionCppModelId): Promise<StableDiffusionCppSetupInfo> {
    const setup = await this.installer.install(modelId);
    await this.refresh();
    return setup;
  }

  async selectModel(modelId: StableDiffusionCppModelId): Promise<StableDiffusionCppSetupInfo> {
    const setup = await this.installer.selectModel(modelId);
    await this.refresh();
    return setup;
  }

  cancelInstall(): void {
    this.installer.cancel();
  }

  generate(request: StableDiffusionCppGenerationRequest): Promise<StableDiffusionCppGenerationResult> {
    const operation = this.serial.then(
      () => this.generateExclusive(request),
      () => this.generateExclusive(request),
    );
    this.serial = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async generateExclusive(
    request: StableDiffusionCppGenerationRequest,
  ): Promise<StableDiffusionCppGenerationResult> {
    if (request.signal.aborted) throw abortError();
    if (this.healthValue.state !== 'ready') {
      const refreshed = await this.refresh();
      if (refreshed.state !== 'ready') throw new Error(refreshed.message);
    }
    const activePaths = { ...this.paths };

    const runId = randomUUID();
    const seed = randomInt(0, 0x7fffffff);
    const steps = 8;
    const cfg = 1;
    const samplingMethod = 'euler';
    const generationSize = chooseGenerationSize(request.outputSize);
    const transparentOutput = !request.roadAtlas
      && !(request.projection === 'top_down' && request.category === 'flat_tile');
    const prompt = buildPrompt(request);
    const rawPath = `${request.outputPath}.sd-cpp-raw.png`;
    const args = [
      '--diffusion-model', activePaths.modelPath,
      '--vae', activePaths.vaePath,
      '--llm', activePaths.llmPath,
      '-p', prompt,
      '--cfg-scale', String(cfg),
      '--steps', String(steps),
      '--sampling-method', samplingMethod,
      '--seed', String(seed),
      '--rng', 'cpu',
      '--offload-to-cpu',
      '--vae-on-cpu',
      '--diffusion-fa',
      '-W', String(generationSize.width),
      '-H', String(generationSize.height),
      '-o', rawPath,
    ];
    const workflowHash = createHash('sha256').update(JSON.stringify({
      version: WORKFLOW_VERSION,
      model: path.basename(activePaths.modelPath),
      llm: path.basename(activePaths.llmPath),
      vae: path.basename(activePaths.vaePath),
      steps,
      cfg,
      samplingMethod,
      width: generationSize.width,
      height: generationSize.height,
      transparent: transparentOutput,
    })).digest('hex');

    request.onProgress?.('stable-diffusion.cpp uruchamia Z-Image Turbo.');
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), GENERATION_TIMEOUT_MS);
    const signal = combineSignals(request.signal, timeoutController.signal);
    let lastProgressAt = 0;
    try {
      const command = await this.commandRunner(activePaths.executablePath, args, {
        signal,
        onOutput: (line) => {
          const now = Date.now();
          if (now - lastProgressAt < 1_000 || !/step|sample|denois|decode|\d+%/i.test(line)) return;
          lastProgressAt = now;
          request.onProgress?.(`stable-diffusion.cpp: ${line.slice(0, 240)}`);
        },
      });
      if (!existsSync(rawPath)) {
        throw new Error(`stable-diffusion.cpp nie zapisał pliku wynikowego. ${command.stderr.slice(-2_000)}`.trim());
      }
      request.onProgress?.(request.roadAtlas
        ? 'stable-diffusion.cpp zapisał materiał drogi.'
        : transparentOutput
          ? 'Usuwanie jednolitego tła i dopasowanie canvasu…'
          : 'Dopasowanie pełnokadrowego terenu do canvasu…');
      if (request.roadAtlas) {
        copyFileSync(rawPath, request.outputPath);
      } else if (!transparentOutput) {
        if (request.outputSize) {
          await sharp(rawPath)
            .resize(request.outputSize.width, request.outputSize.height, { fit: 'fill' })
            .png()
            .toFile(request.outputPath);
        } else {
          copyFileSync(rawPath, request.outputPath);
        }
      } else {
        const keyedPath = `${request.outputPath}.sd-cpp-alpha.png`;
        const keyColor = await removeConnectedBackground(rawPath, keyedPath);
        if (request.outputSize) {
          await sharp(keyedPath)
            .resize(request.outputSize.width, request.outputSize.height, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toFile(request.outputPath);
        } else {
          copyFileSync(keyedPath, request.outputPath);
        }
        this.logger.info('stable-diffusion-cpp.background-removed', { runId, keyColor });
      }
      return {
        finalPath: request.outputPath,
        runId,
        model: path.basename(activePaths.modelPath),
        workflowHash,
        metadata: {
          profile: PROFILE,
          modelId: activePaths.modelId,
          executable: activePaths.executablePath,
          model: path.basename(activePaths.modelPath),
          llm: path.basename(activePaths.llmPath),
          vae: path.basename(activePaths.vaePath),
          seed,
          steps,
          cfg,
          samplingMethod,
          generationWidth: generationSize.width,
          generationHeight: generationSize.height,
          chromaBackground: transparentOutput ? CHROMA_BACKGROUND : null,
          workflowVersion: WORKFLOW_VERSION,
        },
      };
    } catch (error) {
      if (timeoutController.signal.aborted && !request.signal.aborted) {
        throw new Error('Generacja stable-diffusion.cpp przekroczyła limit 25 minut.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function buildPrompt(request: StableDiffusionCppGenerationRequest): string {
  const isTopDown = request.projection === 'top_down';
  const opaqueTerrain = isTopDown && request.category === 'flat_tile';
  const typeInstruction = request.roadAtlas
    ? `Create one full-frame, opaque, edge-to-edge material sample for a ${isTopDown ? 'top-down' : 'isometric'} road surface. Show only the road material texture: no road shape, no tile, no atlas, no transparency, no border and no background.`
    : request.category === 'flat_tile'
      ? isTopDown
        ? 'Create one seamless square top-down terrain tile that fills the complete canvas, including all four corners. Match left to right and top to bottom edges without a border or shadow.'
        : 'Create one seamless 2:1 isometric terrain diamond that reaches the horizontal and vertical center points of the canvas and tiles without gaps.'
      : request.category === 'elevated_tile'
        ? 'Create one elevated 2:1 isometric terrain tile with a readable top diamond and vertical walls.'
        : `Create one isolated game asset in a fixed ${isTopDown ? 'orthographic top-down' : 'isometric'} view.`;
  return [
    `Asset: ${request.assetName}`,
    `Category: ${request.category}`,
    typeInstruction,
    request.prompt ? `User request: ${request.prompt}` : '',
    request.feedback ? `Iteration feedback: ${request.feedback}` : '',
    request.artBrief ? `Project art direction: ${request.artBrief}` : '',
    request.styleSummary ? `Established project style: ${request.styleSummary}` : '',
    request.verificationFeedback ? `The previous attempt failed deterministic validation. Correct this exact issue: ${request.verificationFeedback}` : '',
    `Centered composition, ${isTopDown ? 'straight overhead orthographic top-down' : 'orthographic isometric'} camera, no text, no frame, no UI, no cast shadow outside the object.`,
    request.roadAtlas || opaqueTerrain
      ? 'Fill the entire frame with useful opaque material. Do not add a background or leave empty margins.'
      : `Use a perfectly flat, uniform ${CHROMA_BACKGROUND} magenta background. No gradient, texture, horizon, floor or shadow in the background. Do not use magenta in the asset itself. The application removes only background connected to the canvas border.`,
  ].filter(Boolean).join('\n\n');
}

export function chooseGenerationSize(target: { width: number; height: number } | null): { width: number; height: number } {
  if (!target) return { width: 1024, height: 1024 };
  const longest = Math.max(target.width, target.height);
  const scale = longest < 1024 ? 1024 / longest : longest > 1536 ? 1536 / longest : 1;
  return {
    width: clamp(roundTo64(target.width * scale), 256, 1536),
    height: clamp(roundTo64(target.height * scale), 256, 1536),
  };
}

async function removeConnectedBackground(
  inputPath: string,
  outputPath: string,
): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const channels = info.channels;
  const samples: Array<[number, number, number]> = [];
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 64));
  const sample = (x: number, y: number) => {
    const offset = (y * width + x) * channels;
    samples.push([data[offset], data[offset + 1], data[offset + 2]]);
  };
  for (let x = 0; x < width; x += stride) { sample(x, 0); sample(x, height - 1); }
  for (let y = 0; y < height; y += stride) { sample(0, y); sample(width - 1, y); }
  const background = {
    r: median(samples.map((value) => value[0])),
    g: median(samples.map((value) => value[1])),
    b: median(samples.map((value) => value[2])),
  };

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const distance = (index: number) => {
    const offset = index * channels;
    return Math.sqrt(
      (data[offset] - background.r) ** 2
      + (data[offset + 1] - background.g) ** 2
      + (data[offset + 2] - background.b) ** 2,
    );
  };
  const enqueue = (index: number) => {
    if (visited[index] || distance(index) > 130) return;
    visited[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x += 1) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }
  for (let index = 0; index < visited.length; index += 1) {
    if (!visited[index]) continue;
    const alpha = Math.round(255 * clamp((distance(index) - 28) / (130 - 28), 0, 1));
    data[index * channels + 3] = Math.min(data[index * channels + 3], alpha);
  }
  await sharp(data, { raw: info }).png().toFile(outputPath);
  return background;
}

function resolvePaths(
  options: Pick<StableDiffusionCppServiceOptions, 'executablePath' | 'modelPath' | 'llmPath' | 'vaePath'>,
  managed: StableDiffusionCppResolvedPaths,
): ServicePaths {
  return {
    modelId: managed.modelId,
    executablePath: options.executablePath || managed.executablePath,
    modelPath: options.modelPath || process.env.TILEMAP_SD_CPP_MODEL || managed.modelPath,
    llmPath: options.llmPath || process.env.TILEMAP_SD_CPP_LLM || managed.llmPath,
    vaePath: options.vaePath || process.env.TILEMAP_SD_CPP_VAE || managed.vaePath,
  };
}

function checkingHealth(paths: ServicePaths): StableDiffusionCppHealth {
  return {
    state: 'checking', installed: false, executablePath: paths.executablePath || null,
    profile: PROFILE, model: path.basename(paths.modelPath || DEFAULT_MODEL),
    llm: path.basename(paths.llmPath || DEFAULT_LLM), vae: path.basename(paths.vaePath || DEFAULT_VAE),
    missingFiles: [], message: 'Sprawdzanie stable-diffusion.cpp…',
  };
}

function runCommand(
  command: string,
  args: string[],
  options: { signal: AbortSignal; onOutput?: (line: string) => void },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) { reject(abortError()); return; }
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const capture = (kind: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const value = String(chunk);
      if (kind === 'stdout') stdout = `${stdout}${value}`.slice(-16_000);
      else stderr = `${stderr}${value}`.slice(-16_000);
      for (const line of value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) options.onOutput?.(line);
    };
    child.stdout?.on('data', (chunk) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk) => capture('stderr', chunk));
    const abort = () => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(abortError());
    };
    options.signal.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', abort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`stable-diffusion.cpp zakończył się kodem ${code}. ${(stderr || stdout).slice(-4_000)}`));
    });
  });
}

function combineSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) abort();
  else {
    first.addEventListener('abort', abort, { once: true });
    second.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

function abortError(): Error {
  const error = new Error('Generacja stable-diffusion.cpp została anulowana.');
  error.name = 'AbortError';
  return error;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function roundTo64(value: number): number {
  return Math.max(64, Math.round(value / 64) * 64);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
