import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  assetCategories,
  characterDirectionsForProjection,
  enqueueGenerationSchema,
  generatorProviders,
  updateStyleSchema,
  versionStatuses,
} from '../../shared/domain';
import { tilemapMcpScopes } from '../../shared/mcp';
import type {
  EnqueueGenerationInput,
  GenerationJob,
  GeneratorProvider,
  ProjectInfo,
} from '../../shared/domain';
import type { TilemapMcpScope } from '../../shared/mcp';
import type { ProjectDatabase } from '../db/project-database';

const MAX_CONTEXT_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REFERENCE_SOURCE_BYTES = 50 * 1024 * 1024;

export const tilemapMcpMethods = [
  'list_projects',
  'bind_project',
  'get_project_context',
  'get_style',
  'update_style',
  'list_references',
  'add_reference',
  'get_reference',
  'get_asset',
  'generate_asset',
  'get_generation_status',
] as const;
export type TilemapMcpMethod = typeof tilemapMcpMethods[number];

const emptyParamsSchema = z.object({}).strict();

export const bindMcpProjectSchema = z.object({
  projectId: z.string().uuid(),
}).strict();

export const getMcpStyleSchema = z.object({
  historyLimit: z.number().int().min(1).max(20).default(10),
}).strict();

export const updateMcpStyleSchema = z.object({
  summary: z.string(),
}).strict();

export const addMcpReferenceSchema = z.object({
  sourcePath: z.string().trim().min(1).max(32_767),
  description: z.string().trim().min(3).max(4_000),
}).strict();

export const getMcpReferenceSchema = z.object({
  referenceId: z.string().uuid(),
}).strict();

export const getMcpAssetSchema = z.object({
  assetId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
}).strict();

export const generateMcpAssetSchema = z.object({
  request: z.unknown(),
  referenceIds: z.array(z.string().uuid()).max(20).default([]),
  styleDirection: z.string().trim().min(1).max(12_000).optional(),
}).strict().superRefine((input, context) => {
  if (new Set(input.referenceIds).size !== input.referenceIds.length) {
    context.addIssue({
      code: 'custom', path: ['referenceIds'], message: 'Każda referencja może wystąpić tylko raz.',
    });
  }
});

export const getMcpGenerationStatusSchema = z.object({
  jobIds: z.array(z.string().uuid()).min(1).max(20),
  includeLogs: z.boolean().default(true),
  logLimit: z.number().int().min(1).max(100).default(20),
}).strict().superRefine((input, context) => {
  if (new Set(input.jobIds).size !== input.jobIds.length) {
    context.addIssue({ code: 'custom', path: ['jobIds'], message: 'Każde zadanie może wystąpić tylko raz.' });
  }
});

const projectDescriptorSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  openedAt: z.string().datetime().optional(),
  active: z.boolean(),
}).strict();

const scopeSelectionSchema = z.array(z.enum(tilemapMcpScopes)).max(tilemapMcpScopes.length)
  .superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length) {
      context.addIssue({ code: 'custom', message: 'Każdy scope MCP może wystąpić tylko raz.' });
    }
  });

export interface TilemapMcpGenerationQueue {
  isAttachedTo(database: ProjectDatabase): boolean;
  enqueueEnabled(input: EnqueueGenerationInput): GenerationJob[];
}

export interface TilemapMcpProjectRuntime {
  database: ProjectDatabase;
  generationQueue: TilemapMcpGenerationQueue;
}

export interface TilemapMcpProjectDescriptor {
  projectId: string;
  name: string;
  openedAt?: string;
  active: boolean;
}

export interface TilemapMcpProjectGateway {
  listProjectDescriptors(): readonly TilemapMcpProjectDescriptor[]
    | Promise<readonly TilemapMcpProjectDescriptor[]>;
  activateProject(projectId: string): Promise<TilemapMcpProjectRuntime>;
  getActiveRuntime(): TilemapMcpProjectRuntime | null | Promise<TilemapMcpProjectRuntime | null>;
}

interface ProjectBinding {
  projectId: string;
  runtime: TilemapMcpProjectRuntime;
}

export class TilemapMcpBackendService {
  private binding: ProjectBinding | null = null;
  private readonly grantedScopes: ReadonlySet<TilemapMcpScope>;

