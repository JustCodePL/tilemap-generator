import { createHash, randomInt, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type {
  AssetCategory,
  CharacterAnimationSettings,
  ComfyUiHealth,
  ComfyUiProfile,
  ProjectProjection,
} from '../../shared/domain';
import { characterDirectionsForProjection } from '../../shared/domain';
import { nullLogger, type Logger } from '../services/app-logger';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8188';
const PROFILE: ComfyUiProfile = 'z_image_turbo';
const PROFILE_MODEL = 'z_image_turbo_bf16.safetensors';
const PROFILE_CLIP = 'qwen_3_4b.safetensors';
const PROFILE_VAE = 'ae.safetensors';
const BACKGROUND_MODEL = 'birefnet.safetensors';
const WORKFLOW_VERSION = 'z-image-turbo-transparent-v1';
const OUTPUT_NODE_ID = '14';
const CORE_NODES = [
  'UNETLoader',
  'CLIPLoader',
  'VAELoader',
  'ModelSamplingAuraFlow',
  'CLIPTextEncode',
  'ConditioningZeroOut',
  'EmptySD3LatentImage',
  'KSampler',
  'VAEDecode',
  'SaveImage',
] as const;
const TRANSPARENCY_NODES = [
  'LoadBackgroundRemovalModel',
  'RemoveBackground',
  'InvertMask',
  'JoinImageWithAlpha',
] as const;
const REQUIRED_NODES = [...CORE_NODES, ...TRANSPARENCY_NODES] as const;
const TRANSPARENCY_NODE_NAMES = new Set<string>(TRANSPARENCY_NODES);

export interface ComfyGenerationRequest {
  assetName: string;
  category: AssetCategory;
  projection: ProjectProjection;
  prompt: string;
  feedback: string;
  artBrief: string;
  styleSummary: string;
  outputPath: string;
  outputSize: { width: number; height: number } | null;
  characterAnimation?: CharacterAnimationSettings | null;
  roadAtlas: boolean;
  attempt: number;
  verificationFeedback: string;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ComfyGenerationResult {
  finalPath: string;
  promptId: string;
  model: string;
  workflowHash: string;
  metadata: Record<string, unknown>;
}

export interface ComfyDesktopInstallation {
  installed: boolean;
  localBackendConfigured: boolean;
  updating: boolean;
  version: string | null;
  missingModels: string[];
}

export interface ComfyDesktopDetectionOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  macApplicationDirectories?: string[];
}

interface ComfyImageDescriptor {
  filename: string;
  subfolder?: string;
  type?: string;
}

export class ComfyService {
  private healthValue: ComfyUiHealth;
  private endpointValue: string;
  private readonly autoDetectEndpoint: boolean;

  constructor(
    private readonly logger: Logger = nullLogger,
    endpoint?: string,
    private readonly detectInstallation: () => ComfyDesktopInstallation = detectDesktopInstallation,
  ) {
    const configuredEndpoint = endpoint ?? process.env.TILEMAP_COMFY_URL ?? DEFAULT_ENDPOINT;
    this.endpointValue = normalizeLoopbackEndpoint(configuredEndpoint);
    this.autoDetectEndpoint = endpoint === undefined && !process.env.TILEMAP_COMFY_URL;
    this.healthValue = checkingHealth(this.endpointValue);
  }

  get endpoint(): string {
    return this.endpointValue;
  }

  health(): ComfyUiHealth {
    return this.healthValue;
  }

  async refresh(): Promise<ComfyUiHealth> {
    this.healthValue = checkingHealth(this.endpoint);
    const installation = this.detectInstallation();
    try {
      let system: Record<string, unknown>;
      try {
        system = await this.requestJson('/system_stats', { timeoutMs: 3_000 }) as Record<string, unknown>;
      } catch (initialError) {
        const detectedEndpoint = this.autoDetectEndpoint
          ? await findRunningComfyEndpoint(this.endpoint)
          : null;
        if (!detectedEndpoint) throw initialError;
        this.endpointValue = detectedEndpoint;
        system = await this.requestJson('/system_stats', { timeoutMs: 3_000 }) as Record<string, unknown>;
      }
      const [missingNodes, missingModels] = await Promise.all([
        this.findMissingNodes(),
        this.findMissingModels(),
      ]);
      const systemInfo = system.system as Record<string, unknown> | undefined;
      const version = typeof systemInfo?.comfyui_version === 'string' ? systemInfo.comfyui_version : null;
      const missingCoreNodes = missingNodes.filter((node) => !TRANSPARENCY_NODE_NAMES.has(node));
      const missingCoreModels = missingModels.filter((model) => model !== BACKGROUND_MODEL);
      const ready = missingCoreNodes.length === 0 && missingCoreModels.length === 0;
      const missingTransparencyNodes = missingNodes.filter((node) => TRANSPARENCY_NODE_NAMES.has(node));
      const missingTransparencyModels = missingModels.filter((model) => model === BACKGROUND_MODEL);
      this.healthValue = {
        state: ready ? 'ready' : 'detected',
        installed: installation.installed,
        server: true,
        endpoint: this.endpoint,
        version,
        profile: PROFILE,
        model: PROFILE_MODEL,
        missingNodes,
        missingModels,
        message: ready
          ? missingTransparencyNodes.length || missingTransparencyModels.length
            ? `ComfyUI i profil Z-Image Turbo są gotowe dla nieprzezroczystych kafli top-down i materiałów dróg. Assety z przezroczystością wymagają: ${[
              missingTransparencyNodes.length ? `node'ów ${missingTransparencyNodes.join(', ')}` : '',
              missingTransparencyModels.length ? `modeli ${missingTransparencyModels.join(', ')}` : '',
            ].filter(Boolean).join('; ')}.`
            : `ComfyUI i profil Z-Image Turbo są gotowe pod ${this.endpoint}.`
          : `ComfyUI odpowiada, ale profil Z-Image Turbo jest niekompletny: ${[
            missingCoreNodes.length ? `brak node'ów: ${missingCoreNodes.join(', ')}` : '',
            missingCoreModels.length ? `brak modeli: ${missingCoreModels.join(', ')}` : '',
          ].filter(Boolean).join('; ')}.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.healthValue = {
        state: installation.installed ? 'detected' : 'unavailable',
        installed: installation.installed,
        server: false,
        endpoint: this.endpoint,
        version: installation.version,
        profile: PROFILE,
        model: PROFILE_MODEL,
        missingNodes: [],
        missingModels: installation.missingModels,
        message: installation.installed
          ? installation.localBackendConfigured
            ? `Wykryto Comfy Desktop${installation.updating ? ' (aktualizacja w toku)' : ''} i skonfigurowaną lokalną instancję, ale jej serwer nie odpowiada pod ${this.endpoint}. Uruchom tę instancję w Comfy Desktop.`
            : 'Wykryto Comfy Desktop, ale nie skonfigurowano lokalnej instancji ComfyUI. Utwórz lokalną instalację w Comfy Desktop i uruchom ją.'
          : `Nie wykryto działającego ComfyUI pod ${this.endpoint}.`,
      };
      this.logger.warn('comfy.health.unavailable', { endpoint: this.endpoint, message });
    }
    this.logger.info('comfy.health', {
      state: this.healthValue.state,
      endpoint: this.endpoint,
      model: PROFILE_MODEL,
      missingNodes: this.healthValue.missingNodes,
      missingModels: this.healthValue.missingModels,
    });
    return this.healthValue;
  }

  async generate(request: ComfyGenerationRequest): Promise<ComfyGenerationResult> {
    const transparentOutput = !request.roadAtlas
      && !(request.projection === 'top_down' && request.category === 'flat_tile');
    if (this.healthValue.state !== 'ready') {
      throw new Error(this.healthValue.message || 'ComfyUI nie jest gotowe.');
    }
    if (transparentOutput) {
      const missingNodes = this.healthValue.missingNodes.filter((node) => TRANSPARENCY_NODE_NAMES.has(node));
      const missingModels = this.healthValue.missingModels.filter((model) => model === BACKGROUND_MODEL);
      if (missingNodes.length || missingModels.length) {
        throw new Error(`Workflow z przezroczystością wymaga dodatkowych zależności ComfyUI: ${[
          missingNodes.length ? `node'ów ${missingNodes.join(', ')}` : '',
          missingModels.length ? `modeli ${missingModels.join(', ')}` : '',
        ].filter(Boolean).join('; ')}.`);
      }
    }
    const seed = randomInt(0, 0x7fffffff);
    const steps = 8;
    const cfg = 1;
    const sampler = 'res_multistep';
    const scheduler = 'simple';
    const generationSize = chooseGenerationSize(request.outputSize);
    const prompt = buildPrompt(request);
    const workflow = buildWorkflow({
      prompt,
      width: generationSize.width,
      height: generationSize.height,
      seed,
      steps,
      cfg,
      sampler,
      scheduler,
      filenamePrefix: `TilemapGenerator/${randomUUID()}`,
      transparent: transparentOutput,
    });
    const workflowHash = createHash('sha256').update(WORKFLOW_VERSION).digest('hex');
    request.onProgress?.('ComfyUI przyjęło workflow Z-Image Turbo.');

    let promptId = '';
    try {
      const queued = await this.requestJson('/prompt', {
        method: 'POST',
        body: JSON.stringify({ client_id: randomUUID(), prompt: workflow }),
        signal: request.signal,
        timeoutMs: 30_000,
      }) as Record<string, unknown>;
      promptId = typeof queued.prompt_id === 'string' ? queued.prompt_id : '';
      if (!promptId) {
        const nodeErrors = queued.node_errors ? JSON.stringify(queued.node_errors) : 'brak prompt_id';
        throw new Error(`ComfyUI odrzuciło workflow: ${nodeErrors}`);
      }
      request.onProgress?.(`ComfyUI generuje wariant (${promptId.slice(0, 8)}).`);
      const image = await this.waitForOutput(promptId, request.signal, request.onProgress);
      const query = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder ?? '',
        type: image.type ?? 'output',
      });
      const response = await this.fetch(`/view?${query.toString()}`, {
        signal: request.signal,
        timeoutMs: 60_000,
      });
      const rawPath = `${request.outputPath}.comfy-raw.png`;
      writeFileSync(rawPath, Buffer.from(await response.arrayBuffer()));
      if (request.outputSize && !request.roadAtlas) {
        await sharp(rawPath)
          .ensureAlpha()
          .resize(request.outputSize.width, request.outputSize.height, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toFile(request.outputPath);
      } else {
        copyFileSync(rawPath, request.outputPath);
      }
      return {
        finalPath: request.outputPath,
        promptId,
        model: PROFILE_MODEL,
        workflowHash,
        metadata: {
          profile: PROFILE,
          model: PROFILE_MODEL,
          clip: PROFILE_CLIP,
          vae: PROFILE_VAE,
          backgroundRemovalModel: transparentOutput ? BACKGROUND_MODEL : null,
          seed,
          steps,
          cfg,
          sampler,
          scheduler,
          generationWidth: generationSize.width,
          generationHeight: generationSize.height,
          endpoint: this.endpoint,
          comfyUiVersion: this.healthValue.version,
          workflowVersion: WORKFLOW_VERSION,
        },
      };
    } catch (error) {
      if (request.signal.aborted && promptId) {
        void this.requestJson('/interrupt', { method: 'POST', body: '{}', timeoutMs: 5_000 }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async findMissingNodes(): Promise<string[]> {
    const results = await Promise.all(REQUIRED_NODES.map(async (node) => {
      try {
        const value = await this.requestJson(`/object_info/${encodeURIComponent(node)}`, { timeoutMs: 5_000 });
        return value && typeof value === 'object' && Object.keys(value as object).length > 0 ? null : node;
      } catch {
        return node;
      }
    }));
    return results.filter((node): node is Exclude<typeof node, null> => node !== null);
  }

  private async findMissingModels(): Promise<string[]> {
    const requirements = [
      ['diffusion_models', PROFILE_MODEL],
      ['text_encoders', PROFILE_CLIP],
      ['vae', PROFILE_VAE],
      ['background_removal', BACKGROUND_MODEL],
    ] as const;
    const missing: string[] = [];
    await Promise.all(requirements.map(async ([folder, model]) => {
      try {
        const values = await this.requestJson(`/models/${folder}`, { timeoutMs: 5_000 });
        if (!Array.isArray(values) || !values.some((value) => String(value).replaceAll('\\', '/') === model)) missing.push(model);
      } catch {
        missing.push(model);
      }
    }));
    return missing.sort();
  }

  private async waitForOutput(
    promptId: string,
    signal: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<ComfyImageDescriptor> {
    const deadline = Date.now() + 25 * 60_000;
    let lastNode = '';
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortError();
      const history = await this.requestJson(`/history/${encodeURIComponent(promptId)}`, {
        signal,
        timeoutMs: 15_000,
      }) as Record<string, unknown>;
      const entry = (history[promptId] ?? history) as Record<string, unknown>;
      const status = entry.status as Record<string, unknown> | undefined;
      if (status?.status_str === 'error' || status?.completed === false && status?.status_str === 'failed') {
        throw new Error(`ComfyUI zakończyło workflow błędem: ${JSON.stringify(status)}`);
      }
      const outputs = entry.outputs as Record<string, unknown> | undefined;
      const image = findOutputImage(outputs?.[OUTPUT_NODE_ID] ?? outputs);
      if (image) return image;
      const node = typeof status?.status_str === 'string' ? status.status_str : '';
      if (node && node !== lastNode) {
        lastNode = node;
        onProgress?.(`ComfyUI: ${node}.`);
      }
      await abortableDelay(750, signal);
    }
    throw new Error('Generacja ComfyUI przekroczyła limit 25 minut.');
  }

  private async requestJson(relativeUrl: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<unknown> {
    const response = await this.fetch(relativeUrl, options);
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`ComfyUI zwróciło niepoprawny JSON dla ${relativeUrl}.`);
    }
  }

  private async fetch(relativeUrl: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), options.timeoutMs ?? 10_000);
    const signal = combineSignals(options.signal, timeoutController.signal);
    try {
      const response = await fetch(`${this.endpoint}${relativeUrl}`, {
        ...options,
        headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
        signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 4_000);
        throw new Error(`ComfyUI ${response.status} dla ${relativeUrl}: ${detail || response.statusText}`);
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildWorkflow(input: {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  filenamePrefix: string;
  transparent: boolean;
}): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: PROFILE_MODEL, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: PROFILE_CLIP, type: 'lumina2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: PROFILE_VAE } },
    '4': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
    '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: input.prompt } },
    '6': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } },
    '7': { class_type: 'EmptySD3LatentImage', inputs: { width: input.width, height: input.height, batch_size: 1 } },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0],
        seed: input.seed, steps: input.steps, cfg: input.cfg,
        sampler_name: input.sampler, scheduler: input.scheduler, denoise: 1,
      },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
  };
  if (input.transparent) {
    workflow['10'] = { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: BACKGROUND_MODEL } };
    workflow['11'] = { class_type: 'RemoveBackground', inputs: { image: ['9', 0], bg_removal_model: ['10', 0] } };
    workflow['12'] = { class_type: 'InvertMask', inputs: { mask: ['11', 0] } };
    workflow['13'] = { class_type: 'JoinImageWithAlpha', inputs: { image: ['9', 0], alpha: ['12', 0] } };
  }
  workflow[OUTPUT_NODE_ID] = {
    class_type: 'SaveImage',
    inputs: { images: [input.transparent ? '13' : '9', 0], filename_prefix: input.filenamePrefix },
  };
  return workflow;
}

function buildPrompt(request: ComfyGenerationRequest): string {
  const isTopDown = request.projection === 'top_down';
  const opaqueTerrain = isTopDown && request.category === 'flat_tile';
  const typeInstruction = request.roadAtlas
    ? `Create one full-frame, opaque, edge-to-edge material sample for a ${isTopDown ? 'top-down' : 'isometric'} road surface. Show only the road material texture: no road shape, no tile, no atlas, no transparency, no border and no background.`
    : request.category === 'flat_tile'
      ? isTopDown
        ? 'Create one seamless square top-down terrain tile that fills the complete canvas, including all four corners. Match left to right and top to bottom edges without a border or shadow.'
        : 'Create one seamless 2:1 isometric terrain diamond that reaches all four canvas edges and tiles without gaps.'
      : request.category === 'elevated_tile'
        ? 'Create one elevated 2:1 isometric terrain tile with a readable top diamond and vertical walls.'
        : request.category === 'character'
          ? buildCharacterAnimationInstruction(request)
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
      : 'Use a simple high-contrast background so the configured BiRefNet stage can extract a clean alpha silhouette.',
  ].filter(Boolean).join('\n\n');
}

function buildCharacterAnimationInstruction(request: ComfyGenerationRequest): string {
  const settings = request.characterAnimation;
  if (!settings) throw new Error('Brakuje projektowej konfiguracji animacji postaci.');
  const directions = characterDirectionsForProjection(request.projection);
  const walkFrames = settings.framesPerDirection;
  const columns = 1 + walkFrames;
  const rows = directions.length;
  const frameWidth = request.outputSize ? request.outputSize.width / columns : null;
  const frameHeight = request.outputSize ? request.outputSize.height / rows : null;
  return [
    'Create one transparent directional CHARACTER ANIMATION SPRITESHEET, not a character portrait or a single pose.',
    `The sheet is an exact ${columns}-column by ${rows}-row grid with no gutters, labels, guides, borders or grid lines.`,
    frameWidth && frameHeight
      ? `Every frame cell is exactly ${frameWidth}x${frameHeight}px; the complete sheet is exactly ${request.outputSize!.width}x${request.outputSize!.height}px.`
      : '',
    `Rows from top to bottom are exactly: ${directions.map((direction) => `${direction.shortLabel} (${direction.id})`).join(', ')}.`,
    `Column 1 is one grounded idle pose. Columns 2-${columns} are exactly ${walkFrames} chronological, evenly spaced phases W1-W${walkFrames} of one complete in-place walk loop. Show alternating left/right contact and passing phases across the full sequence; do not omit, merge or duplicate frames.`,
    'Keep the same character identity, outfit, proportions, scale, lighting and ground-contact pivot in every cell. The root stays fixed; only the gait animates.',
    `Each row must face and move in its declared direction. Evaluate all ${walkFrames} walk frames: alternate arms and legs naturally, avoid foot sliding, duplicate frames, teleportation, cropping and extra limbs, and make W${walkFrames} loop smoothly into W1.`,
    'Leave transparent padding inside every cell around the silhouette. Do not draw a floor, cast shadow, text, arrows, direction names or a surrounding scene.',
  ].filter(Boolean).join('\n');
}

function chooseGenerationSize(target: { width: number; height: number } | null): { width: number; height: number } {
  if (!target) return { width: 1024, height: 1024 };
  const longest = Math.max(target.width, target.height);
  const scale = longest < 1024 ? 1024 / longest : longest > 1536 ? 1536 / longest : 1;
  return {
    width: clamp(roundTo64(target.width * scale), 256, 1536),
    height: clamp(roundTo64(target.height * scale), 256, 1536),
  };
}

function findOutputImage(value: unknown): ComfyImageDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.images)) {
    const image = record.images.find((candidate) => candidate && typeof candidate === 'object') as Record<string, unknown> | undefined;
    if (image && typeof image.filename === 'string') {
      return {
        filename: image.filename,
        subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
        type: typeof image.type === 'string' ? image.type : 'output',
      };
    }
  }
  for (const nested of Object.values(record)) {
    const found = findOutputImage(nested);
    if (found) return found;
  }
  return null;
}

export function detectDesktopInstallation(options: ComfyDesktopDetectionOptions = {}): ComfyDesktopInstallation {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const environment = options.environment ?? process.env;
  if (platform === 'darwin') return detectMacDesktopInstallation(homeDirectory, options.macApplicationDirectories);
  if (platform !== 'win32') {
    return { installed: false, localBackendConfigured: false, updating: false, version: null, missingModels: [] };
  }
  const appData = environment.APPDATA ?? path.join(homeDirectory, 'AppData', 'Roaming');
  const localAppData = environment.LOCALAPPDATA ?? path.join(homeDirectory, 'AppData', 'Local');
  const installationsPath = path.join(appData, 'Comfy Desktop', 'installations.json');
  const { installPath, version } = readDesktopInstallationRecord(installationsPath);
  const desktopExecutable = path.join(environment.ProgramFiles ?? 'C:\\Program Files', 'Comfy Desktop', 'Comfy Desktop.exe');
  const localBackendConfigured = Boolean(installPath && existsSync(installPath));
  const installed = localBackendConfigured || existsSync(desktopExecutable);
  const updating = Boolean(localBackendConfigured && existsSync(path.join(installPath, '.comfyui-op-in-progress.json')));
  const sharedModels = path.join(localAppData, 'Comfy-Desktop', 'ComfyUI-Shared', 'models');
  const missingModels = findMissingDesktopModels([sharedModels]);
  return { installed, localBackendConfigured, updating, version, missingModels };
}

function detectMacDesktopInstallation(
  homeDirectory: string,
  applicationDirectories = ['/Applications', path.join(homeDirectory, 'Applications')],
): ComfyDesktopInstallation {
  const applicationBundle = applicationDirectories
    .map((directory) => path.join(directory, 'Comfy Desktop.app'))
    .find(isValidMacDesktopBundle);
  const installationsPath = path.join(homeDirectory, 'Library', 'Application Support', 'Comfy Desktop', 'installations.json');
  const installation = readDesktopInstallationRecord(installationsPath);
  const version = applicationBundle
    ? readMacBundleVersion(path.join(applicationBundle, 'Contents', 'Info.plist')) ?? installation.version
    : installation.version;
  const localBackendConfigured = Boolean(
    installation.installPath
    && existsSync(installation.installPath),
  );
  const updating = Boolean(
    localBackendConfigured
    && existsSync(path.join(installation.installPath, '.comfyui-op-in-progress.json')),
  );
  const modelRoots = [
    path.join(homeDirectory, 'ComfyUI-Shared', 'models'),
    path.join(homeDirectory, 'Library', 'Application Support', 'ComfyUI', 'models'),
    path.join(homeDirectory, 'Library', 'Application Support', 'Comfy-Desktop', 'ComfyUI-Shared', 'models'),
  ];
  return {
    installed: Boolean(applicationBundle || localBackendConfigured),
    localBackendConfigured,
    updating,
    version,
    missingModels: findMissingDesktopModels(modelRoots),
  };
}

function isValidMacDesktopBundle(applicationBundle: string): boolean {
  return existsSync(path.join(applicationBundle, 'Contents', 'MacOS', 'Comfy Desktop'))
    && existsSync(path.join(applicationBundle, 'Contents', 'Resources', 'app.asar'));
}

function readMacBundleVersion(infoPlistPath: string): string | null {
  try {
    const infoPlist = readFileSync(infoPlistPath, 'utf8');
    const match = infoPlist.match(/<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]+)<\/string>/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function readDesktopInstallationRecord(installationsPath: string): { installPath: string; version: string | null } {
  try {
    const installations = JSON.parse(readFileSync(installationsPath, 'utf8')) as Array<Record<string, unknown>>;
    const local = installations.find((item) => typeof item.installPath === 'string');
    const comfyVersion = local?.comfyVersion as Record<string, unknown> | undefined;
    return {
      installPath: typeof local?.installPath === 'string' ? local.installPath : '',
      version: typeof comfyVersion?.baseTag === 'string' ? comfyVersion.baseTag : null,
    };
  } catch {
    // Bundle/executable probes still detect a manually installed Desktop build.
    return { installPath: '', version: null };
  }
}

function findMissingDesktopModels(modelRoots: string[]): string[] {
  const requirements = [
    ['diffusion_models', PROFILE_MODEL],
    ['text_encoders', PROFILE_CLIP],
    ['vae', PROFILE_VAE],
    ['background_removal', BACKGROUND_MODEL],
  ] as const;
  return requirements
    .filter(([directory, fileName]) => !modelRoots.some((root) => fileSize(path.join(root, directory, fileName)) > 0))
    .map(([, fileName]) => fileName);
}

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function checkingHealth(endpoint: string): ComfyUiHealth {
  return {
    state: 'checking', installed: false, server: false, endpoint, version: null,
    profile: PROFILE, model: PROFILE_MODEL, missingNodes: [], missingModels: [],
    message: 'Sprawdzanie lokalnego ComfyUI…',
  };
}

function normalizeLoopbackEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Endpoint ComfyUI musi używać HTTP lub HTTPS.');
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('Ze względów bezpieczeństwa Tilemap Generator łączy się tylko z lokalnym ComfyUI.');
  }
  return url.toString().replace(/\/$/, '');
}

async function findRunningComfyEndpoint(currentEndpoint: string): Promise<string | null> {
  const candidates = Array.from(
    { length: 11 },
    (_, index) => `http://127.0.0.1:${8188 + index}`,
  ).filter((candidate) => candidate !== currentEndpoint);
  const results = await Promise.all(candidates.map(async (candidate) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_200);
    try {
      const response = await fetch(`${candidate}/system_stats`, { signal: controller.signal });
      if (!response.ok) return null;
      const value = await response.json() as Record<string, unknown>;
      return value.system && typeof value.system === 'object' ? candidate : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }));
  return results.find((candidate): candidate is string => candidate !== null) ?? null;
}

function combineSignals(first: AbortSignal | null | undefined, second: AbortSignal): AbortSignal {
  if (!first) return second;
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

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('Generacja ComfyUI została anulowana.');
  error.name = 'AbortError';
  return error;
}

function roundTo64(value: number): number {
  return Math.max(64, Math.round(value / 64) * 64);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
