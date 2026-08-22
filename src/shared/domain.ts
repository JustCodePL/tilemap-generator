import { z } from 'zod';

export const assetCategories = [
  'flat_tile',
  'elevated_tile',
  'road_tile',
  'building',
  'character',
  'vegetation',
  'prop',
  'effect',
  'ui',
  'other',
] as const;

export const assetCategorySchema = z.enum(assetCategories);
export type AssetCategory = z.infer<typeof assetCategorySchema>;

export const roadConnectionDirections = [
  { id: 'north_west', bit: 1, shortLabel: 'NW', x: 0.25, y: 0.25 },
  { id: 'north_east', bit: 2, shortLabel: 'NE', x: 0.75, y: 0.25 },
  { id: 'south_east', bit: 4, shortLabel: 'SE', x: 0.75, y: 0.75 },
  { id: 'south_west', bit: 8, shortLabel: 'SW', x: 0.25, y: 0.75 },
] as const;

export const roadVariantMasks = Array.from({ length: 16 }, (_, mask) => mask);
export const roadCanonicalVariantMasks = [0, 1, 3, 5, 6, 7, 15] as const;

export const terrainBlendNeighborDirections = [
  { id: 'north_west', bit: 1, dx: -1, dy: 0, kind: 'edge' },
  { id: 'north', bit: 2, dx: -1, dy: -1, kind: 'corner', adjacentEdges: [1, 4] },
  { id: 'north_east', bit: 4, dx: 0, dy: -1, kind: 'edge' },
  { id: 'east', bit: 8, dx: 1, dy: -1, kind: 'corner', adjacentEdges: [4, 16] },
  { id: 'south_east', bit: 16, dx: 1, dy: 0, kind: 'edge' },
  { id: 'south', bit: 32, dx: 1, dy: 1, kind: 'corner', adjacentEdges: [16, 64] },
  { id: 'south_west', bit: 64, dx: 0, dy: 1, kind: 'edge' },
  { id: 'west', bit: 128, dx: -1, dy: 1, kind: 'corner', adjacentEdges: [64, 1] },
] as const;

export function normalizeTerrainBlendMask(mask: number): number {
  let normalized = mask & 0xff;
  for (const direction of terrainBlendNeighborDirections) {
    if (direction.kind !== 'corner') continue;
    const [leftEdge, rightEdge] = direction.adjacentEdges;
    if ((normalized & leftEdge) === 0 || (normalized & rightEdge) === 0) {
      normalized &= ~direction.bit;
    }
  }
  return normalized;
}

export const terrainBlendVariantMasks = Array.from(
  new Set(Array.from({ length: 256 }, (_, mask) => normalizeTerrainBlendMask(mask))),
).sort((left, right) => left - right);

export function hasRoadConnection(mask: number, bit: number): boolean {
  return (mask & bit) === bit;
}

export function roadConnectionLabels(mask: number): string[] {
  return roadConnectionDirections
    .filter((direction) => hasRoadConnection(mask, direction.bit))
    .map((direction) => direction.shortLabel);
}

export function roadVariantLabel(mask: number): string {
  const directions = roadConnectionLabels(mask).join('–');
  const connectionCount = roadConnectionDirections.filter((direction) => hasRoadConnection(mask, direction.bit)).length;
  if (connectionCount === 0) return 'Izolowany';
  if (connectionCount === 1) return `Koniec · ${directions}`;
  if (connectionCount === 2) return `${mask === 5 || mask === 10 ? 'Prosta' : 'Zakręt'} · ${directions}`;
  if (connectionCount === 3) return `T · ${directions}`;
  return 'Skrzyżowanie';
}