  constructor(
    private readonly gateway: TilemapMcpProjectGateway,
    grantedScopes: readonly TilemapMcpScope[],
  ) {
    this.grantedScopes = new Set(scopeSelectionSchema.parse(grantedScopes));
  }

  async call(method: string, params: unknown): Promise<unknown> {
    switch (method as TilemapMcpMethod) {
      case 'list_projects':
        emptyParamsSchema.parse(params ?? {});
        return this.listProjects();
      case 'bind_project': return this.bindProject(params);
      case 'get_project_context':
        emptyParamsSchema.parse(params ?? {});
        return this.getProjectContext();
      case 'get_style': return this.getStyle(params ?? {});
      case 'update_style': return this.updateStyle(params);
      case 'list_references':
        emptyParamsSchema.parse(params ?? {});
        return this.listReferences();
      case 'add_reference': return this.addReference(params);
      case 'get_reference': return this.getReference(params);
      case 'get_asset': return this.getAsset(params);
      case 'generate_asset': return this.generateAsset(params);
      case 'get_generation_status': return this.getGenerationStatus(params);
      default: throw new Error(`Nieznana metoda MCP: ${method}.`);
    }
  }

  async listProjects(): Promise<Array<TilemapMcpProjectDescriptor & { bound: boolean }>> {
    this.requireScopes('read');
    const descriptors = await this.projectDescriptors();
    if (this.binding) {
      const active = await this.gateway.getActiveRuntime();
      if (!active
        || active.database !== this.binding.runtime.database
        || active.generationQueue !== this.binding.runtime.generationQueue) {
        this.binding = null;
      }
    }
    return descriptors.map((descriptor) => ({
      ...descriptor,
      bound: descriptor.projectId === this.binding?.projectId,
    }));
  }

  async bindProject(rawInput: unknown): Promise<ReturnType<TilemapMcpBackendService['projectContext']>> {
    this.requireScopes('read', 'project:activate');
    const input = bindMcpProjectSchema.parse(rawInput);
    const descriptors = await this.projectDescriptors();
    const matches = descriptors.filter((descriptor) => descriptor.projectId === input.projectId);
    if (matches.length !== 1) {
      throw new Error(matches.length
        ? `ProjectId ${input.projectId} jest niejednoznaczny; przerwano aktywację MCP.`
        : `Projekt ${input.projectId} nie jest dostępny dla MCP.`);
    }

    this.binding = null;
    const activated = await this.gateway.activateProject(input.projectId);
    const active = await this.gateway.getActiveRuntime();
    const project = activated.database.getProject();
    if (project.id !== input.projectId
      || !active
      || active.database !== activated.database
      || active.generationQueue !== activated.generationQueue
      || !activated.generationQueue.isAttachedTo(activated.database)) {
      throw new Error('Aktywowany runtime nie odpowiada projektowi wybranemu dla MCP.');
    }
    this.binding = { projectId: project.id, runtime: activated };
    return this.projectContext(activated);
  }

  async getProjectContext(): Promise<ReturnType<TilemapMcpBackendService['projectContext']>> {
    this.requireScopes('read');
    return this.projectContext(await this.requireBoundRuntime());
  }

  async getStyle(rawInput: unknown = {}): Promise<{
    projectId: string;
    activeSummary: string;
    stale: boolean;
    history: ReturnType<ProjectDatabase['getStyleHistory']>;
  }> {
    this.requireScopes('read');
    const input = getMcpStyleSchema.parse(rawInput);
    const runtime = await this.requireBoundRuntime();
    const project = runtime.database.getProject();
    return {
      projectId: project.id,
      activeSummary: project.styleSummary,
      stale: project.styleSummaryStale,
      history: runtime.database.getStyleHistory().slice(0, input.historyLimit),
    };
  }

  async updateStyle(rawInput: unknown): Promise<{
    projectId: string;
    revision: ReturnType<ProjectDatabase['addStyleRevision']>;
  }> {
    this.requireScopes('read', 'style:write');
    const strictInput = updateMcpStyleSchema.parse(rawInput);
    const input = updateStyleSchema.parse(strictInput);
    const runtime = await this.requireBoundRuntime();
    return {
      projectId: this.binding!.projectId,
      revision: runtime.database.addStyleRevision(input.summary, 'manual'),
    };
  }

