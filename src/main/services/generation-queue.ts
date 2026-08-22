import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type {
  AssetCategory,
  EnqueueGenerationInput,
  GenerationEvent,
  GenerationJob,
  GenerationLogEntry,
  GenerationLogLevel,
  GenerationStage,
  GeneratorProvider,
  ProjectReference,
} from '../../shared/domain';
import {
  assetPixelSize,
  isRoadAssetCategory,
  isTileAssetCategory,
} from '../../shared/domain';
import { type CodexNotification } from '../codex/app-server-client';
import {
  CodexService,
  generationOutputSchema,
  generationResponseSchema,
} from '../codex/codex-service';
import { ComfyService } from '../comfy/comfy-service';
import type { JobContext, ProjectDatabase } from '../db/project-database';
import { StableDiffusionCppService } from '../stable-diffusion/stable-diffusion-cpp-service';
import { nullLogger, type Logger } from './app-logger';
import {
  createRoadVariantsFromMaterial,
  createRoadVariantGrid,
  createThumbnail,
  type RoadVariantFile,
  type TerrainSeamValidation,
  validateElevatedTerrainTile,
  validateRoadTile,
  validateTerrainTile,
  validateTransparentPng,
  verifyTerrainSeams,
} from './image-validator';
import { describeRegistryCall } from './registry-log';

const styleResponseSchema = z.object({ summary: z.string().min(1).max(30_000) });
const styleOutputSchema = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
};
const aiVerificationResponseSchema = z.object({
  status: z.enum(['passed', 'failed']),
  message: z.string().trim().min(1).max(4_000),
});
const aiVerificationOutputSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['passed', 'failed'] },
    message: { type: 'string' },
  },
  required: ['status', 'message'],
  additionalProperties: false,
};
const MAX_GEOMETRY_ATTEMPTS = 3;
const ROAD_GENERATION_TIMEOUT_MS = 25 * 60_000;

export class GenerationQueue extends EventEmitter {
  private database: ProjectDatabase | null = null;
  private activeJobs = new Map<string, { assetId: string; controller: AbortController }>();
  private activeVerifications = new Map<string, AbortController>();
  private maxConcurrentJobs = 1;
  private pumping = false;
  private stopping = false;

  constructor(
    private readonly codex: CodexService,
    private readonly logger: Logger = nullLogger,
    private readonly comfy: ComfyService = new ComfyService(logger),
    private readonly stableDiffusionCpp: StableDiffusionCppService = new StableDiffusionCppService(logger),
  ) {
    super();
  }

  attach(database: ProjectDatabase): void {
    this.database = database;
    this.activeJobs.clear();
    this.activeVerifications.clear();
    this.maxConcurrentJobs = database.getProject().maxConcurrentJobs;
    this.stopping = false;
    void this.pump();
  }