export const versionStatuses = [
  'queued',
  'generating',
  'needs_review',
  'approved',
  'rejected',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export const versionStatusSchema = z.enum(versionStatuses);
export type VersionStatus = z.infer<typeof versionStatusSchema>;

export const generationModes = ['generate', 'edit', 'variant'] as const;
export const generationModeSchema = z.enum(generationModes);
export type GenerationMode = z.infer<typeof generationModeSchema>;

export const generatorProviders = ['codex', 'comfyui', 'stable_diffusion_cpp'] as const;
export const generatorProviderSchema = z.enum(generatorProviders);
export type GeneratorProvider = z.infer<typeof generatorProviderSchema>;

export const comfyUiProfiles = ['z_image_turbo'] as const;
export const comfyUiProfileSchema = z.enum(comfyUiProfiles);
export type ComfyUiProfile = z.infer<typeof comfyUiProfileSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(80),
  artBrief: z.string().trim().max(12_000).default(''),
  tileWidthPx: z.number().int().min(16).max(4096).multipleOf(2).default(256),
  pixelsPerUnit: z.number().int().min(1).max(4096).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSettingsSchema = z.object({
  name: z.string().trim().min(2).max(80),
  artBrief: z.string().trim().max(12_000),
  tileWidthPx: z.number().int().min(16).max(4096).multipleOf(2),
  pixelsPerUnit: z.number().int().min(1).max(4096),
  maxConcurrentJobs: z.number().int().min(1).max(8),
  aiVerificationEnabled: z.boolean(),
  codexGenerationEnabled: z.boolean().default(true),
  comfyUiEnabled: z.boolean().default(false),
  comfyUiProfile: comfyUiProfileSchema.default('z_image_turbo'),
  stableDiffusionCppEnabled: z.boolean().default(false),
}).refine(
  (settings) => settings.codexGenerationEnabled
    || settings.comfyUiEnabled
    || settings.stableDiffusionCppEnabled,
  {
  message: 'Włącz co najmniej jeden generator obrazów.',
  },
);
export type UpdateProjectSettingsInput = z.input<typeof updateProjectSettingsSchema>;

export const footprintSchema = z.object({
  x: z.number().int().min(1).max(64),
  y: z.number().int().min(1).max(64),
});

export const pivotSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export const enqueueGenerationSchema = z.object({
  assetId: z.string().uuid().optional(),
  parentVersionId: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(120),
  prompt: z.string().trim().max(20_000).default(''),
  feedback: z.string().trim().max(10_000).optional(),
  mode: generationModeSchema.default('generate'),
  category: assetCategorySchema.optional(),
  elevationLevels: z.number().int().min(1).max(16).optional(),
  relativeWidth: z.number().min(0.25).max(16).optional(),
  relativeHeight: z.number().min(0.25).max(16).optional(),
  footprint: footprintSchema.default({ x: 1, y: 1 }),
  generatorProvider: generatorProviderSchema.optional(),
});
export type EnqueueGenerationInput = z.infer<typeof enqueueGenerationSchema>;

export const reviewVersionSchema = z.object({
  versionId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  tags: z.array(z.string().trim().min(1).max(60)).max(40),
  rejectionReason: z.string().trim().max(10_000).optional(),
  footprint: footprintSchema,
  pivot: pivotSchema,
});
export type ReviewVersionInput = z.infer<typeof reviewVersionSchema>;

export const updateStyleSchema = z.object({
  summary: z.string().trim().min(1).max(30_000),
});
export type UpdateStyleInput = z.infer<typeof updateStyleSchema>;

export const addProjectReferenceSchema = z.object({
  description: z.string().trim().min(3).max(4_000),
});
export type AddProjectReferenceInput = z.infer<typeof addProjectReferenceSchema>;

export const updateProjectReferenceSchema = z.object({
  referenceId: z.string().uuid(),
  description: z.string().trim().min(3).max(4_000),
});
export type UpdateProjectReferenceInput = z.infer<typeof updateProjectReferenceSchema>;

export const proposedProjectSettingsSchema = z.object({
  artBrief: z.string().trim().max(12_000).optional(),
  tileWidthPx: z.number().int().min(16).max(4096).multipleOf(2).optional(),
  pixelsPerUnit: z.number().int().min(1).max(4096).optional(),
  codexGenerationEnabled: z.boolean().optional(),
  comfyUiEnabled: z.boolean().optional(),
  comfyUiProfile: comfyUiProfileSchema.optional(),
  stableDiffusionCppEnabled: z.boolean().optional(),
}).refine((settings) => Object.values(settings).some((value) => value !== undefined), {
  message: 'Propozycja musi zmieniać co najmniej jedno ustawienie projektu.',
});

export const createProjectSettingsProposalSchema = z.object({
  reason: z.string().trim().min(10).max(4_000),
  settings: proposedProjectSettingsSchema,
  referenceIds: z.array(z.string().uuid()).max(20).default([]),
});
export type CreateProjectSettingsProposalInput = z.infer<typeof createProjectSettingsProposalSchema>;

export const reviewProjectSettingsProposalSchema = z.object({
  proposalId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
});
export type ReviewProjectSettingsProposalInput = z.infer<typeof reviewProjectSettingsProposalSchema>;

export const exportPreviewSchema = z.object({
  targetAssetsDirectory: z.string().min(1),
  assetIds: z.array(z.string().uuid()).optional(),
});
export type ExportPreviewInput = z.infer<typeof exportPreviewSchema>;

export interface ProjectInfo {
  id: string;
  rootPath: string;
  name: string;
  artBrief: string;
  projection: 'isometric';
  tileWidthPx: number;
  tileHeightPx: number;
  pixelsPerUnit: number;
  maxConcurrentJobs: number;
  aiVerificationEnabled: boolean;
  codexGenerationEnabled?: boolean;
  comfyUiEnabled?: boolean;
  comfyUiProfile?: ComfyUiProfile;
  stableDiffusionCppEnabled?: boolean;
  styleSummary: string;
  styleSummaryStale: boolean;
  unityExportPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export const aiVerificationStatuses = ['pending', 'passed', 'failed'] as const;
export type AiVerificationStatus = typeof aiVerificationStatuses[number];

export interface AssetVersion {
  id: string;
  assetId: string;
  parentVersionId: string | null;
  mode: GenerationMode;
  status: VersionStatus;
  prompt: string;
  feedback: string;
  category: AssetCategory;
  elevationLevels: number;
  relativeWidth: number;
  relativeHeight: number;
  roadConnections?: number;
  roadVariants?: RoadVariant[];
  tags: string[];
  finalPath: string | null;
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  footprint: { x: number; y: number };
  pivot: { x: number; y: number };
  aiDescription: string;
  aiVerificationStatus: AiVerificationStatus;
  aiVerificationMessage: string;
  generatorProvider?: GeneratorProvider;
  generatorModel?: string;
  generatorWorkflowHash?: string;
  providerRunId?: string;
  generationMetadata?: Record<string, unknown>;
  rejectionReason: string;
  error: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoadVariant {
  connectionMask: number;
  finalPath: string;
  imageUrl: string;
  width: number;
  height: number;
}

export interface AssetSummary {
  id: string;
  name: string;
  description: string;
  category: AssetCategory;
  elevationLevels: number;
  relativeWidth: number;
  relativeHeight: number;
  roadConnections?: number;
  currentApprovedVersionId: string | null;
  latestVersion: AssetVersion | null;
  versionCount: number;
  codexThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetDetail extends AssetSummary {
  versions: AssetVersion[];
}

export interface StyleSummaryRevision {
  id: string;
  summary: string;
  previousId: string | null;
  basedOnVersionId: string | null;
  source: 'ai' | 'manual' | 'restore';
  createdAt: string;
}

export interface ProjectReference {
  id: string;
  name: string;
  description: string;
  relativePath: string;
  imageUrl: string;
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSettingsSnapshot {
  artBrief: string;
  tileWidthPx: number;
  pixelsPerUnit: number;
  codexGenerationEnabled?: boolean;
  comfyUiEnabled?: boolean;
  comfyUiProfile?: ComfyUiProfile;
  stableDiffusionCppEnabled?: boolean;
}

export function isTileAssetCategory(category: AssetCategory): boolean {
  return category === 'flat_tile' || category === 'elevated_tile';
}

export function isRoadAssetCategory(category: AssetCategory): boolean {
  return category === 'road_tile';
}

export function isRelativeSizeCategory(category: AssetCategory): boolean {
  return category === 'building' || category === 'character';
}

export function defaultAssetSizing(category: AssetCategory): {
  elevationLevels: number;
  relativeWidth: number;
  relativeHeight: number;
} {
  if (category === 'building') return { elevationLevels: 0, relativeWidth: 1, relativeHeight: 2 };
  if (category === 'character') return { elevationLevels: 0, relativeWidth: 0.5, relativeHeight: 1.5 };
  return { elevationLevels: category === 'elevated_tile' ? 1 : 0, relativeWidth: 1, relativeHeight: 1 };
}

export function assetPixelSize(
  settings: Pick<ProjectInfo, 'tileWidthPx' | 'tileHeightPx'>,
  asset: Pick<AssetVersion, 'category' | 'elevationLevels' | 'relativeWidth' | 'relativeHeight'>,
): { width: number; height: number } | null {
  if (asset.category === 'flat_tile' || asset.category === 'road_tile') {
    return { width: settings.tileWidthPx, height: settings.tileHeightPx };
  }
  if (asset.category === 'elevated_tile') {
    return { width: settings.tileWidthPx, height: settings.tileHeightPx * (1 + asset.elevationLevels) };
  }
  if (isRelativeSizeCategory(asset.category)) {
    return {
      width: Math.round(settings.tileWidthPx * asset.relativeWidth),
      height: Math.round(settings.tileHeightPx * asset.relativeHeight),
    };
  }
  return null;
}

export interface ProjectSettingsProposal {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  reason: string;
  before: ProjectSettingsSnapshot;
  proposed: Partial<ProjectSettingsSnapshot>;
  referenceIds: string[];
  createdAt: string;
  decidedAt: string | null;
}

export interface GenerationJob {
  id: string;
  assetId: string;
  versionId: string;
  generatorProvider?: GeneratorProvider;
  status: VersionStatus;
  progress: string;
  error: string;
  createdAt: string;
  updatedAt: string;
}

export type GenerationStage = 'generation' | 'verification' | 'retry' | 'review' | 'system';
export type GenerationLogLevel = 'info' | 'success' | 'warning' | 'error';

export interface GenerationLogEntry {
  id: string;
  jobId: string;
  assetId: string;
  versionId: string;
  stage: GenerationStage;
  level: GenerationLogLevel;
  attempt: number;
  message: string;
  details: { tool: string; arguments: Record<string, unknown> } | null;
  previewUrl: string | null;
  createdAt: string;
}

export type GenerationEvent =
  | { type: 'queue'; job: GenerationJob }
  | { type: 'progress'; jobId: string; message: string }
  | { type: 'log'; entry: GenerationLogEntry }
  | { type: 'completed'; jobId: string; assetId: string; versionId: string }
  | { type: 'verification-completed'; assetId: string; versionId: string; status: AiVerificationStatus }
  | { type: 'failed'; jobId: string; message: string }
  | { type: 'style-updated'; revisionId: string }
  | { type: 'codex-event'; jobId: string; method: string; payload: unknown };

export interface CodexHealth {
  state: 'ready' | 'unavailable' | 'not_logged_in' | 'incompatible' | 'checking';
  version: string | null;
  appServer: boolean;
  imageGeneration: boolean;
  imagegenSkill: boolean;
  skillPath: string | null;
  logPath: string | null;
  message: string;
}

export interface ComfyUiHealth {
  state: 'ready' | 'detected' | 'unavailable' | 'checking';
  installed: boolean;
  server: boolean;
  endpoint: string;
  version: string | null;
  profile: ComfyUiProfile;
  model: string;
  missingNodes: string[];
  missingModels: string[];
  message: string;
}

export interface StableDiffusionCppHealth {
  state: 'ready' | 'detected' | 'unavailable' | 'checking';
  installed: boolean;
  executablePath: string | null;
  profile: 'z_image_turbo';
  model: string;
  llm: string;
  vae: string;
  missingFiles: string[];
  message: string;
}

export const stableDiffusionCppModelIds = [
  'z_image_turbo_q3_k',
  'z_image_turbo_q4_k',
  'z_image_turbo_q6_k',
  'z_image_turbo_bf16',
] as const;
export const stableDiffusionCppModelIdSchema = z.enum(stableDiffusionCppModelIds);
export type StableDiffusionCppModelId = z.infer<typeof stableDiffusionCppModelIdSchema>;

export const installStableDiffusionCppSchema = z.object({
  modelId: stableDiffusionCppModelIdSchema,
});
export type InstallStableDiffusionCppInput = z.infer<typeof installStableDiffusionCppSchema>;

export interface StableDiffusionCppModelOption {
  id: StableDiffusionCppModelId;
  name: string;
  quantization: string;
  description: string;
  recommendedVramGb: number;
  totalSizeBytes: number;
  downloadBytesRemaining: number;
  installed: boolean;
  selected: boolean;
  recommended: boolean;
  usesExistingComfyModels: boolean;
}

export interface StableDiffusionCppSetupInfo {
  runtime: {
    installed: boolean;
    version: string | null;
    backend: 'vulkan';
    executablePath: string | null;
  };
  hardware: {
    gpuName: string | null;
    vramMb: number | null;
    recommendedModelId: StableDiffusionCppModelId;
    recommendation: string;
  };
  models: StableDiffusionCppModelOption[];
  selectedModelId: StableDiffusionCppModelId;
  installRoot: string;
}

export interface StableDiffusionCppInstallEvent {
  phase: 'runtime' | 'model' | 'verifying' | 'extracting' | 'completed' | 'cancelled' | 'failed';
  modelId: StableDiffusionCppModelId | null;
  fileName: string | null;
  downloadedBytes: number;
  totalBytes: number;
  message: string;
}

export interface ExportFilePreview {
  assetId: string;
  versionId: string;
  sourcePath: string;
  destinationPath: string;
  variantMask?: number;
  role?: 'asset' | 'road_variant' | 'terrain_blend_atlas' | 'terrain_wall' | 'unity_support';
  action: 'create' | 'replace' | 'unchanged';
}

export interface ExportPreview {
  token: string;
  targetAssetsDirectory: string;
  manifestPath: string;
  files: ExportFilePreview[];
}

export interface RecentProject {
  name: string;
  rootPath: string;
  openedAt: string;
}