  async listReferences(): Promise<{
    projectId: string;
    references: ReturnType<typeof publicReference>[];
  }> {
    this.requireScopes('read');
    const runtime = await this.requireBoundRuntime();
    return {
      projectId: this.binding!.projectId,
      references: runtime.database.listProjectReferences().map(publicReference),
    };
  }

  async addReference(rawInput: unknown): Promise<{
    projectId: string;
    reference: ReturnType<typeof publicReference>;
  }> {
    this.requireScopes('read', 'references:write');
    const input = addMcpReferenceSchema.parse(rawInput);
    const runtime = await this.requireBoundRuntime();
    let sourcePath: string;
    let sourceStats: ReturnType<typeof statSync>;
    try {
      sourcePath = realpathSync(input.sourcePath);
      sourceStats = statSync(sourcePath);
    } catch {
      throw new Error('Źródłowy obraz referencyjny nie istnieje lub jest niedostępny.');
    }
    if (!sourceStats.isFile()) throw new Error('Źródłowy obraz referencyjny nie jest zwykłym plikiem.');
    if (sourceStats.size > MAX_REFERENCE_SOURCE_BYTES) {
      throw new Error('Źródłowy obraz referencyjny przekracza limit 50 MB.');
    }
    const reference = await runtime.database.addProjectReference(sourcePath, input.description);
    return { projectId: this.binding!.projectId, reference: publicReference(reference) };
  }

  async getReference(rawInput: unknown): Promise<{
    projectId: string;
    metadata: Record<string, unknown>;
    mimeType: 'image/png';
    sizeBytes: number;
    dataBase64: string;
  }> {
    this.requireScopes('read');
    const input = getMcpReferenceSchema.parse(rawInput);
    const runtime = await this.requireBoundRuntime();
    const reference = runtime.database.getProjectReferenceToolData(input.referenceId);
    const absolutePath = safeProjectFile(runtime.database, reference.absolutePath);
    const stats = statSync(absolutePath);
    if (!stats.isFile()) throw new Error('Obraz referencyjny nie jest zwykłym plikiem.');
    if (stats.size > MAX_CONTEXT_IMAGE_BYTES) {
      throw new Error('Obraz referencyjny przekracza limit 15 MB dla kontekstu MCP.');
    }
    return {
      projectId: this.binding!.projectId,
      metadata: reference.metadata,
      mimeType: 'image/png',
      sizeBytes: stats.size,
      dataBase64: readFileSync(absolutePath).toString('base64'),
    };
  }

  async getAsset(rawInput: unknown): Promise<{
    projectId: string;
    metadata: Record<string, unknown>;
    mimeType: 'image/png';
    sizeBytes: number;
    dataBase64: string;
  }> {
    this.requireScopes('read');
    const input = getMcpAssetSchema.parse(rawInput);
    const runtime = await this.requireBoundRuntime();
    const asset = runtime.database.getAssetToolData(input.assetId, input.versionId);
    const absolutePath = safeProjectFile(runtime.database, asset.absolutePath);
    const stats = statSync(absolutePath);
    if (!stats.isFile()) throw new Error('Obraz assetu nie jest zwykłym plikiem.');
    if (stats.size > MAX_CONTEXT_IMAGE_BYTES) {
      throw new Error('Obraz assetu przekracza limit 15 MB dla kontekstu MCP.');
    }
    return {
      projectId: this.binding!.projectId,
      metadata: asset.metadata,
      mimeType: 'image/png',
      sizeBytes: stats.size,
      dataBase64: readFileSync(absolutePath).toString('base64'),
    };
  }