  detach(): void {
    this.stopping = true;
    this.database = null;
    this.activeJobs.clear();
    this.activeVerifications.clear();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const active of this.activeJobs.values()) active.controller.abort();
    for (const controller of this.activeVerifications.values()) controller.abort();
    if (this.activeJobs.size || this.activeVerifications.size) {
      await Promise.race([
        new Promise<void>((resolve) => this.once('idle', resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    this.detach();
  }

  enqueue(input: EnqueueGenerationInput): GenerationJob {
    const database = this.requireDatabase();
    const job = database.enqueueGeneration(input);
    this.emitEvent({ type: 'queue', job });
    void this.pump();
    return job;
  }

  enqueueEnabled(input: EnqueueGenerationInput): GenerationJob[] {
    if (input.generatorProvider) return [this.enqueue(input)];
    const database = this.requireDatabase();
    const project = database.getProject();
    const providers = [
      project.codexGenerationEnabled ? 'codex' : null,
      project.comfyUiEnabled ? 'comfyui' : null,
      project.stableDiffusionCppEnabled ? 'stable_diffusion_cpp' : null,
    ].filter((provider): provider is GeneratorProvider => Boolean(provider));
    if (!providers.length) throw new Error('Włącz co najmniej jeden generator w ustawieniach projektu.');
    const jobs: GenerationJob[] = [];
    let assetId = input.assetId;
    for (const provider of providers) {
      const job = this.enqueue({ ...input, assetId, generatorProvider: provider });
      jobs.push(job);
      assetId ??= job.assetId;
    }
    return jobs;
  }

  setMaxConcurrentJobs(value: number): void {
    this.maxConcurrentJobs = Math.max(1, Math.min(8, Math.trunc(value)));
    void this.pump();
  }

  async cancel(jobId: string): Promise<void> {
    const database = this.requireDatabase();
    const job = database.getJob(jobId);
    if (!job) throw new Error('Nie znaleziono zadania.');
    if (job.status === 'queued') {
      database.updateJob(jobId, 'cancelled', 'Anulowane przez użytkownika');
      this.log(database, jobId, 'system', 'warning', 0, 'Generacja została anulowana przed rozpoczęciem.');
      this.emitEvent({ type: 'queue', job: database.getJob(jobId)! });
      return;
    }
    const active = this.activeJobs.get(jobId);
    if (active) {
      database.updateJob(jobId, 'cancelled', 'Anulowanie…');
      this.log(database, jobId, 'system', 'warning', 0, 'Użytkownik przerwał aktywną generację.');
      active.controller.abort();
      this.emitEvent({ type: 'queue', job: database.getJob(jobId)! });
    }
  }

  retry(jobId: string): GenerationJob {
    const database = this.requireDatabase();
    const job = database.getJob(jobId);
    if (!job || !['failed', 'cancelled', 'interrupted'].includes(job.status)) {
      throw new Error('Ponowić można tylko zakończone niepowodzeniem zadanie.');
    }
    const context = database.getJobContext(jobId);
    const retried = this.enqueue({
      assetId: context.assetId,
      parentVersionId: context.parentVersionId ?? undefined,
      name: context.assetName,
      prompt: context.prompt,
      feedback: context.feedback || undefined,
      mode: context.mode,
      category: context.category,
      elevationLevels: context.elevationLevels || undefined,
      relativeWidth: context.relativeWidth,
      relativeHeight: context.relativeHeight,
      footprint: context.footprint,
      generatorProvider: context.generatorProvider,
    });
    this.logger.info('generation.retried', {
      previousJobId: jobId,
      jobId: retried.id,
      assetId: retried.assetId,
      versionId: retried.versionId,
    });
    return retried;
  }

  jobs(): GenerationJob[] {
    return this.requireDatabase().listJobs();
  }

  logs(assetId: string) {
    return this.requireDatabase().listGenerationLogs(assetId);
  }

  async verify(versionId: string) {
    const database = this.requireDatabase();
    if (this.activeVerifications.has(versionId)) {
      throw new Error('Weryfikacja tej wersji już trwa.');
    }
    const context = database.getAiVerificationContext(versionId);
    if (!['needs_review', 'approved', 'rejected'].includes(context.status)) {
      throw new Error('Zweryfikować można tylko ukończoną wersję assetu.');
    }
    if (context.aiVerificationStatus === 'passed') {
      return database.getAsset(context.assetId)!;
    }

    const controller = new AbortController();
    this.activeVerifications.set(versionId, controller);
    this.log(database, context.jobId, 'verification', 'info', 0, 'Uruchomiono weryfikację AI na żądanie.');
    try {
      const project = database.getProject();
      const threadId = await this.codex.ensureAssetThread(context.assetId, context.assetThreadId);
      const result = await this.codex.runTurn(threadId, [
        {
          type: 'text',
          text: [
            'Zweryfikuj wizualnie istniejący asset. Nie generuj ani nie edytuj obrazu i nie zapisuj żadnych plików.',
            `Nazwa assetu: ${context.assetName}`,
            `Kategoria: ${context.category}`,
            `Pierwotne polecenie: ${context.prompt || '(brak dodatkowego polecenia)'}`,
            context.feedback ? `Uwagi do tej wersji: ${context.feedback}` : '',
            `Brief projektu: ${project.artBrief || '(brak)'}`,
            `Kanoniczny styl projektu: ${project.styleSummary || '(jeszcze nie ustalono)'}`,
            'Kontrole techniczne PNG, wymiarów i geometrii zostały już wykonane deterministycznie.',
            'Oceń zgodność treści, kompozycji, perspektywy i stylu z powyższym kontekstem.',
            'Zwróć status passed, jeśli asset nadaje się do oceny użytkownika. Zwróć failed tylko przy konkretnej widocznej wadzie i krótko ją opisz po polsku.',
            'Zwróć wyłącznie JSON zgodny ze schematem.',
          ].filter(Boolean).join('\n\n'),
        },
        { type: 'localImage', path: database.resolveRelative(context.finalPath), detail: 'high' },
      ], aiVerificationOutputSchema, undefined, undefined, controller.signal);
      const verification = aiVerificationResponseSchema.parse(parseJson(result.finalMessage));
      const detail = database.setAiVerificationResult(versionId, verification.status, verification.message);
      this.log(
        database,
        context.jobId,
        'verification',
        verification.status === 'passed' ? 'success' : 'warning',
        0,
        verification.message,
      );
      this.emitEvent({
        type: 'verification-completed',
        assetId: context.assetId,
        versionId,
        status: verification.status,
      });
      return detail;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      database.setAiVerificationResult(versionId, 'failed', message);
      this.log(database, context.jobId, 'verification', 'error', 0, `Weryfikacja AI nie powiodła się: ${message}`);
      this.emitEvent({ type: 'verification-completed', assetId: context.assetId, versionId, status: 'failed' });
      throw error;
    } finally {
      this.activeVerifications.delete(versionId);
      if (!this.activeJobs.size && !this.activeVerifications.size) this.emit('idle');
    }
  }

  async updateStyleAfterApproval(assetId: string, versionId: string): Promise<void> {
    const database = this.requireDatabase();
    const asset = database.getAsset(assetId);
    const version = asset?.versions.find((item) => item.id === versionId);
    if (!asset || !version?.finalPath) return;
    const approvedImagePath = version.finalPath;
    try {
      await this.codex.runExclusive(async () => {
        const threadId = await this.codex.ensureAssetThread(asset.id, asset.codexThreadId);
        const project = database.getProject();
        const prompt = buildStylePrompt(project.styleSummary, asset.name, version.category, version.tags);
        const result = await this.codex.runTurn(threadId, [
          { type: 'text', text: prompt },
          { type: 'localImage', path: database.resolveRelative(approvedImagePath), detail: 'high' },
        ], styleOutputSchema);
        const parsed = styleResponseSchema.parse(parseJson(result.finalMessage));
        const currentAsset = database.getAsset(assetId);
        const stillApproved = currentAsset?.currentApprovedVersionId === versionId
          && currentAsset.versions.find((item) => item.id === versionId)?.status === 'approved';
        if (!stillApproved) {
          database.markStyleStale();
          return;
        }
        const revision = database.addStyleRevision(parsed.summary, 'ai', versionId);
        this.emitEvent({ type: 'style-updated', revisionId: revision.id });
      });
    } catch {
      database.markStyleStale();
      this.logger.warn('style.update.failed', { assetId, versionId });
    }
  }

  async rebuildStyle(): Promise<void> {
    const database = this.requireDatabase();
    database.markStyleStale();
    await this.codex.runExclusive(async () => {
      const threadId = await this.codex.startUtilityThread();
      const project = database.getProject();
      const result = await this.codex.runTurn(threadId, [{
        type: 'text',
        text: [
          'Przebuduj od zera kanoniczne podsumowanie stylu projektu.',
          'Użyj registry.search_assets ze statusem approved i registry.get_asset dla reprezentatywnych assetów.',
          `Brief projektu: ${project.artBrief || '(brak)'}`,
          styleSectionsInstruction(),
          'Zwróć wyłącznie JSON zgodny ze schematem.',
        ].join('\n\n'),
      }], styleOutputSchema);
      const parsed = styleResponseSchema.parse(parseJson(result.finalMessage));
      const revision = database.addStyleRevision(parsed.summary, 'ai');
      this.emitEvent({ type: 'style-updated', revisionId: revision.id });
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.database) return;
    this.pumping = true;
    try {
      while (this.database && !this.stopping && this.activeJobs.size < this.maxConcurrentJobs) {
        const activeAssetIds = new Set([...this.activeJobs.values()].map((active) => active.assetId));
        const job = this.database.nextQueuedJob(activeAssetIds);
        if (!job) break;
        const database = this.database;
        const controller = new AbortController();
        this.activeJobs.set(job.id, { assetId: job.assetId, controller });
        void this.processJob(database, job, controller.signal).finally(() => {
          this.activeJobs.delete(job.id);
          if (!this.activeJobs.size && !this.activeVerifications.size) this.emit('idle');
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private async processJob(database: ProjectDatabase, job: GenerationJob, signal: AbortSignal): Promise<void> {
    const providerLabel = generatorProviderLabel(job.generatorProvider);
    database.updateJob(job.id, 'generating', `Uruchamianie ${providerLabel}…`);
    this.emitEvent({ type: 'queue', job: database.getJob(job.id)! });
    let activeAttempt = 1;
    try {
      await (async () => {
        const currentJob = database.getJob(job.id);
        if (!currentJob || currentJob.status === 'cancelled') return;
        const context = database.getJobContext(job.id);
        const stagingPath = path.join(database.rootPath, 'staging', job.id);
        mkdirSync(stagingPath, { recursive: true });
        const codexHealth = context.generatorProvider === 'codex' && typeof this.codex.health === 'function'
          ? this.codex.health()
          : null;
        if (codexHealth && codexHealth.state !== 'ready') {
          throw new Error(codexHealth.message || 'Codex nie jest gotowy.');
        }
        if (context.generatorProvider === 'comfyui' && this.comfy.health().state !== 'ready') {
          const refreshed = await this.comfy.refresh();
          if (refreshed.state !== 'ready') throw new Error(refreshed.message);
        }
        if (context.generatorProvider === 'stable_diffusion_cpp'
          && this.stableDiffusionCpp.health().state !== 'ready') {
          const refreshed = await this.stableDiffusionCpp.refresh();
          if (refreshed.state !== 'ready') throw new Error(refreshed.message);
        }
        const threadId = context.generatorProvider === 'codex'
          ? await this.codex.ensureAssetThread(context.assetId, context.assetThreadId)
          : null;
        const project = database.getProject();
        const projectReferences = database.listProjectReferences();
        const terrainVerification = isTileAssetCategory(context.category)
          && context.footprint.x === 1
          && context.footprint.y === 1;
        const roadVerification = isRoadAssetCategory(context.category)
          && context.footprint.x === 1
          && context.footprint.y === 1;
        const maxAttempts = project.aiVerificationEnabled && (terrainVerification || roadVerification)
          ? MAX_GEOMETRY_ATTEMPTS
          : 1;
        let previousCandidate: string | null = null;
        let previousSeamPreview: string | null = null;
        let verificationFeedback = '';

        for (activeAttempt = 1; activeAttempt <= maxAttempts; activeAttempt += 1) {
          if (database.getJob(job.id)?.status === 'cancelled') return;
          const attemptPath = path.join(stagingPath, `attempt-${activeAttempt}`);
          mkdirSync(attemptPath, { recursive: true });
          const attemptLabel = `Próba ${activeAttempt}/${maxAttempts}`;
          database.updateJob(job.id, 'generating', `${attemptLabel}: generowanie…`);
          this.log(
            database,
            job.id,
            'generation',
            'info',
            activeAttempt,
            activeAttempt === 1 ? 'Rozpoczęto generowanie obrazu.' : 'Rozpoczęto generowanie automatycznej korekty.',
          );

          let response: z.infer<typeof generationResponseSchema>;
          let providerRunId = '';
          let generatorModel = context.generatorProvider === 'codex' ? 'imagegen' : '';
          let generatorWorkflowHash = '';
          let generationMetadata: Record<string, unknown> = {};
          let codexTurnId: string | undefined;
          let resultItems: Array<Record<string, unknown>> = [];

          if (context.generatorProvider === 'codex') {
            const input: Array<Record<string, unknown>> = [
              {
                type: 'text',
                text: activeAttempt === 1
                  ? buildGenerationPrompt(
                    context,
                    project.artBrief,
                    project.styleSummary,
                    project.tileWidthPx,
                    project.tileHeightPx,
                    attemptPath,
                    projectReferences,
                    project.aiVerificationEnabled,
                  )
                  : terrainVerification
                    ? buildTerrainRetryPrompt(
                      context,
                      project.artBrief,
                      project.styleSummary,
                      project.tileWidthPx,
                      project.tileHeightPx,
                      attemptPath,
                      verificationFeedback,
                      projectReferences,
                      Boolean(previousSeamPreview),
                    )
                    : buildRoadRetryPrompt(
                      context,
                      project.artBrief,
                      project.styleSummary,
                      project.tileWidthPx,
                      project.tileHeightPx,
                      attemptPath,
                      verificationFeedback,
                      projectReferences,
                    ),
              },
              { type: 'skill', name: 'imagegen', path: this.codex.skillPath() },
            ];
            if (previousCandidate) {
              input.push({ type: 'localImage', path: previousCandidate, detail: 'original' });
              if (previousSeamPreview) input.push({ type: 'localImage', path: previousSeamPreview, detail: 'original' });
            } else if (context.mode === 'edit' && context.parentFinalPath) {
              input.push({ type: 'localImage', path: database.resolveRelative(context.parentFinalPath), detail: 'original' });
            }
            const result = await this.codex.runTurn(
              threadId!,
              input,
              generationOutputSchema,
              (notification) => this.forwardCodexEvent(job.id, activeAttempt, notification),
              roadVerification ? ROAD_GENERATION_TIMEOUT_MS : undefined,
              signal,
            );
            response = generationResponseSchema.parse(parseJson(result.finalMessage));
            codexTurnId = result.turnId;
            providerRunId = result.turnId;
            resultItems = result.items;
            generationMetadata = { skill: 'imagegen' };
          } else if (context.generatorProvider === 'comfyui') {
            const comfyOutput = path.join(attemptPath, roadVerification ? 'road-material.png' : 'final.png');
            const comfyResult = await this.comfy.generate({
              assetName: context.assetName,
              category: context.category,
              prompt: context.prompt,
              feedback: context.feedback,
              artBrief: project.artBrief,
              styleSummary: project.styleSummary,
              outputPath: comfyOutput,
              outputSize: assetPixelSize(project, context),
              roadAtlas: roadVerification,
              attempt: activeAttempt,
              verificationFeedback,
              signal,
              onProgress: (message) => {
                database.updateJob(job.id, 'generating', `${attemptLabel}: ${message}`);
                this.emitEvent({ type: 'progress', jobId: job.id, message });
              },
            });
            response = {
              status: 'completed',
              finalPath: comfyResult.finalPath,
              category: context.category,
              tags: [],
              pivot: defaultPivot(context.category),
              description: context.prompt.trim() || context.assetName,
              message: '',
            };
            providerRunId = comfyResult.promptId;
            generatorModel = comfyResult.model;
            generatorWorkflowHash = comfyResult.workflowHash;
            generationMetadata = comfyResult.metadata;
          } else {
            const stableDiffusionCppOutput = path.join(
              attemptPath,
              roadVerification ? 'road-material.png' : 'final.png',
            );
            const stableDiffusionCppResult = await this.stableDiffusionCpp.generate({
              assetName: context.assetName,
              category: context.category,
              prompt: context.prompt,
              feedback: context.feedback,
              artBrief: project.artBrief,
              styleSummary: project.styleSummary,
              outputPath: stableDiffusionCppOutput,
              outputSize: assetPixelSize(project, context),
              roadAtlas: roadVerification,
              attempt: activeAttempt,
              verificationFeedback,
              signal,
              onProgress: (message) => {
                database.updateJob(job.id, 'generating', `${attemptLabel}: ${message}`);
                this.emitEvent({ type: 'progress', jobId: job.id, message });
              },
            });
            response = {
              status: 'completed',
              finalPath: stableDiffusionCppResult.finalPath,
              category: context.category,
              tags: [],
              pivot: defaultPivot(context.category),
              description: context.prompt.trim() || context.assetName,
              message: '',
            };
            providerRunId = stableDiffusionCppResult.runId;
            generatorModel = stableDiffusionCppResult.model;
            generatorWorkflowHash = stableDiffusionCppResult.workflowHash;
            generationMetadata = stableDiffusionCppResult.metadata;
          }
          if (database.getJob(job.id)?.status === 'cancelled') return;
          if (response.status === 'needs_user_decision' && !roadVerification) {
            throw new Error(response.message || 'Generacja wymaga decyzji użytkownika. Sprawdź propozycje ustawień projektu i ponów próbę po ich rozpatrzeniu.');
          }

          let roadMaterialPath: string | null = null;
          if (roadVerification) {
            try {
              roadMaterialPath = resolveGeneratedFile(database, attemptPath, response.finalPath, resultItems);
            } catch {
              // The processing error below includes a road-specific explanation and participates in auto-retry.
            }
          }

          let roadCandidateFiles: RoadVariantFile[] = [];
          let stagedFinal: string;
          if (roadVerification) {
            try {
              roadCandidateFiles = await createRoadVariantsFromMaterial(
                attemptPath,
                roadMaterialPath,
                project.tileWidthPx,
                project.tileHeightPx,
              );
              stagedFinal = path.join(attemptPath, 'road-grid.png');
              await createRoadVariantGrid(
                roadCandidateFiles,
                stagedFinal,
                project.tileWidthPx,
                project.tileHeightPx,
              );
            } catch (error) {
              verificationFeedback = [
                response.status === 'needs_user_decision' ? response.message : '',
                error instanceof Error ? error.message : String(error),
              ].filter(Boolean).join(' ');
              this.log(database, job.id, 'verification', 'warning', activeAttempt, verificationFeedback);
              if (activeAttempt < maxAttempts) {
                this.log(
                  database,
                  job.id,
                  'retry',
                  'warning',
                  activeAttempt,
                  `Zestaw drogi jest niepełny. Zaplanowano automatyczną próbę ${activeAttempt + 1}/${maxAttempts}.`,
                );
                continue;
              }
              throw new Error(project.aiVerificationEnabled
                ? `Nie udało się uzyskać kompletu 16 wariantów drogi po ${maxAttempts} próbach. ${verificationFeedback}`
                : `Nie udało się uzyskać kompletu 16 wariantów drogi. ${verificationFeedback} Weryfikacja AI jest wyłączona, więc nie uruchomiono automatycznej korekty.`);
            }
          } else {
            stagedFinal = resolveGeneratedFile(database, attemptPath, response.finalPath, resultItems);
          }
          previousCandidate = stagedFinal;
          database.addArtifact(job.id, `candidate-attempt-${activeAttempt}`, database.relative(stagedFinal), 'image/png');
          this.log(
            database,
            job.id,
            'generation',
            'success',
            activeAttempt,
            roadVerification
              ? `${providerLabel} zapisał materiał nawierzchni; post-process zbudował spójny komplet 16 wariantów.`
              : `${providerLabel} zapisał kandydat PNG.`,
          );

          let validated: Awaited<ReturnType<typeof validateTransparentPng>>;
          if (terrainVerification) {
            database.updateJob(job.id, 'generating', `${attemptLabel}: weryfikacja szwów 3×3…`);
            this.log(database, job.id, 'verification', 'info', activeAttempt, 'Uruchomiono deterministyczny test szwów 3×3.');
            try {
              validated = await validateTransparentPng(stagedFinal);
              const seamPreviewPath = path.join(attemptPath, 'seam-preview.png');
              const seam = await verifyTerrainSeams(
                stagedFinal,
                seamPreviewPath,
                project.tileWidthPx,
                project.tileHeightPx,
              );
              previousSeamPreview = seamPreviewPath;
              database.addArtifact(
                job.id,
                `seam-preview-attempt-${activeAttempt}`,
                database.relative(seamPreviewPath),
                'image/png',
              );
              let geometryFailure = '';
              try {
                if (context.category === 'elevated_tile') {
                  await validateElevatedTerrainTile(
                    stagedFinal,
                    project.tileWidthPx,
                    project.tileHeightPx,
                    project.tileHeightPx * context.elevationLevels,
                  );
                } else {
                  await validateTerrainTile(stagedFinal, project.tileWidthPx, project.tileHeightPx);
                }
              } catch (error) {
                geometryFailure = error instanceof Error ? error.message : String(error);
              }
              if (geometryFailure || !seam.passed) {
                throw new Error([
                  geometryFailure ? `Walidacja geometrii: ${geometryFailure}` : '',
                  summarizeTerrainSeamResult(seam),
                ].filter(Boolean).join(' '));
              }
              this.log(
                database,
                job.id,
                'verification',
                'success',
                activeAttempt,
                `Test 3×3 zaliczony: geometria jest równa, brak przezroczystych szczelin `
                + `i widocznych szwów koloru (${seam.gapPixels} luk; `
                + `${formatGapRatio(seam.colorSeamRatio)} próbek krawędzi ponad próg).`,
              );
            } catch (error) {
              verificationFeedback = error instanceof Error ? error.message : String(error);
              this.log(database, job.id, 'verification', 'warning', activeAttempt, verificationFeedback);
              if (activeAttempt < maxAttempts) {
                this.log(
                  database,
                  job.id,
                  'retry',
                  'warning',
                  activeAttempt,
                  `Weryfikacja nieudana. Zaplanowano automatyczną próbę ${activeAttempt + 1}/${maxAttempts}.`,
                );
                continue;
              }
              throw new Error(project.aiVerificationEnabled
                ? `Automatyczna weryfikacja terenu nie powiodła się po ${maxAttempts} próbach. ${verificationFeedback}`
                : `Deterministyczna weryfikacja terenu nie powiodła się. ${verificationFeedback} Weryfikacja AI jest wyłączona, więc nie uruchomiono automatycznej korekty.`);
            }
          } else if (roadVerification) {
            database.updateJob(job.id, 'generating', `${attemptLabel}: weryfikacja połączeń drogi…`);
            this.log(database, job.id, 'verification', 'info', activeAttempt, 'Uruchomiono deterministyczny test road tile.');
            try {
              let firstValidation: Awaited<ReturnType<typeof validateTransparentPng>> | null = null;
              for (const variant of roadCandidateFiles) {
                const candidateValidation = await validateTransparentPng(variant.filePath);
                firstValidation ??= candidateValidation;
                await validateRoadTile(
                  variant.filePath,
                  project.tileWidthPx,
                  project.tileHeightPx,
                  variant.connectionMask,
                );
              }
              validated = firstValidation!;
              this.log(
                database,
                job.id,
                'verification',
                'success',
                activeAttempt,
                'Zestaw road tile zaliczony: 16/16 wariantów ma przezroczyste tło, spójną drogę i poprawne połączenia.',
              );
            } catch (error) {
              verificationFeedback = error instanceof Error ? error.message : String(error);
              this.log(database, job.id, 'verification', 'warning', activeAttempt, verificationFeedback);
              if (activeAttempt < maxAttempts) {
                this.log(
                  database,
                  job.id,
                  'retry',
                  'warning',
                  activeAttempt,
                  `Weryfikacja road tile nieudana. Zaplanowano automatyczną próbę ${activeAttempt + 1}/${maxAttempts}.`,
                );
                continue;
              }
              throw new Error(project.aiVerificationEnabled
                ? `Automatyczna weryfikacja road tile nie powiodła się po ${maxAttempts} próbach. ${verificationFeedback}`
                : `Deterministyczna weryfikacja road tile nie powiodła się. ${verificationFeedback} Weryfikacja AI jest wyłączona, więc nie uruchomiono automatycznej korekty.`);
            }
          } else {
            validated = await validateTransparentPng(stagedFinal);
            const expectedSize = assetPixelSize(project, context);
            if (expectedSize && (validated.width !== expectedSize.width || validated.height !== expectedSize.height)) {
              throw new Error(
                `Canvas typu ${context.category} musi mieć ${expectedSize.width}×${expectedSize.height}px, `
                + `a wygenerowany obraz ma ${validated.width}×${validated.height}px.`,
              );
            }
          }

          const versionDirectory = path.join(database.rootPath, 'assets', context.assetId, context.versionId);
          mkdirSync(versionDirectory, { recursive: true });
          const finalPath = path.join(versionDirectory, 'final.png');
          const thumbnailPath = path.join(versionDirectory, 'preview.webp');
          copyFileSync(stagedFinal, finalPath);
          const storedRoadVariants = roadVerification
            ? roadCandidateFiles.map((variant) => {
              const variantsDirectory = path.join(versionDirectory, 'road-variants');
              mkdirSync(variantsDirectory, { recursive: true });
              const storedPath = path.join(variantsDirectory, path.basename(variant.filePath));
              copyFileSync(variant.filePath, storedPath);
              return {
                connectionMask: variant.connectionMask,
                finalPath: database.relative(storedPath),
                width: project.tileWidthPx,
                height: project.tileHeightPx,
              };
            })
            : undefined;
          await createThumbnail(finalPath, thumbnailPath);
          const relativeFinal = database.relative(finalPath);
          database.addArtifact(job.id, 'final', relativeFinal, 'image/png');
          database.addArtifact(job.id, 'thumbnail', database.relative(thumbnailPath), 'image/webp');
          database.finalizeGeneration(job.id, {
            finalPath: relativeFinal,
            width: validated.width,
            height: validated.height,
            category: context.category,
            tags: response.tags,
            pivot: response.pivot,
            description: response.description,
            aiVerificationStatus: context.generatorProvider === 'codex' && project.aiVerificationEnabled ? 'passed' : 'pending',
            codexTurnId,
            generatorProvider: context.generatorProvider,
            generatorModel,
            generatorWorkflowHash,
            providerRunId,
            generationMetadata: { ...generationMetadata, attempt: activeAttempt },
            roadVariants: storedRoadVariants,
          });
          if (context.generatorProvider !== 'codex'
            && project.aiVerificationEnabled
            && this.codex.health().state === 'ready') {
            try {
              await this.verify(context.versionId);
            } catch {
              // The version remains reviewable; the verification status and message carry the failure.
            }
          }
          this.log(database, job.id, 'system', 'success', activeAttempt, 'Asset jest gotowy do weryfikacji użytkownika.');
          return;
        }
      })();
      if (database.getJob(job.id)?.status === 'needs_review') {
        this.emitEvent({ type: 'completed', jobId: job.id, assetId: job.assetId, versionId: job.versionId });
      }
    } catch (error) {
      if (database.getJob(job.id)?.status !== 'cancelled') {
        const message = error instanceof Error ? error.message : String(error);
        database.updateJob(job.id, 'failed', 'Generacja nie powiodła się', message);
        this.log(database, job.id, 'system', 'error', activeAttempt, message);
        this.logger.error('generation.failed', {
          jobId: job.id,
          assetId: job.assetId,
          versionId: job.versionId,
          message,
          stack: error instanceof Error ? error.stack : undefined,
        });
        this.emitEvent({ type: 'failed', jobId: job.id, message });
      }
    }
  }

  private forwardCodexEvent(jobId: string, attempt: number, notification: CodexNotification): void {
    const database = this.requireDatabase();
    let message: string | null = null;
    let details: GenerationLogEntry['details'] = null;
    if (notification.method === 'item/started') {
      const item = notification.params.item as Record<string, unknown> | undefined;
      if (item?.type === 'imageGeneration') message = 'Codex generuje obraz…';
      if (item?.type === 'commandExecution') message = 'Codex przygotowuje finalny plik PNG…';
      if (item?.type === 'imageView') message = 'Codex weryfikuje wynik…';
      if (item?.type === 'dynamicToolCall') {
        const description = describeRegistryCall(item);
        message = description.message;
        details = description.details;
        if (details.tool === 'registry.get_reference') {
          const referenceId = details.arguments.referenceId;
          const reference = typeof referenceId === 'string'
            ? database.getProjectReference(referenceId)
            : null;
          if (reference) {
            message = `Codex pobiera projektowy obraz referencyjny: ${reference.description || reference.name}.`;
          }
        }
      }
    }
    if (message) {
      database.updateJob(jobId, 'generating', message);
      this.log(database, jobId, 'generation', 'info', attempt, message, details);
      this.emitEvent({ type: 'progress', jobId, message });
    }
    this.emitEvent({ type: 'codex-event', jobId, method: notification.method, payload: notification.params });
  }

  private emitEvent(event: GenerationEvent): void {
    this.emit('event', event);
  }

  private log(
    database: ProjectDatabase,
    jobId: string,
    stage: GenerationStage,
    level: GenerationLogLevel,
    attempt: number,
    message: string,
    details: GenerationLogEntry['details'] = null,
  ): void {
    const entry = database.addGenerationLog(jobId, stage, level, attempt, message, details);
    this.emitEvent({ type: 'log', entry });
  }

  private requireDatabase(): ProjectDatabase {
    if (!this.database) throw new Error('Najpierw otwórz projekt.');
    return this.database;
  }
}

function buildGenerationPrompt(
  context: JobContext,
  artBrief: string,
  styleSummary: string,
  tileWidth: number,
  tileHeight: number,
  stagingPath: string,
  projectReferences: ProjectReference[],
  aiVerificationEnabled: boolean,
): string {
  const editInstructions = context.mode === 'edit'
    ? [
      'Intent: edit.',
      isRoadAssetCategory(context.category)
        ? 'Image 1 is the previous 4x4 road set. Use only its material, palette and brushwork as reference. Do not reproduce its geometry; generate one replacement road-surface material swatch and apply the requested change to that material.'
        : 'Image 1 is the edit target. Inspect it first, change only the requested detail, and preserve composition, silhouette, palette, perspective, materials, and every unmentioned element.',
    ].join('\n')
    : 'Intent: generate a new asset. Existing registry images are references only when fetched through the tools.';
  const isTerrainTile = isTileAssetCategory(context.category)
    && context.footprint.x === 1
    && context.footprint.y === 1;
  const elevatedWallHeight = tileHeight * context.elevationLevels;
  const relativePixelSize = assetPixelSize(
    { tileWidthPx: tileWidth, tileHeightPx: tileHeight },
    context,
  );
  const geometryInstructions = isRoadAssetCategory(context.category)
    ? buildRoadMaterialInstructions(tileWidth, tileHeight, aiVerificationEnabled)
    : !isTerrainTile
    ? relativePixelSize
      ? [
        `Relative asset size: ${context.relativeWidth} tile widths × ${context.relativeHeight} tile heights.`,
        `The final transparent PNG canvas MUST be exactly ${relativePixelSize.width}x${relativePixelSize.height}px.`,
        `The project base tile is ${tileWidth}x${tileHeight}px. Scale the ${context.category} consistently against that tile; keep the full silhouette visible and anchor it at the bottom center with transparent padding where needed.`,
      ].join('\n')
      : 'Composition/framing: one isolated isometric asset, fixed camera, fully visible silhouette, with transparent padding where needed.'
    : context.category === 'elevated_tile'
      ? [
        `Asset type: ELEVATED TILE with elevation height ${context.elevationLevels}. This type is authoritative; do not flatten the asset.`,
        `The final transparent PNG canvas MUST be exactly ${tileWidth}x${tileHeight + elevatedWallHeight}px.`,
        `The top walkable surface is one precise ${tileWidth}x${tileHeight}px 2:1 isometric diamond in the upper part of the canvas. Its vertices touch canvas top, left, and right; its bottom vertex is at y=${tileHeight - 1}.`,
        `Below that top diamond, render clearly visible front-left and front-right vertical terrain walls descending ${elevatedWallHeight}px to the bottom of the canvas. Preserve a complete raised-block silhouette like a cut-away soil tile.`,
        `Copies are placed on the exact isometric offsets (±${tileWidth / 2}px, +${tileHeight / 2}px). Every repeated top diamond must have identical geometry and meet edge-to-edge without overlap, gaps, steps, bulges, or exposed wall pixels between equal-height neighbors.`,
        'The top surface material must continue to all four diamond edges. The top-left edge must match the bottom-right edge pixel-for-pixel, and the top-right edge must match the bottom-left edge, so the texture and color continue across repeated copies.',
        'Do not draw an outline, bevel, shadow, highlight, dark rim, or color change along any top-diamond edge. Side walls may have coherent material thickness and directional shading, but no cast shadow or contact shadow outside the sprite.',
        'Keep transparent pixels outside the raised block. Never replace the block with a flat diamond, and never crop away its walls.',
        aiVerificationEnabled
          ? 'Before returning final.png, build an exact 3x3 repeat using the grid offsets above and inspect it at 100%: the nine top faces must read as one continuous surface with no visible grid. Repair the sprite if any internal boundary is visible.'
          : '',
      ].join('\n')
      : [
        'Asset type: FLAT TILE.',
        `The final PNG canvas MUST be exactly ${tileWidth}x${tileHeight}px.`,
        'The isometric diamond must fill the entire canvas: its four vertices touch the top, right, bottom, and left canvas edges. No outer transparent padding.',
        `Copies are placed on the exact isometric offsets (±${tileWidth / 2}px, +${tileHeight / 2}px). Every repeated diamond must have identical geometry and meet edge-to-edge without overlap, gaps, steps, or bulges.`,
        'It is a flat seamless ground tile. The top-left edge must match the bottom-right edge pixel-for-pixel, and the top-right edge must match the bottom-left edge, so texture, color, and lighting continue across copies.',
        'Do not draw an outline, bevel, shadow, highlight, dark rim, or color change along any diamond edge. No visible vertical side walls, soil thickness, extrusion, cliff face, cast shadow, or contact shadow.',
        aiVerificationEnabled
          ? 'Before returning final.png, build an exact 3x3 repeat using the grid offsets above and inspect it at 100%: it must read as one continuous surface with no visible grid. Repair the sprite if any internal boundary is visible.'
          : '',
        aiVerificationEnabled
          ? 'After chroma-key removal, crop and resize the result as needed, then validate the exact dimensions and edge-to-edge alpha bounds before returning final.png.'
          : '',
      ].join('\n');
  const outputInstructions = isRoadAssetCategory(context.category)
    ? [
      'Use one built-in image generation call to create one opaque, full-frame material swatch. This is an intermediate texture source, not the final transparent road asset.',
      `Copy the selected native-resolution image to exactly ${path.join(stagingPath, 'road-material.png')}. Do not resize it and do not build an atlas or any road variants.`,
      'Do not run background removal, chroma-key processing or the transparent-output helper. Do not use CLI/API and do not request OPENAI_API_KEY. The application creates geometry, shoulders, alpha, exact dimensions and all 16 variants after this turn.',
      `In the final JSON use ${path.join(stagingPath, 'road-material.png')} as finalPath.`,
    ].join('\n')
    : `Project-bound output: copy the final transparent PNG to exactly ${path.join(stagingPath, 'final.png')}. Preserve any useful source as ${path.join(stagingPath, 'source.png')}.`;
  return [
    '$imagegen',
    'Use case: stylized-concept',
    `Asset type: isometric Unity game asset, category ${context.category}`,
    `Asset title: ${context.assetName}`,
    context.prompt
      ? `Additional request: ${context.prompt}`
      : 'No additional request was provided. Generate the asset from its title and project context.',
    context.feedback ? `Requested change: ${context.feedback}` : '',
    editInstructions,
    `Project art brief: ${artBrief || '(not established)'}`,
    `Canonical approved style summary: ${styleSummary || '(no approved assets yet)'}`,
    formatProjectReferences(projectReferences),
    `Isometric base tile: ${tileWidth}x${tileHeight}px (fixed 2:1); asset type: ${context.category}; footprint: ${context.footprint.x}x${context.footprint.y} cells.`,
    geometryInstructions,
    isRoadAssetCategory(context.category)
      ? 'Constraints for the source swatch: opaque edge-to-edge material; no text; no watermark; no frame; no objects. The application, not imagegen, makes the final road variants transparent.'
      : 'Constraints: final deliverable must be a transparent PNG with transparent corners; no text; no watermark; no frame; no unrelated props.',
    isRoadAssetCategory(context.category)
      ? 'Use the built-in image generation workflow. This source intentionally does not request transparency, so do not enter the imagegen transparent-output workflow.'
      : 'Use the built-in image generation workflow. Follow the imagegen skill transparent-output workflow. Never switch to CLI/API or request OPENAI_API_KEY.',
    outputInstructions,
    aiVerificationEnabled
      ? isRoadAssetCategory(context.category)
        ? 'AI verification is enabled. Inspect the saved material swatch: it must be a coherent close-up surface filling the whole frame, with no chroma key, road silhouette, atlas, grid, junction or isolated object.'
        : 'AI verification is enabled. After saving the output, inspect the final image with image view and correct visible defects before returning the result.'
      : 'AI verification is disabled by project settings. After the image generator saves the required PNG files, do not open them with image view, do not perform a subjective visual review, and do not regenerate them. Return the result immediately; the application will still run deterministic technical validation.',
    'Use registry.list_tags and registry.search_assets when useful. Load only a small number of relevant approved assets with registry.get_asset.',
    'Project reference images are user-provided art direction. Use registry.list_references and registry.get_reference when their descriptions are relevant to this request.',
    'If a reference proves that the current art brief, base tile width, or PPU must change for a valid result, call registry.propose_project_settings with exact proposed values, a concrete reason, and the relevant referenceIds. Asset type, elevation height, and relative asset size belong to the asset and must never be proposed as project settings. This creates a proposal only and never grants approval.',
    'When that settings change is required before generation, do not generate against guessed settings. Submit the proposal, then return status needs_user_decision and tell the user to approve it and retry this generation. Until approval, the current project settings remain authoritative.',
    `Return category exactly as ${context.category}; also return concise searchable tags.`,
    buildPivotInstruction(context.category, tileHeight, elevatedWallHeight, relativePixelSize?.height, aiVerificationEnabled),
    aiVerificationEnabled
      ? 'Choose pivot only after the final PNG is complete and inspected. Return it as normalized Unity coordinates in pivot; the user can override this recommendation during final review.'
      : 'Return the pivot from the category geometry and intended ground anchor without reopening the final PNG. The user can override it during final review.',
    'Finish with JSON matching the supplied schema and put the actual final PNG path in finalPath.',
    isRoadAssetCategory(context.category)
      ? 'The road source is deliberately opaque and requires no transparency fallback. Do not return needs_user_decision merely because built-in image generation has no native alpha.'
      : 'If the built-in transparent workflow is genuinely unsuitable, do not use fallback; return status needs_user_decision and explain why in message.',
  ].filter(Boolean).join('\n\n');
}

function buildPivotInstruction(
  category: AssetCategory,
  tileHeight: number,
  elevatedWallHeight: number,
  relativeCanvasHeight?: number,
  aiVerificationEnabled = true,
): string {
  if (category === 'flat_tile' || category === 'road_tile') {
    return 'Pivot recommendation: use the exact cell center, normalized Unity pivot {"x":0.5,"y":0.5}.';
  }
  if (category === 'elevated_tile') {
    const canvasHeight = tileHeight + elevatedWallHeight;
    const pivotY = 1 - (tileHeight / 2) / canvasHeight;
    return `Pivot recommendation: anchor the center of the top walkable diamond. For this exact canvas return normalized Unity pivot {"x":0.5,"y":${Number(pivotY.toFixed(6))}}.`;
  }
  if (category === 'building' || category === 'character' || category === 'vegetation' || category === 'prop') {
    return [
      aiVerificationEnabled
        ? 'Pivot recommendation: inspect the finished alpha silhouette and place the anchor at its logical ground-contact point, usually bottom-center at the feet or base.'
        : 'Pivot recommendation: use the logical ground-contact point established during composition, usually bottom-center at the feet or base.',
      `Coordinates are normalized Unity coordinates: x from left to right and y from bottom to top${relativeCanvasHeight ? ` on the final ${relativeCanvasHeight}px-high canvas` : ''}. Account for transparent padding; do not blindly return canvas bottom when the contact point is above it.`,
    ].join(' ');
  }
  return aiVerificationEnabled
    ? 'Pivot recommendation: inspect the finished asset and choose its logical runtime anchor. Return normalized Unity coordinates, x left-to-right and y bottom-to-top, accounting for transparent padding.'
    : 'Pivot recommendation: use the logical runtime anchor established during composition. Return normalized Unity coordinates, x left-to-right and y bottom-to-top, accounting for planned transparent padding.';
}

function buildRoadMaterialInstructions(tileWidth: number, tileHeight: number, aiVerificationEnabled = true): string {
  return [
    'Asset type: ROAD SURFACE MATERIAL SOURCE for deterministic isometric geometry.',
    `The application will map this material into exact ${tileWidth}x${tileHeight}px road tiles. Imagegen must create material appearance only; it must not design any road layout.`,
    'Create a close-up, orthographic swatch of the requested road surface material filling the entire rectangular image edge to edge.',
    'Use diffuse, nearly direction-neutral lighting and an even material scale suitable for a strategy-game road viewed from above.',
    'Avoid a dominant focal stone, large unique mark, directional cast shadow, perspective horizon, surrounding terrain, grass, water, roadside props or a scene.',
    'Do not draw a road strip, path, isometric diamond, tile, atlas, grid, corner, T junction, intersection, arrows, labels, guides or checkerboard.',
    'The source must be fully opaque. Do not use transparency, #00ff00/#ff00ff chroma key, background removal or alpha helpers. A request such as "without background" applies to the final derived road overlays, not to this intermediate material swatch.',
    aiVerificationEnabled
      ? 'Inspect that the entire frame is useful road material with no visible layout or background. The application will create and validate all sixteen transparent variants after the turn.'
      : 'The application will create and validate all sixteen transparent variants from this opaque source.',
  ].filter(Boolean).join('\n');
}

function buildTerrainRetryPrompt(
  context: JobContext,
  artBrief: string,
  styleSummary: string,
  tileWidth: number,
  tileHeight: number,
  stagingPath: string,
  verificationFeedback: string,
  projectReferences: ProjectReference[],
  includesSeamPreview: boolean,
): string {
  const elevatedWallHeight = tileHeight * context.elevationLevels;
  const repairGeometry = context.category === 'elevated_tile'
    ? [
      `Repair asset type: ELEVATED TILE, elevation height ${context.elevationLevels}. Do not flatten the candidate.`,
      `Output exactly ${tileWidth}x${tileHeight + elevatedWallHeight}px: a ${tileWidth}x${tileHeight}px top diamond followed by ${elevatedWallHeight}px visible front-left and front-right walls.`,
      `The top diamond bottom vertex remains at y=${tileHeight - 1}; the raised block silhouette must reach the bottom of the canvas.`,
      `Repair the tile for exact copies placed at (±${tileWidth / 2}px, +${tileHeight / 2}px). All top faces must be geometrically identical and meet without gaps, overlaps, steps, bulges, outlines, or exposed wall pixels between equal-height neighbors.`,
      'Repair both transparent gaps and visible color/material seams. Match top-left to bottom-right and top-right to bottom-left edge pixels; remove any dark rim, highlight, bevel, shadow, or edge color shift from the top surface.',
      'Preserve the visible outer wall thickness, wall materials, silhouette, and directional shading.',
      'Do not add cast shadows, contact shadows, padding, a frame, text, watermark, or unrelated props.',
    ].join('\n')
    : [
      `Repair contract: output exactly ${tileWidth}x${tileHeight}px. The flat isometric diamond must touch the canvas at top, right, bottom, and left.`,
      `Repair the tile for exact copies placed at (±${tileWidth / 2}px, +${tileHeight / 2}px). All diamonds must be geometrically identical and meet without gaps, overlaps, steps, or bulges.`,
      'Repair both transparent gaps and visible color/material seams. Match top-left to bottom-right and top-right to bottom-left edge pixels; remove any outline, dark rim, highlight, bevel, shadow, or edge color shift.',
      'Do not add vertical side walls, soil thickness, extrusion, cliff faces, shadows, padding, a frame, text, watermark, or unrelated props.',
    ].join('\n');
  return [
    '$imagegen',
    'Use case: stylized-concept',
    includesSeamPreview
      ? 'Intent: edit the failed terrain candidate in Image 1. Image 2 is the deterministic exact-offset 3x3 repeat that exposes the validation failure; inspect both before editing.'
      : 'Intent: edit the attached failed terrain candidate using the imagegen workflow.',
    `Asset title: ${context.assetName}`,
    context.prompt ? `Original additional request: ${context.prompt}` : '',
    context.feedback ? `Requested user change: ${context.feedback}` : '',
    `Deterministic verifier result: ${verificationFeedback}`,
    `Project art brief: ${artBrief || '(not established)'}`,
    `Canonical approved style summary: ${styleSummary || '(no approved assets yet)'}`,
    formatProjectReferences(projectReferences),
    'Use registry.get_reference for any listed user reference relevant to the repair, while preserving the requested asset identity.',
    'If the failed candidate reveals that project settings themselves must change, use registry.propose_project_settings and return needs_user_decision. Never assume that a proposal was approved during this turn.',
    repairGeometry,
    'Preserve the requested material, palette, texture, lighting, and style; change only geometry and edge pixels needed to make the tile seamless.',
    'Do not hide a seam by overlapping copies, changing grid offsets, adding padding, or scaling the sprite. The final asset itself must pass at the exact project dimensions.',
    'Before returning final.png, build and inspect your own exact 3x3 repeat at 100%. It must read as one continuous surface with equal top diamonds and no visible internal grid.',
    'Follow the imagegen skill transparent-output workflow. Never switch to CLI/API or request OPENAI_API_KEY.',
    `Copy the repaired transparent PNG to exactly ${path.join(stagingPath, 'final.png')}.`,
    buildPivotInstruction(context.category, tileHeight, elevatedWallHeight),
    'Choose pivot only after the repaired final PNG is complete and inspected. Return it in normalized Unity coordinates; the user can override it during final review.',
    'Finish with JSON matching the supplied schema and put that actual PNG path in finalPath.',
    'If the built-in transparent workflow is genuinely unsuitable, return status needs_user_decision instead of using a fallback.',
  ].filter(Boolean).join('\n\n');
}

function buildRoadRetryPrompt(
  context: JobContext,
  artBrief: string,
  styleSummary: string,
  tileWidth: number,
  tileHeight: number,
  stagingPath: string,
  verificationFeedback: string,
  projectReferences: ProjectReference[],
): string {
  return [
    '$imagegen',
    'Use case: stylized-concept',
    'Intent: generate a replacement opaque road-surface material swatch. If Image 1 is attached, it is only a failed derived 4x4 set for style diagnosis; do not reproduce its geometry.',
    `Asset title: ${context.assetName}`,
    context.prompt ? `Original additional request: ${context.prompt}` : '',
    context.feedback ? `Requested user change: ${context.feedback}` : '',
    `Deterministic verifier result: ${verificationFeedback}`,
    `Project art brief: ${artBrief || '(not established)'}`,
    `Canonical approved style summary: ${styleSummary || '(no approved assets yet)'}`,
    formatProjectReferences(projectReferences),
    buildRoadMaterialInstructions(tileWidth, tileHeight),
    'Use one built-in image generation call. Generate a new full-frame material swatch instead of editing or repairing road geometry.',
    `Copy the selected native-resolution opaque image to exactly ${path.join(stagingPath, 'road-material.png')}.`,
    'Do not run transparent-output, chroma-key or alpha-helper workflows. Do not use CLI/API or request OPENAI_API_KEY. The application owns all geometry and transparency.',
    buildPivotInstruction(context.category, tileHeight, 0),
    'The final derived road set uses the fixed center pivot; the user can override it during final review.',
    `Return category exactly as ${context.category}; finish with JSON matching the supplied schema and put ${path.join(stagingPath, 'road-material.png')} in finalPath.`,
    'Do not return needs_user_decision because imagegen lacks native alpha: this intermediate source is intentionally opaque.',
  ].filter(Boolean).join('\n\n');
}

function formatProjectReferences(references: ProjectReference[]): string {
  if (!references.length) return 'Project reference images: none attached.';
  const lines = references.slice(0, 30).map((reference) => (
    `- ${reference.id} | ${reference.name} | ${reference.description.replace(/\s+/g, ' ').trim().slice(0, 500)}`
  ));
  return [
    'Project reference images available through registry.get_reference(referenceId):',
    ...lines,
    references.length > lines.length ? `- …and ${references.length - lines.length} more via registry.list_references.` : '',
  ].filter(Boolean).join('\n');
}

function buildStylePrompt(previous: string, assetName: string, category: AssetCategory, tags: string[]): string {
  return [
    'Zaktualizuj kanoniczne podsumowanie stylu artystycznego po zatwierdzeniu nowego assetu.',
    'Obraz 1 jest nowo zatwierdzonym assetem i może wpływać na summary. Nie opisuj jego fabuły; wyciągnij tylko powtarzalne reguły wizualne.',
    `Asset: ${assetName}; kategoria: ${category}; tagi: ${tags.join(', ') || '(brak)'}.`,
    `Poprzednie summary: ${previous || '(pierwszy zatwierdzony asset)'}`,
    styleSectionsInstruction(),
    'Zwróć wyłącznie JSON zgodny ze schematem.',
  ].join('\n\n');
}

function styleSectionsInstruction(): string {
  return 'Summary ma być zwięzłym Markdownem po polsku z sekcjami: Język wizualny, Perspektywa i geometria, Paleta i światło, Materiały i faktury, Krawędzie i kontury, Reguły spójności, Unikać.';
}

function parseJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}

function generatorProviderLabel(provider: GeneratorProvider | undefined): string {
  if (provider === 'comfyui') return 'ComfyUI';
  if (provider === 'stable_diffusion_cpp') return 'stable-diffusion.cpp';
  return 'Codex';
}

function formatGapRatio(value: number): string {
  return `${(value * 100).toFixed(3).replace('.', ',')}%`;
}

function summarizeTerrainSeamResult(seam: TerrainSeamValidation): string {
  return [
    `Deterministyczny test dokładnego powtórzenia 3×3: ${seam.passed ? 'zaliczony' : 'niezaliczony'}.`,
    `Ciągłość alfa/geometrii: ${seam.gapPixels}/${seam.inspectedPixels} pikseli luk (${formatGapRatio(seam.gapRatio)}).`,
    `Ciągłość koloru i materiału: ${seam.colorSeamPixels}/${seam.colorInspectedPixels} próbek wspólnych krawędzi `
      + `przekracza próg widocznego szwu (${formatGapRatio(seam.colorSeamRatio)}; `
      + `średni wynik ${seam.averageColorSeamScore.toFixed(3)}, maksymalny ${seam.maxColorSeamScore.toFixed(3)}).`,
    'Wymagana korekta: zachowaj dokładny romb 2:1 i bieżący canvas; usuń obrysy, cienie, uskoki oraz zmianę koloru na krawędziach; '
      + 'dopasuj top-left do bottom-right i top-right do bottom-left. Nie maskuj błędu overlapem, paddingiem, skalą ani zmianą offsetu siatki.',
  ].join(' ');
}

function resolveGeneratedFile(
  database: ProjectDatabase,
  stagingPath: string,
  reportedPath: string,
  items: Array<Record<string, unknown>>,
): string {
  const expected = path.join(stagingPath, 'final.png');
  if (existsSync(expected)) return expected;

  const candidates: string[] = [];
  if (reportedPath) candidates.push(path.isAbsolute(reportedPath) ? reportedPath : path.resolve(stagingPath, reportedPath));
  for (const item of items) {
    if (item.type === 'imageGeneration' && typeof item.savedPath === 'string') candidates.push(item.savedPath);
  }
  const stagedPngs = existsSync(stagingPath)
    ? readdirSync(stagingPath).filter((name) => name.toLocaleLowerCase().endsWith('.png'))
      .map((name) => path.join(stagingPath, name)).sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    : [];
  candidates.push(...stagedPngs);

  const projectPrefix = `${database.rootPath}${path.sep}`.toLocaleLowerCase();
  const codexRoot = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images');
  const codexPrefix = `${codexRoot}${path.sep}`.toLocaleLowerCase();
  const source = candidates.find((candidate) => {
    const resolved = path.resolve(candidate);
    const lowered = resolved.toLocaleLowerCase();
    return existsSync(resolved) && (lowered.startsWith(projectPrefix) || lowered.startsWith(codexPrefix));
  });
  if (!source) throw new Error('Generator nie zapisał finalnego PNG w katalogu projektu.');
  copyFileSync(source, expected);
  return expected;
}

function defaultPivot(category: AssetCategory): { x: number; y: number } {
  return isTileAssetCategory(category) || isRoadAssetCategory(category)
    ? { x: 0.5, y: 0.5 }
    : { x: 0.5, y: 0 };
}