  async generateAsset(rawInput: unknown): Promise<{ projectId: string; jobs: GenerationJob[] }> {
    this.requireScopes('read', 'generation:enqueue');
    const input = generateMcpAssetSchema.parse(rawInput);
    const runtime = await this.requireBoundRuntime();
    if (!runtime.generationQueue.isAttachedTo(runtime.database)) {
      throw new Error('Kolejka generacji nie jest przypięta do projektu wybranego dla MCP.');
    }
    const project = runtime.database.getProject();
    const parsedRequest = enqueueGenerationSchema.parse(input.request);
    const request = enqueueGenerationSchema.parse(
      parsedRequest.category === 'character' || parsedRequest.characterAnimation
        ? {
            ...parsedRequest,
            characterAnimation: {
              action: 'walk',
              framesPerDirection: project.characterFramesPerDirection,
              framesPerSecond: parsedRequest.characterAnimation?.framesPerSecond ?? 8,
            },
          }
        : parsedRequest,
    );
    const references = input.referenceIds.map((referenceId) => {
      const reference = runtime.database.getProjectReference(referenceId);
      if (!reference) throw new Error(`Referencja ${referenceId} nie należy do przypiętego projektu MCP.`);
      return reference;
    });
    const prompt = appendMcpGenerationContext(request.prompt, input.styleDirection, references);
    const enrichedRequest = enqueueGenerationSchema.parse({ ...request, prompt });
    return {
      projectId: this.binding!.projectId,
      jobs: runtime.generationQueue.enqueueEnabled(enrichedRequest),
    };
  }

  async getGenerationStatus(rawInput: unknown): Promise<{
    projectId: string;
    jobs: Array<GenerationJob & { logs?: Array<{
      stage: string;
      level: string;
      attempt: number;
      message: string;
      createdAt: string;
    }> }>;
  }> {
    this.requireScopes('read');
    const input = getMcpGenerationStatusSchema.parse(rawInput);
    const runtime = await this.requireBoundRuntime();
    const database = runtime.database;
    const jobs = input.jobIds.map((jobId) => database.getJob(jobId));
    const missingIndex = jobs.findIndex((job) => !job);
    if (missingIndex >= 0) {
      throw new Error(`Zadanie ${input.jobIds[missingIndex]} nie należy do przypiętego projektu MCP.`);
    }
    return {
      projectId: this.binding!.projectId,
      jobs: jobs.map((job) => {
        const existing = job!;
        const publicJob = { ...existing, error: redactLocalPaths(existing.error) };
        if (!input.includeLogs) return publicJob;
        const logs = database.listGenerationLogs(existing.assetId)
          .filter((entry) => entry.jobId === existing.id)
          .slice(-input.logLimit)
          .map((entry) => ({
            stage: entry.stage,
            level: entry.level,
            attempt: entry.attempt,
            message: redactLocalPaths(entry.message),
            createdAt: entry.createdAt,
          }));
        return { ...publicJob, logs };
      }),
    };
  }

  private async requireBoundRuntime(): Promise<TilemapMcpProjectRuntime> {
    if (!this.binding) throw new Error('Najpierw jawnie przypnij projekt do sesji MCP.');
    const active = await this.gateway.getActiveRuntime();
    let activeProjectId: string | null = null;
    try {
      activeProjectId = active?.database.getProject().id ?? null;
    } catch {
      activeProjectId = null;
    }
    if (!active
      || active.database !== this.binding.runtime.database
      || active.generationQueue !== this.binding.runtime.generationQueue
      || activeProjectId !== this.binding.projectId) {
      const projectId = this.binding.projectId;
      this.binding = null;
      throw new Error(`Projekt ${projectId} nie jest już aktywny; wymagane jest ponowne przypięcie MCP.`);
    }
    return active;
  }

  private projectContext(runtime: TilemapMcpProjectRuntime) {
    const database = runtime.database;
    const project = database.getProject();
    const assets = database.listAssets();
    const jobs = database.listJobs();
    const references = database.listProjectReferences();
    const selectedGeneratorProviders = generatorProviders.filter((provider) => providerEnabled(project, provider));
    return {
      project: {
        projectId: project.id,
        name: project.name,
        projection: project.projection,
        tileWidthPx: project.tileWidthPx,
        tileHeightPx: project.tileHeightPx,
        pixelsPerUnit: project.pixelsPerUnit,
        characterFramesPerDirection: project.characterFramesPerDirection,
        artBrief: project.artBrief,
        supportedAssetCategories: assetCategories.filter((category) => (
          project.projection !== 'top_down' || category !== 'elevated_tile'
        )),
        characterDirections: characterDirectionsForProjection(project.projection),
      },
      style: { summary: project.styleSummary, stale: project.styleSummaryStale },
      registry: {
        assetCount: assets.length,
        approvedAssetCount: assets.filter((asset) => asset.currentApprovedVersionId).length,
        referenceCount: references.length,
      },
      generation: {
        selectedGeneratorProviders,
        aiVerificationEnabled: project.aiVerificationEnabled,
        maxConcurrentJobs: project.maxConcurrentJobs,
        queueAttached: runtime.generationQueue.isAttachedTo(database),
        statusCounts: Object.fromEntries(versionStatuses.map((status) => [
          status,
          jobs.filter((job) => job.status === status).length,
        ])),
      },
    };
  }

  private async projectDescriptors(): Promise<TilemapMcpProjectDescriptor[]> {
    const descriptors = (await this.gateway.listProjectDescriptors()).map((descriptor) => (
      projectDescriptorSchema.parse(descriptor)
    ));
    const seen = new Set<string>();
    for (const descriptor of descriptors) {
      if (seen.has(descriptor.projectId)) {
        throw new Error(`Lista projektów MCP zawiera niejednoznaczny projectId: ${descriptor.projectId}.`);
      }
      seen.add(descriptor.projectId);
    }
    return descriptors.sort((left, right) => (
      left.name.localeCompare(right.name, 'pl') || left.projectId.localeCompare(right.projectId)
    ));
  }

  private requireScopes(...required: TilemapMcpScope[]): void {
    const missing = required.filter((scope) => !this.grantedScopes.has(scope));
    if (missing.length) throw new Error(`Brak uprawnienia MCP: ${missing.join(', ')}.`);
  }
}

type ProjectReferenceValue = Exclude<ReturnType<ProjectDatabase['getProjectReference']>, null>;

function publicReference(reference: ProjectReferenceValue) {
  return {
    referenceId: reference.id,
    name: reference.name,
    description: reference.description,
    width: reference.width,
    height: reference.height,
    updatedAt: reference.updatedAt,
  };
}

function safeProjectFile(database: ProjectDatabase, candidatePath: string): string {
  let absolutePath: string;
  let projectRoot: string;
  try {
    absolutePath = realpathSync(candidatePath);
    projectRoot = realpathSync(database.rootPath);
  } catch {
    throw new Error('Plik kontekstu MCP nie istnieje lub jest niedostępny.');
  }
  const projectPrefix = `${projectRoot}${path.sep}`.toLocaleLowerCase();
  if (absolutePath.toLocaleLowerCase() !== projectRoot.toLocaleLowerCase()
    && !absolutePath.toLocaleLowerCase().startsWith(projectPrefix)) {
    throw new Error('Plik kontekstu MCP wskazuje poza przypięty projekt.');
  }
  return absolutePath;
}

function appendMcpGenerationContext(
  prompt: string,
  styleDirection: string | undefined,
  references: ProjectReferenceValue[],
): string {
  if (!styleDirection && !references.length) return prompt;
  const context = [
    '--- MCP USER-SELECTED GENERATION CONTEXT ---',
    styleDirection ? `Style direction: ${styleDirection}` : '',
    references.length ? 'Selected project references (load these exact IDs with registry.get_reference):' : '',
    ...references.map((reference) => (
      `- ${reference.id} | ${reference.name} | ${reference.description}`
    )),
    '--- END MCP USER-SELECTED GENERATION CONTEXT ---',
  ].filter(Boolean).join('\n');
  return [prompt.trim(), context].filter(Boolean).join('\n\n');
}

function providerEnabled(project: ProjectInfo, provider: GeneratorProvider): boolean {
  if (provider === 'codex') return project.codexGenerationEnabled ?? true;
  if (provider === 'comfyui') return project.comfyUiEnabled ?? false;
  return project.stableDiffusionCppEnabled ?? false;
}

function redactLocalPaths(value: string): string {
  return value
    .replace(
      /(["'`])((?:[A-Za-z]:[\\/]|\/(?!\/))[^"'`\r\n]+)\1/g,
      (_match, quote: string) => `${quote}[ścieżka ukryta]${quote}`,
    )
    .replace(
      /(?<![A-Za-z0-9_:/\\])(?:[A-Za-z]:[\\/]|\/(?!\/))[^\s"'`,;:)}\]<>]+/g,
      '[ścieżka ukryta]',
    );
}
