import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import sharp from 'sharp';
import {
  characterAnimationFrameSize,
  characterAnimationSettingsSchema,
  characterAnimationSheetSize,
  characterDirectionSchema,
  characterDirectionsForProjection,
  defaultAssetSizing,
  defaultCharacterAnimationSettings,
  exportIntegrationSchema,
  generatorProviderSchema,
  generatorProviderSelectionSchema,
  isRoadAssetCategory,
  isTileAssetCategory,
  projectProjectionSchema,
  tileHeightForProjection,
} from '../../shared/domain';
import type {
  AiVerificationStatus,
  AssetCategory,
  AssetDetail,
  AssetSummary,
  AssetVersion,
  CharacterAnimationSet,
  CharacterAnimationSettings,
  CharacterMovementAnalysis,
  CharacterMovementDirectionAnalysis,
  CreateProjectSettingsProposalInput,
  CreateProjectInput,
  EnqueueGenerationInput,
  ExportIntegration,
  GenerationJob,
  GenerationLogEntry,
  GenerationLogLevel,
  GenerationStage,
  GeneratorProvider,
  ProjectInfo,
  ProjectReference,
  ProjectSettingsProposal,
  ProjectSettingsSnapshot,
  RoadVariant,
  ReviewVersionInput,
  StyleSummaryRevision,
  UpdateProjectSettingsInput,
  VersionStatus,
} from '../../shared/domain';
import * as schema from './schema';

const MANIFEST_NAME = 'tilemap-project.json';
const DATABASE_NAME = 'registry.sqlite';
const SCHEMA_VERSION = 18;

type Row = Record<string, unknown>;

export interface JobContext {
  jobId: string;
  versionId: string;
  assetId: string;
  assetName: string;
  assetThreadId: string | null;
  parentVersionId: string | null;
  parentFinalPath: string | null;
  mode: 'generate' | 'edit' | 'variant';
  generatorProvider: GeneratorProvider;
  prompt: string;
  feedback: string;
  category: AssetCategory;
  elevationLevels: number;
  relativeWidth: number;
  relativeHeight: number;
  footprint: { x: number; y: number };
  characterAnimation: CharacterAnimationSettings | null;
}

export interface GeneratedVersionData {
  finalPath: string;
  sourcePath?: string;
  width: number;
  height: number;
  category: AssetCategory;
  tags: string[];
  pivot: { x: number; y: number };
  description: string;
  aiVerificationStatus?: AiVerificationStatus;
  aiVerificationMessage?: string;
  codexTurnId?: string;
  generatorProvider?: GeneratorProvider;
  generatorModel?: string;
  generatorWorkflowHash?: string;
  providerRunId?: string;
  generationMetadata?: Record<string, unknown>;
  roadVariants?: Array<Omit<RoadVariant, 'imageUrl'>>;
  characterAnimation?: CharacterAnimationSet;
}

export interface AiVerificationContext {
  jobId: string;
  versionId: string;
  assetId: string;
  assetName: string;
  assetThreadId: string | null;
  category: AssetCategory;
  prompt: string;
  feedback: string;
  finalPath: string;
  status: VersionStatus;
  aiVerificationStatus: AiVerificationStatus;
}

export class ProjectDatabase {
  readonly rootPath: string;
  readonly sqlite: Database.Database;
  readonly orm: BetterSQLite3Database<typeof schema>;

  static create(rootPath: string, input: CreateProjectInput): ProjectDatabase {
    const projection = projectProjectionSchema.parse(input.projection ?? 'isometric');
    if (projection === 'isometric' && input.tileWidthPx % 2 !== 0) {
      throw new Error('Bazowa szerokość izometrycznego tile musi być parzysta.');
    }
    const tileHeightPx = tileHeightForProjection(projection, input.tileWidthPx);
    mkdirSync(rootPath, { recursive: true });
    for (const directory of ['assets', 'staging', 'references', 'backups']) {
      mkdirSync(path.join(rootPath, directory), { recursive: true });
    }

    const projectId = randomUUID();
    const now = new Date().toISOString();
    writeFileSync(path.join(rootPath, MANIFEST_NAME), JSON.stringify({
      schemaVersion: 1,
      id: projectId,
      name: input.name,
      projection,
      database: DATABASE_NAME,
    }, null, 2), 'utf8');

    const database = new ProjectDatabase(rootPath);
    database.sqlite.prepare(`
      INSERT INTO projects (
        id, name, art_brief, projection, tile_width_px, tile_height_px,
        pixels_per_unit, style_summary_stale, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      projectId,
      input.name,
      input.artBrief,
      projection,
      input.tileWidthPx,
      tileHeightPx,
      input.pixelsPerUnit ?? input.tileWidthPx,
      now,
      now,
    );
    return database;
  }

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
    const manifestPath = path.join(this.rootPath, MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
      throw new Error(`Brak ${MANIFEST_NAME} w wybranym katalogu.`);
    }
    JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    mkdirSync(path.join(this.rootPath, 'references'), { recursive: true });

    const databasePath = path.join(this.rootPath, DATABASE_NAME);
    this.sqlite = new Database(databasePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.migrate(databasePath);
    this.orm = drizzle(this.sqlite, { schema });
    this.markInterruptedJobs();
    this.backfillReviewLogs();
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(databasePath: string): void {
    const version = Number(this.sqlite.pragma('user_version', { simple: true }));
    if (version > SCHEMA_VERSION) {
      throw new Error(`Baza projektu ma nowszy schemat (${version}) niż aplikacja (${SCHEMA_VERSION}).`);
    }
    if (version > 0 && version < SCHEMA_VERSION) {
      mkdirSync(path.join(this.rootPath, 'backups'), { recursive: true });
      copyFileSync(databasePath, path.join(this.rootPath, 'backups', `registry-v${version}-${Date.now()}.sqlite`));
    }

    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, art_brief TEXT NOT NULL DEFAULT '',
          projection TEXT NOT NULL DEFAULT 'isometric', tile_width_px INTEGER NOT NULL,
           tile_height_px INTEGER NOT NULL, pixels_per_unit INTEGER NOT NULL,
           max_concurrent_jobs INTEGER NOT NULL DEFAULT 1,
           ai_verification_enabled INTEGER NOT NULL DEFAULT 1,
           codex_generation_enabled INTEGER NOT NULL DEFAULT 1,
           comfyui_enabled INTEGER NOT NULL DEFAULT 0,
           comfyui_profile TEXT NOT NULL DEFAULT 'z_image_turbo',
           stable_diffusion_cpp_enabled INTEGER NOT NULL DEFAULT 0,
           active_style_summary_id TEXT, style_summary_stale INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assets (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT 'other', elevation_levels INTEGER NOT NULL DEFAULT 0,
          relative_width REAL NOT NULL DEFAULT 1, relative_height REAL NOT NULL DEFAULT 1,
          road_connections INTEGER NOT NULL DEFAULT 0,
          current_approved_version_id TEXT,
          codex_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_versions (
          id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          parent_version_id TEXT, mode TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL,
          feedback TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'other',
          elevation_levels INTEGER NOT NULL DEFAULT 0, relative_width REAL NOT NULL DEFAULT 1,
          relative_height REAL NOT NULL DEFAULT 1, road_connections INTEGER NOT NULL DEFAULT 0,
          final_path TEXT,
          source_path TEXT, width INTEGER, height INTEGER, footprint_x INTEGER NOT NULL DEFAULT 1,
          footprint_y INTEGER NOT NULL DEFAULT 1, pivot_x REAL NOT NULL DEFAULT 0.5,
           pivot_y REAL NOT NULL DEFAULT 0, ai_description TEXT NOT NULL DEFAULT '',
           ai_verification_status TEXT NOT NULL DEFAULT 'passed',
           ai_verification_message TEXT NOT NULL DEFAULT '',
           generator_provider TEXT NOT NULL DEFAULT 'codex',
           generator_model TEXT NOT NULL DEFAULT '',
           generator_workflow_hash TEXT NOT NULL DEFAULT '',
           provider_run_id TEXT NOT NULL DEFAULT '',
           generation_metadata_json TEXT NOT NULL DEFAULT '{}',
           rejection_reason TEXT NOT NULL DEFAULT '', codex_turn_id TEXT,
          error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS road_variants (
          version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
          connection_mask INTEGER NOT NULL, final_path TEXT NOT NULL,
          width INTEGER NOT NULL, height INTEGER NOT NULL,
          PRIMARY KEY(version_id, connection_mask)
        );
        CREATE TABLE IF NOT EXISTS character_animation_sets (
          version_id TEXT PRIMARY KEY REFERENCES asset_versions(id) ON DELETE CASCADE,
          action TEXT NOT NULL DEFAULT 'walk',
          frames_per_direction INTEGER NOT NULL DEFAULT 4,
          frames_per_second INTEGER NOT NULL DEFAULT 8,
          frame_width INTEGER NOT NULL,
          frame_height INTEGER NOT NULL,
          analysis_status TEXT NOT NULL DEFAULT 'pending',
          analysis_summary TEXT NOT NULL DEFAULT '',
          analysis_json TEXT NOT NULL DEFAULT '[]',
          analysis_turn_id TEXT,
          analyzed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_asset_versions_asset ON asset_versions(asset_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS generation_jobs (
           id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
           version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
           generator_provider TEXT NOT NULL DEFAULT 'codex',
           status TEXT NOT NULL, progress TEXT NOT NULL DEFAULT 'Oczekuje w kolejce',
          error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          started_at TEXT, completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_generation_jobs_status ON generation_jobs(status, created_at);
        CREATE TABLE IF NOT EXISTS generation_artifacts (
          id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
          role TEXT NOT NULL, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS generation_job_logs (
          id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
          stage TEXT NOT NULL, level TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
          message TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_generation_job_logs_job ON generation_job_logs(job_id, created_at, id);
        CREATE TABLE IF NOT EXISTS project_references (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
          relative_path TEXT NOT NULL, mime_type TEXT NOT NULL,
          width INTEGER NOT NULL, height INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_settings_proposals (
          id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL,
          before_json TEXT NOT NULL, proposed_json TEXT NOT NULL,
          reference_ids_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, decided_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_project_settings_proposals_status
          ON project_settings_proposals(status, created_at DESC);
        CREATE TABLE IF NOT EXISTS tags (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_version_tags (
          version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
          tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY(version_id, tag_id)
        );
        CREATE TABLE IF NOT EXISTS style_summary_revisions (
          id TEXT PRIMARY KEY, summary TEXT NOT NULL, previous_id TEXT,
          based_on_version_id TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS export_targets (
          integration TEXT PRIMARY KEY, target_path TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS export_records (
          id TEXT PRIMARY KEY, integration TEXT NOT NULL DEFAULT 'unity',
          target_path TEXT NOT NULL, manifest_path TEXT NOT NULL,
          asset_count INTEGER NOT NULL, created_at TEXT NOT NULL
        );
      `);
      const logColumns = this.sqlite.pragma('table_info(generation_job_logs)') as Array<{ name: string }>;
      if (!logColumns.some((column) => column.name === 'details_json')) {
        this.sqlite.exec("ALTER TABLE generation_job_logs ADD COLUMN details_json TEXT NOT NULL DEFAULT '';");
      }
      const projectColumns = this.sqlite.pragma('table_info(projects)') as Array<{ name: string }>;
      if (!projectColumns.some((column) => column.name === 'max_concurrent_jobs')) {
        this.sqlite.exec('ALTER TABLE projects ADD COLUMN max_concurrent_jobs INTEGER NOT NULL DEFAULT 1;');
      }
      if (!projectColumns.some((column) => column.name === 'ai_verification_enabled')) {
        this.sqlite.exec('ALTER TABLE projects ADD COLUMN ai_verification_enabled INTEGER NOT NULL DEFAULT 1;');
      }
      if (!projectColumns.some((column) => column.name === 'codex_generation_enabled')) {
        this.sqlite.exec('ALTER TABLE projects ADD COLUMN codex_generation_enabled INTEGER NOT NULL DEFAULT 1;');
      }
      if (!projectColumns.some((column) => column.name === 'comfyui_enabled')) {
        this.sqlite.exec('ALTER TABLE projects ADD COLUMN comfyui_enabled INTEGER NOT NULL DEFAULT 0;');
      }
      if (!projectColumns.some((column) => column.name === 'comfyui_profile')) {
        this.sqlite.exec("ALTER TABLE projects ADD COLUMN comfyui_profile TEXT NOT NULL DEFAULT 'z_image_turbo';");
      }
      if (!projectColumns.some((column) => column.name === 'stable_diffusion_cpp_enabled')) {
        this.sqlite.exec('ALTER TABLE projects ADD COLUMN stable_diffusion_cpp_enabled INTEGER NOT NULL DEFAULT 0;');
      }
      const assetColumns = this.sqlite.pragma('table_info(assets)') as Array<{ name: string }>;
      const versionColumns = this.sqlite.pragma('table_info(asset_versions)') as Array<{ name: string }>;
      if (!versionColumns.some((column) => column.name === 'ai_verification_status')) {
        this.sqlite.exec("ALTER TABLE asset_versions ADD COLUMN ai_verification_status TEXT NOT NULL DEFAULT 'passed';");
      }
      if (!versionColumns.some((column) => column.name === 'ai_verification_message')) {
        this.sqlite.exec("ALTER TABLE asset_versions ADD COLUMN ai_verification_message TEXT NOT NULL DEFAULT '';");
      }
      for (const [column, definition] of [
        ['generator_provider', "TEXT NOT NULL DEFAULT 'codex'"],
        ['generator_model', "TEXT NOT NULL DEFAULT ''"],
        ['generator_workflow_hash', "TEXT NOT NULL DEFAULT ''"],
        ['provider_run_id', "TEXT NOT NULL DEFAULT ''"],
        ['generation_metadata_json', "TEXT NOT NULL DEFAULT '{}'"],
      ] as const) {
        if (!versionColumns.some((candidate) => candidate.name === column)) {
          this.sqlite.exec(`ALTER TABLE asset_versions ADD COLUMN ${column} ${definition};`);
        }
      }
      const jobColumns = this.sqlite.pragma('table_info(generation_jobs)') as Array<{ name: string }>;
      if (!jobColumns.some((column) => column.name === 'generator_provider')) {
        this.sqlite.exec("ALTER TABLE generation_jobs ADD COLUMN generator_provider TEXT NOT NULL DEFAULT 'codex';");
      }
      const exportRecordColumns = this.sqlite.pragma('table_info(export_records)') as Array<{ name: string }>;
      if (!exportRecordColumns.some((column) => column.name === 'integration')) {
        this.sqlite.exec("ALTER TABLE export_records ADD COLUMN integration TEXT NOT NULL DEFAULT 'unity';");
      }
      const assetHadGeometry = assetColumns.some((column) => column.name === 'terrain_geometry');
      const versionHadGeometry = versionColumns.some((column) => column.name === 'terrain_geometry');
      const projectHadGeometry = projectColumns.some((column) => column.name === 'terrain_geometry');
      for (const [table, columns] of [['assets', assetColumns], ['asset_versions', versionColumns]] as const) {
        if (!columns.some((column) => column.name === 'elevation_levels')) {
          this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN elevation_levels INTEGER NOT NULL DEFAULT 0;`);
        }
        if (!columns.some((column) => column.name === 'relative_width')) {
          this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN relative_width REAL NOT NULL DEFAULT 1;`);
        }
        if (!columns.some((column) => column.name === 'relative_height')) {
          this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN relative_height REAL NOT NULL DEFAULT 1;`);
        }
        if (!columns.some((column) => column.name === 'road_connections')) {
          this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN road_connections INTEGER NOT NULL DEFAULT 0;`);
        }
      }
      if (version < 9) {
        const assetGeometry = assetHadGeometry
          ? 'terrain_geometry'
          : projectHadGeometry ? "COALESCE((SELECT terrain_geometry FROM projects LIMIT 1), 'flat')" : "'flat'";
        const versionGeometry = versionHadGeometry
          ? 'terrain_geometry'
          : "CASE WHEN (SELECT category FROM assets WHERE assets.id = asset_versions.asset_id) = 'elevated_tile' THEN 'elevated' ELSE 'flat' END";
        this.sqlite.exec(`
          UPDATE projects SET tile_height_px = CAST(tile_width_px / 2 AS INTEGER);
          UPDATE assets SET category = CASE WHEN category = 'terrain'
            THEN CASE WHEN ${assetGeometry} = 'elevated' THEN 'elevated_tile' ELSE 'flat_tile' END
            ELSE category END;
          UPDATE asset_versions SET category = CASE WHEN category = 'terrain'
            THEN CASE WHEN ${versionGeometry} = 'elevated' THEN 'elevated_tile' ELSE 'flat_tile' END
            ELSE category END;
          UPDATE assets SET
            elevation_levels = CASE WHEN category = 'elevated_tile' THEN 1 ELSE 0 END,
            relative_width = CASE WHEN category = 'character' THEN 0.5 ELSE 1 END,
            relative_height = CASE WHEN category = 'building' THEN 2 WHEN category = 'character' THEN 1.5 ELSE 1 END;
          UPDATE asset_versions SET
            elevation_levels = CASE WHEN category = 'elevated_tile' THEN 1 ELSE 0 END,
            relative_width = CASE WHEN category = 'character' THEN 0.5 ELSE 1 END,
            relative_height = CASE WHEN category = 'building' THEN 2 WHEN category = 'character' THEN 1.5 ELSE 1 END;
        `);
      }
      if (version < 11) {
        this.sqlite.exec(`
          INSERT OR IGNORE INTO road_variants (version_id, connection_mask, final_path, width, height)
          SELECT id, road_connections, final_path, width, height
          FROM asset_versions
          WHERE category = 'road_tile' AND final_path IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL;
        `);
      }
      if (version < 6) {
        this.sqlite.exec(`
          UPDATE asset_versions
          SET status = 'needs_review'
          WHERE status = 'approved'
            AND id <> COALESCE((
              SELECT current_approved_version_id FROM assets WHERE assets.id = asset_versions.asset_id
            ), '');
          UPDATE assets
          SET current_approved_version_id = NULL
          WHERE current_approved_version_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM asset_versions
              WHERE asset_versions.id = assets.current_approved_version_id
                AND asset_versions.asset_id = assets.id
                AND asset_versions.status = 'approved'
            );
        `);
      }
      this.sqlite.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_versions_one_approved_per_asset
        ON asset_versions(asset_id) WHERE status = 'approved';
      `);
      this.sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

  private markInterruptedJobs(): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE generation_jobs SET status = 'interrupted', progress = 'Przerwane przez zamknięcie aplikacji',
      error = 'Proces aplikacji zakończył się podczas generacji.', updated_at = ?, completed_at = ?
      WHERE status = 'generating'
    `).run(now, now);
    this.sqlite.prepare(`
      UPDATE asset_versions SET status = 'interrupted', error = 'Generacja została przerwana.', updated_at = ?
      WHERE status = 'generating'
    `).run(now);
  }

  private backfillReviewLogs(): void {
    const rows = this.sqlite.prepare(`
      SELECT v.rejection_reason, v.updated_at, j.id AS job_id
      FROM asset_versions v
      JOIN generation_jobs j ON j.version_id = v.id
      WHERE v.status = 'rejected'
        AND NOT EXISTS (
          SELECT 1 FROM generation_job_logs l WHERE l.job_id = j.id AND l.stage = 'review'
        )
    `).all() as Row[];
    for (const row of rows) {
      const reason = String(row.rejection_reason || '').trim();
      this.addGenerationLog(
        String(row.job_id),
        'review',
        'warning',
        0,
        `Odrzucono wersję. Powód: ${reason || 'nie podano powodu'}.`,
        null,
        String(row.updated_at),
      );
    }
  }

  getProject(): ProjectInfo {
    const row = this.sqlite.prepare(`
      SELECT p.*, COALESCE(s.summary, '') AS style_summary
      FROM projects p LEFT JOIN style_summary_revisions s ON s.id = p.active_style_summary_id LIMIT 1
    `).get() as Row | undefined;
    if (!row) throw new Error('Projekt nie zawiera rekordu konfiguracyjnego.');
    const exportTargets = (this.sqlite.prepare(`
      SELECT integration, target_path FROM export_targets ORDER BY integration
    `).all() as Row[]).reduce<Partial<Record<ExportIntegration, string>>>((result, target) => {
      const integration = exportIntegrationSchema.parse(target.integration);
      result[integration] = String(target.target_path);
      return result;
    }, {});
    return {
      id: String(row.id), rootPath: this.rootPath, name: String(row.name),
      artBrief: String(row.art_brief), projection: projectProjectionSchema.parse(row.projection),
      tileWidthPx: Number(row.tile_width_px), tileHeightPx: Number(row.tile_height_px),
      pixelsPerUnit: Number(row.pixels_per_unit),
      maxConcurrentJobs: Number(row.max_concurrent_jobs),
      aiVerificationEnabled: Boolean(row.ai_verification_enabled),
      codexGenerationEnabled: Boolean(row.codex_generation_enabled),
      comfyUiEnabled: Boolean(row.comfyui_enabled),
      comfyUiProfile: String(row.comfyui_profile) as ProjectInfo['comfyUiProfile'],
      stableDiffusionCppEnabled: Boolean(row.stable_diffusion_cpp_enabled),
      styleSummary: String(row.style_summary),
      styleSummaryStale: Boolean(row.style_summary_stale),
      exportTargets,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  updateProjectSettings(input: UpdateProjectSettingsInput): ProjectInfo {
    const current = this.getProject();
    const now = new Date().toISOString();
    const styleSummaryStale = current.styleSummaryStale || current.artBrief !== input.artBrief;
    if (current.projection === 'isometric' && input.tileWidthPx % 2 !== 0) {
      throw new Error('Bazowa szerokość izometrycznego tile musi być parzysta.');
    }
    const tileHeightPx = tileHeightForProjection(current.projection, input.tileWidthPx);
    this.sqlite.prepare(`
      UPDATE projects SET name = ?, art_brief = ?, tile_width_px = ?, tile_height_px = ?,
        pixels_per_unit = ?, max_concurrent_jobs = ?, ai_verification_enabled = ?,
        codex_generation_enabled = ?, comfyui_enabled = ?, comfyui_profile = ?,
        stable_diffusion_cpp_enabled = ?,
        style_summary_stale = ?, updated_at = ? WHERE id = ?
    `).run(
      input.name,
      input.artBrief,
      input.tileWidthPx,
      tileHeightPx,
      input.pixelsPerUnit,
      input.maxConcurrentJobs,
      input.aiVerificationEnabled ? 1 : 0,
      (input.codexGenerationEnabled ?? current.codexGenerationEnabled) ? 1 : 0,
      (input.comfyUiEnabled ?? current.comfyUiEnabled) ? 1 : 0,
      input.comfyUiProfile ?? current.comfyUiProfile,
      (input.stableDiffusionCppEnabled ?? current.stableDiffusionCppEnabled) ? 1 : 0,
      styleSummaryStale ? 1 : 0,
      now,
      current.id,
    );
    const manifestPath = path.join(this.rootPath, MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, name: input.name }, null, 2), 'utf8');
    return this.getProject();
  }

  setNewAssetGeneratorProviders(providers: readonly GeneratorProvider[]): ProjectInfo {
    const selected = generatorProviderSelectionSchema.parse(providers);
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE projects SET codex_generation_enabled = ?, comfyui_enabled = ?,
        stable_diffusion_cpp_enabled = ?, updated_at = ?
    `).run(
      selected.includes('codex') ? 1 : 0,
      selected.includes('comfyui') ? 1 : 0,
      selected.includes('stable_diffusion_cpp') ? 1 : 0,
      now,
    );
    return this.getProject();
  }

  generatorProviderForIteration(assetId: string, parentVersionId?: string): GeneratorProvider {
    const row = parentVersionId
      ? this.sqlite.prepare(`
          SELECT generator_provider FROM asset_versions WHERE id = ? AND asset_id = ?
        `).get(parentVersionId, assetId) as Row | undefined
      : this.sqlite.prepare(`
          SELECT generator_provider FROM asset_versions WHERE asset_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get(assetId) as Row | undefined;
    if (!row) {
      throw new Error(parentVersionId
        ? 'Wersja bazowa nie należy do wybranego assetu.'
        : 'Asset nie ma wersji, z której można odziedziczyć generator.');
    }
    return generatorProviderSchema.parse(row.generator_provider);
  }

  enqueueNewAssetGenerations(
    input: EnqueueGenerationInput,
    providers: readonly GeneratorProvider[],
    rememberSelection: boolean,
  ): GenerationJob[] {
    if (input.assetId) throw new Error('Fan-out generatorów jest dozwolony tylko dla nowego assetu.');
    if (input.generatorProvider) {
      throw new Error('Fan-out generatorów nie może zawierać pojedynczego generatora.');
    }
    const selected = generatorProviderSelectionSchema.parse(providers);
    return this.sqlite.transaction(() => {
      const jobs: GenerationJob[] = [];
      let assetId: string | undefined;
      for (const generatorProvider of selected) {
        const job = this.enqueueGeneration({
          ...input,
          assetId,
          generatorProvider,
          generatorProviders: undefined,
        });
        jobs.push(job);
        assetId ??= job.assetId;
      }
      if (rememberSelection) this.setNewAssetGeneratorProviders(selected);
      return jobs;
    })();
  }

  enqueueGeneration(input: EnqueueGenerationInput): GenerationJob {
    const now = new Date().toISOString();
    const assetId = input.assetId ?? randomUUID();
    const versionId = randomUUID();
    const jobId = randomUUID();
    const generatorProvider = input.generatorProvider ?? 'codex';
    const existingAsset = input.assetId
      ? this.sqlite.prepare(`
          SELECT category, elevation_levels, relative_width, relative_height, road_connections
          FROM assets WHERE id = ?
        `).get(assetId) as Row | undefined
      : undefined;
    if (input.assetId && !existingAsset) throw new Error('Nie znaleziono assetu dla iteracji.');
    const category = input.category ?? (existingAsset ? String(existingAsset.category) as AssetCategory : 'other');
    const project = this.getProject();
    if (project.projection === 'top_down' && category === 'elevated_tile') {
      throw new Error('Elevated tile nie jest obsługiwany w projekcie top-down.');
    }
    if (input.characterAnimation && category !== 'character') {
      throw new Error('Ustawienia animacji postaci są dozwolone tylko dla kategorii character.');
    }
    if ((isTileAssetCategory(category) || isRoadAssetCategory(category))
      && (input.footprint.x !== 1 || input.footprint.y !== 1)) {
      throw new Error('Terrain tile i road tile muszą zachować footprint 1×1.');
    }
    const defaults = defaultAssetSizing(category);
    const preserveSizing = existingAsset && String(existingAsset.category) === category;
    const elevationLevels = category === 'elevated_tile'
      ? input.elevationLevels ?? (preserveSizing ? Number(existingAsset.elevation_levels) : defaults.elevationLevels)
      : 0;
    const relativeWidth = category === 'building' || category === 'character'
      ? input.relativeWidth ?? (preserveSizing ? Number(existingAsset.relative_width) : defaults.relativeWidth)
      : 1;
    const relativeHeight = category === 'building' || category === 'character'
      ? input.relativeHeight ?? (preserveSizing ? Number(existingAsset.relative_height) : defaults.relativeHeight)
      : 1;
    let characterAnimation: CharacterAnimationSettings | null = null;
    let characterFrameSize: { width: number; height: number } | null = null;
    if (category === 'character') {
      const previousAnimation = preserveSizing && input.assetId
        ? this.characterAnimationSettingsForIteration(input.assetId, input.parentVersionId)
        : null;
      characterAnimation = characterAnimationSettingsSchema.parse(
        input.characterAnimation ?? previousAnimation ?? defaultCharacterAnimationSettings,
      );
      characterFrameSize = characterAnimationFrameSize(project, { relativeWidth, relativeHeight });
    }
    const roadConnections = category === 'road_tile' ? 15 : 0;
    // The queued version needs a database value, but the asset worker replaces it
    // with a recommendation derived from the final PNG before review starts.
    const tileType = category === 'flat_tile' || category === 'elevated_tile' || category === 'road_tile';
    const provisionalPivot = tileType ? { x: 0.5, y: 0.5 } : { x: 0.5, y: 0 };

    this.sqlite.transaction(() => {
      if (!input.assetId) {
        this.sqlite.prepare(`
          INSERT INTO assets (
            id, name, category, elevation_levels, relative_width, relative_height,
            road_connections, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(assetId, input.name, category, elevationLevels, relativeWidth, relativeHeight, roadConnections, now, now);
      } else {
        this.sqlite.prepare(`
          UPDATE assets SET category = ?, elevation_levels = ?, relative_width = ?, relative_height = ?,
            road_connections = ?, updated_at = ? WHERE id = ?
        `).run(category, elevationLevels, relativeWidth, relativeHeight, roadConnections, now, assetId);
      }
      if (input.parentVersionId) {
        const parent = this.sqlite.prepare('SELECT id FROM asset_versions WHERE id = ? AND asset_id = ?')
          .get(input.parentVersionId, assetId);
        if (!parent) throw new Error('Wersja bazowa nie należy do wybranego assetu.');
      }
      this.sqlite.prepare(`
        INSERT INTO asset_versions (
          id, asset_id, parent_version_id, mode, status, prompt, feedback, category,
          elevation_levels, relative_width, relative_height, road_connections,
          footprint_x, footprint_y, pivot_x, pivot_y, ai_verification_status,
          generator_provider, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId, assetId, input.parentVersionId ?? null, input.mode, input.prompt,
        input.feedback ?? '', category, elevationLevels, relativeWidth, relativeHeight, roadConnections,
        input.footprint.x, input.footprint.y,
        provisionalPivot.x, provisionalPivot.y,
        category === 'character' ? 'pending' : 'passed',
        generatorProvider, now, now,
      );
      if (characterAnimation && characterFrameSize) {
        this.sqlite.prepare(`
          INSERT INTO character_animation_sets (
            version_id, action, frames_per_direction, frames_per_second,
            frame_width, frame_height, analysis_status, analysis_summary, analysis_json
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '', '[]')
        `).run(
          versionId,
          characterAnimation.action,
          characterAnimation.framesPerDirection,
          characterAnimation.framesPerSecond,
          characterFrameSize.width,
          characterFrameSize.height,
        );
      }
      this.sqlite.prepare(`
        INSERT INTO generation_jobs (
          id, asset_id, version_id, generator_provider, status, progress, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', 'Oczekuje w kolejce', ?, ?)
      `).run(jobId, assetId, versionId, generatorProvider, now, now);
    })();
    return this.getJob(jobId)!;
  }

  listJobs(): GenerationJob[] {
    return (this.sqlite.prepare('SELECT * FROM generation_jobs ORDER BY created_at DESC').all() as Row[])
      .map(mapJob);
  }

  getJob(id: string): GenerationJob | null {
    const row = this.sqlite.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? mapJob(row) : null;
  }

  nextQueuedJob(excludedAssetIds: ReadonlySet<string> = new Set()): GenerationJob | null {
    const excluded = [...excludedAssetIds];
    const assetFilter = excluded.length
      ? ` AND asset_id NOT IN (${excluded.map(() => '?').join(', ')})`
      : '';
    const row = this.sqlite.prepare(`
      SELECT * FROM generation_jobs WHERE status = 'queued'${assetFilter} ORDER BY created_at LIMIT 1
    `).get(...excluded) as Row | undefined;
    return row ? mapJob(row) : null;
  }

  getJobContext(jobId: string): JobContext {
    const row = this.sqlite.prepare(`
      SELECT j.id AS job_id, v.*, a.name AS asset_name, a.codex_thread_id AS asset_thread_id,
             parent.final_path AS parent_final_path
      FROM generation_jobs j
      JOIN asset_versions v ON v.id = j.version_id
      JOIN assets a ON a.id = j.asset_id
      LEFT JOIN asset_versions parent ON parent.id = v.parent_version_id
      WHERE j.id = ?
    `).get(jobId) as Row | undefined;
    if (!row) throw new Error('Nie znaleziono zadania generacji.');
    const category = String(row.category) as AssetCategory;
    return {
      jobId: String(row.job_id), versionId: String(row.id), assetId: String(row.asset_id),
      assetName: String(row.asset_name), assetThreadId: row.asset_thread_id ? String(row.asset_thread_id) : null,
      parentVersionId: row.parent_version_id ? String(row.parent_version_id) : null,
      parentFinalPath: row.parent_final_path ? String(row.parent_final_path) : null,
      mode: String(row.mode) as JobContext['mode'], prompt: String(row.prompt), feedback: String(row.feedback),
      generatorProvider: String(row.generator_provider) as GeneratorProvider,
      category,
      elevationLevels: Number(row.elevation_levels),
      relativeWidth: Number(row.relative_width),
      relativeHeight: Number(row.relative_height),
      footprint: { x: Number(row.footprint_x), y: Number(row.footprint_y) },
      characterAnimation: category === 'character'
        ? this.characterAnimationSettingsForIteration(String(row.asset_id), String(row.id))
        : null,
    };
  }

  updateJob(jobId: string, status: VersionStatus, progress: string, error = ''): void {
    const now = new Date().toISOString();
    const start = status === 'generating' ? now : null;
    const completed = ['needs_review', 'failed', 'cancelled', 'interrupted'].includes(status) ? now : null;
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE generation_jobs SET status = ?, progress = ?, error = ?, updated_at = ?,
          started_at = COALESCE(started_at, ?), completed_at = COALESCE(?, completed_at) WHERE id = ?
      `).run(status, progress, error, now, start, completed, jobId);
      this.sqlite.prepare(`
        UPDATE asset_versions SET status = ?, error = ?, updated_at = ?
        WHERE id = (SELECT version_id FROM generation_jobs WHERE id = ?)
      `).run(status, error, now, jobId);
    })();
  }

  finalizeGeneration(jobId: string, data: GeneratedVersionData): void {
    const context = this.getJobContext(jobId);
    const characterAnimation = this.validateCharacterAnimationForFinalization(context, data);
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE asset_versions SET status = 'needs_review', final_path = ?, source_path = ?,
          width = ?, height = ?, pivot_x = ?, pivot_y = ?, ai_description = ?, codex_turn_id = ?,
          ai_verification_status = ?, ai_verification_message = ?, generator_provider = ?,
          generator_model = ?, generator_workflow_hash = ?, provider_run_id = ?,
          generation_metadata_json = ?, error = '', updated_at = ? WHERE id = ?
      `).run(
        data.finalPath, data.sourcePath ?? null, data.width, data.height,
        data.pivot.x, data.pivot.y, data.description, data.codexTurnId ?? null,
        data.aiVerificationStatus ?? 'passed', data.aiVerificationMessage ?? '', data.generatorProvider ?? context.generatorProvider,
        data.generatorModel ?? '', data.generatorWorkflowHash ?? '', data.providerRunId ?? '',
        JSON.stringify(data.generationMetadata ?? {}), now, context.versionId,
      );
      this.replaceTags(context.versionId, data.tags);
      this.sqlite.prepare('DELETE FROM road_variants WHERE version_id = ?').run(context.versionId);
      for (const variant of data.roadVariants ?? []) {
        this.sqlite.prepare(`
          INSERT INTO road_variants (version_id, connection_mask, final_path, width, height)
          VALUES (?, ?, ?, ?, ?)
        `).run(context.versionId, variant.connectionMask, variant.finalPath, variant.width, variant.height);
      }
      if (characterAnimation) {
        this.sqlite.prepare(`
          INSERT INTO character_animation_sets (
            version_id, action, frames_per_direction, frames_per_second,
            frame_width, frame_height, analysis_status, analysis_summary,
            analysis_json, analysis_turn_id, analyzed_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'passed', ?, ?, ?, ?)
          ON CONFLICT(version_id) DO UPDATE SET
            action = excluded.action,
            frames_per_direction = excluded.frames_per_direction,
            frames_per_second = excluded.frames_per_second,
            frame_width = excluded.frame_width,
            frame_height = excluded.frame_height,
            analysis_status = excluded.analysis_status,
            analysis_summary = excluded.analysis_summary,
            analysis_json = excluded.analysis_json,
            analysis_turn_id = excluded.analysis_turn_id,
            analyzed_at = excluded.analyzed_at
        `).run(
          context.versionId,
          characterAnimation.settings.action,
          characterAnimation.settings.framesPerDirection,
          characterAnimation.settings.framesPerSecond,
          characterAnimation.frameSize.width,
          characterAnimation.frameSize.height,
          characterAnimation.movementAnalysis.summary,
          JSON.stringify(characterAnimation.movementAnalysis.directions),
          characterAnimation.movementAnalysis.turnId,
          characterAnimation.movementAnalysis.analyzedAt,
        );
      }
      this.sqlite.prepare(`
        UPDATE assets SET description = ?, updated_at = ? WHERE id = ?
      `).run(data.description, now, context.assetId);
      this.sqlite.prepare(`
        UPDATE generation_jobs SET status = 'needs_review', progress = 'Gotowe do weryfikacji',
          error = '', updated_at = ?, completed_at = ? WHERE id = ?
      `).run(now, now, jobId);
    })();
  }

  validateGenerationFinalization(jobId: string, data: GeneratedVersionData): void {
    const context = this.getJobContext(jobId);
    this.validateCharacterAnimationForFinalization(context, data);
  }

  recordRejectedCharacterMovementAnalysis(
    versionId: string,
    analysis: CharacterMovementAnalysis,
  ): void {
    const version = this.sqlite.prepare(`
      SELECT category FROM asset_versions WHERE id = ?
    `).get(versionId) as Row | undefined;
    if (!version || String(version.category) !== 'character') {
      throw new Error('Odrzuconą analizę ruchu można zapisać tylko dla wersji postaci.');
    }
    const expectedDirections = characterDirectionsForProjection(this.getProject().projection);
    const expectedIds = expectedDirections.map((direction) => direction.id);
    const analyzedIds = analysis.directions.map((direction) => direction.direction);
    if (analysis.status !== 'failed'
      || !analysis.summary.trim()
      || !analysis.turnId?.trim()
      || !analysis.analyzedAt
      || Number.isNaN(Date.parse(analysis.analyzedAt))
      || analyzedIds.length !== expectedIds.length
      || analyzedIds.some((direction, index) => direction !== expectedIds[index])
      || analysis.directions.some((direction) => !direction.message.trim())) {
      throw new Error('Odrzucony raport ruchu postaci jest niekompletny.');
    }
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      const result = this.sqlite.prepare(`
        UPDATE character_animation_sets SET analysis_status = 'failed', analysis_summary = ?,
          analysis_json = ?, analysis_turn_id = ?, analyzed_at = ? WHERE version_id = ?
      `).run(
        analysis.summary.trim(),
        JSON.stringify(analysis.directions),
        analysis.turnId,
        analysis.analyzedAt,
        versionId,
      );
      if (result.changes !== 1) throw new Error('Postać nie ma zapisanej konfiguracji animacji.');
      this.sqlite.prepare(`
        UPDATE asset_versions SET ai_verification_status = 'failed', ai_verification_message = ?,
          updated_at = ? WHERE id = ?
      `).run(analysis.summary.trim(), now, versionId);
    })();
  }

  private validateCharacterAnimationForFinalization(
    context: JobContext,
    data: GeneratedVersionData,
  ): CharacterAnimationSet | null {
    if (context.category !== 'character') {
      if (data.characterAnimation) {
        throw new Error('Zestaw animacji postaci można zapisać tylko dla kategorii character.');
      }
      return null;
    }
    if (data.category !== 'character' || !context.characterAnimation || !data.characterAnimation) {
      throw new Error('Postać wymaga kompletnego zestawu animacji kierunkowej przed finalizacją.');
    }

    const stored = this.sqlite.prepare(`
      SELECT * FROM character_animation_sets WHERE version_id = ?
    `).get(context.versionId) as Row | undefined;
    if (!stored) throw new Error('Postać nie ma zapisanej konfiguracji animacji.');
    const settings = characterAnimationSettingsSchema.parse(data.characterAnimation.settings);
    if (settings.action !== context.characterAnimation.action
      || settings.framesPerDirection !== context.characterAnimation.framesPerDirection
      || settings.framesPerSecond !== context.characterAnimation.framesPerSecond) {
      throw new Error('Wynik animacji postaci nie odpowiada konfiguracji zadania.');
    }

    const frameSize = { width: Number(stored.frame_width), height: Number(stored.frame_height) };
    if (frameSize.width <= 0 || frameSize.height <= 0
      || data.characterAnimation.frameSize.width !== frameSize.width
      || data.characterAnimation.frameSize.height !== frameSize.height) {
      throw new Error('Wynik animacji postaci ma nieprawidłowy rozmiar pojedynczej klatki.');
    }
    const sheetSize = characterAnimationSheetSize(frameSize, settings);
    if (data.characterAnimation.sheetSize.width !== sheetSize.width
      || data.characterAnimation.sheetSize.height !== sheetSize.height
      || data.width !== sheetSize.width
      || data.height !== sheetSize.height) {
      throw new Error(`Arkusz animacji postaci musi mieć dokładnie ${sheetSize.width}×${sheetSize.height}px.`);
    }

    const expectedDirections = characterDirectionsForProjection(this.getProject().projection);
    const resultDirectionIds = data.characterAnimation.directions.map((direction) => direction.id);
    if (resultDirectionIds.length !== expectedDirections.length
      || resultDirectionIds.some((direction, index) => direction !== expectedDirections[index].id)) {
      throw new Error('Arkusz animacji postaci nie zawiera kanonicznego zestawu kierunków projektu.');
    }
    const analysis = data.characterAnimation.movementAnalysis;
    if (analysis.status !== 'passed'
      || !analysis.summary.trim()
      || !analysis.turnId?.trim()
      || !analysis.analyzedAt
      || Number.isNaN(Date.parse(analysis.analyzedAt))) {
      throw new Error('Postać nie przeszła obowiązkowej analizy poprawności ruchu.');
    }
    const expectedIds = expectedDirections.map((direction) => direction.id);
    const analyzedIds = analysis.directions.map((direction) => direction.direction);
    if (analyzedIds.length !== expectedIds.length
      || analyzedIds.some((direction, index) => direction !== expectedIds[index])
      || analysis.directions.some((direction) => direction.status !== 'passed' || !direction.message.trim())) {
      throw new Error('Analiza ruchu musi zaliczyć każdy kanoniczny kierunek postaci.');
    }

    return {
      settings,
      directions: [...expectedDirections],
      frameSize,
      sheetSize,
      movementAnalysis: {
        status: 'passed',
        summary: analysis.summary.trim(),
        directions: analysis.directions.map((direction) => ({
          direction: characterDirectionSchema.parse(direction.direction),
          status: direction.status,
          message: direction.message.trim(),
        })),
        turnId: analysis.turnId,
        analyzedAt: analysis.analyzedAt,
      },
    };
  }

  getAiVerificationContext(versionId: string): AiVerificationContext {
    const row = this.sqlite.prepare(`
      SELECT v.*, a.name AS asset_name, a.codex_thread_id AS asset_thread_id, j.id AS job_id
      FROM asset_versions v
      JOIN assets a ON a.id = v.asset_id
      JOIN generation_jobs j ON j.version_id = v.id
      WHERE v.id = ?
      ORDER BY j.created_at DESC
      LIMIT 1
    `).get(versionId) as Row | undefined;
    if (!row) throw new Error('Nie znaleziono wersji assetu do weryfikacji.');
    if (!row.final_path) throw new Error('Ta wersja nie ma gotowego obrazu do weryfikacji.');
    return {
      jobId: String(row.job_id),
      versionId: String(row.id),
      assetId: String(row.asset_id),
      assetName: String(row.asset_name),
      assetThreadId: row.asset_thread_id ? String(row.asset_thread_id) : null,
      category: String(row.category) as AssetCategory,
      prompt: String(row.prompt),
      feedback: String(row.feedback),
      finalPath: String(row.final_path),
      status: String(row.status) as VersionStatus,
      aiVerificationStatus: String(row.ai_verification_status) as AiVerificationStatus,
    };
  }

  setAiVerificationResult(
    versionId: string,
    status: Exclude<AiVerificationStatus, 'pending'>,
    message: string,
  ): AssetDetail {
    const context = this.getAiVerificationContext(versionId);
    this.sqlite.prepare(`
      UPDATE asset_versions
      SET ai_verification_status = ?, ai_verification_message = ?, updated_at = ?
      WHERE id = ?
    `).run(status, message, new Date().toISOString(), versionId);
    return this.getAsset(context.assetId)!;
  }

  addArtifact(jobId: string, role: string, relativePath: string, mimeType: string): void {
    this.sqlite.prepare(`
      INSERT INTO generation_artifacts (id, job_id, role, relative_path, mime_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), jobId, role, relativePath, mimeType, new Date().toISOString());
  }

  addGenerationLog(
    jobId: string,
    stage: GenerationStage,
    level: GenerationLogLevel,
    attempt: number,
    message: string,
    details: GenerationLogEntry['details'] = null,
    createdAt = new Date().toISOString(),
  ): GenerationLogEntry {
    const id = randomUUID();
    this.sqlite.prepare(`
      INSERT INTO generation_job_logs (id, job_id, stage, level, attempt, message, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, jobId, stage, level, attempt, message, details ? JSON.stringify(details) : '', createdAt);
    const job = this.getJob(jobId);
    if (!job) throw new Error('Nie znaleziono zadania dla wpisu logu.');
    const preview = this.sqlite.prepare(`
      SELECT relative_path FROM generation_artifacts
      WHERE job_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1
    `).get(jobId, `candidate-attempt-${attempt}`) as { relative_path: string } | undefined;
    return {
      id, jobId, assetId: job.assetId, versionId: job.versionId, stage, level, attempt, message, details,
      previewUrl: preview ? makeAssetUrl(preview.relative_path) : null,
      createdAt,
    };
  }

  private getJobForVersion(versionId: string): GenerationJob | null {
    const row = this.sqlite.prepare(`
      SELECT * FROM generation_jobs WHERE version_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(versionId) as Row | undefined;
    return row ? mapJob(row) : null;
  }

  listGenerationLogs(assetId: string): GenerationLogEntry[] {
    return (this.sqlite.prepare(`
      SELECT l.*, j.asset_id, j.version_id,
        (
          SELECT a.relative_path FROM generation_artifacts a
          WHERE a.job_id = l.job_id AND a.role = 'candidate-attempt-' || l.attempt
          ORDER BY a.created_at DESC LIMIT 1
        ) AS preview_path
      FROM generation_job_logs l
      JOIN generation_jobs j ON j.id = l.job_id
      WHERE j.asset_id = ?
      ORDER BY l.created_at, l.rowid
    `).all(assetId) as Row[]).map(mapGenerationLog);
  }

  setAssetThread(assetId: string, threadId: string): void {
    this.sqlite.prepare('UPDATE assets SET codex_thread_id = ?, updated_at = ? WHERE id = ?')
      .run(threadId, new Date().toISOString(), assetId);
  }

  listProjectReferences(): ProjectReference[] {
    return (this.sqlite.prepare('SELECT * FROM project_references ORDER BY created_at DESC').all() as Row[])
      .map(mapProjectReference);
  }

  async addProjectReference(sourcePath: string, description: string): Promise<ProjectReference> {
    const source = sharp(sourcePath, { failOn: 'error' });
    const metadata = await source.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) {
      throw new Error('Referencja musi być obrazem PNG, JPEG lub WebP.');
    }
    const id = randomUUID();
    const outputPath = path.join(this.rootPath, 'references', `${id}.png`);
    const result = await source.rotate().resize({
      width: 2_048,
      height: 2_048,
      fit: 'inside',
      withoutEnlargement: true,
    }).png({ compressionLevel: 9 }).toFile(outputPath);
    const now = new Date().toISOString();
    const name = path.parse(sourcePath).name.trim().slice(0, 120) || 'Referencja';
    const relativePath = this.relative(outputPath);
    try {
      this.sqlite.prepare(`
        INSERT INTO project_references (
          id, name, description, relative_path, mime_type, width, height, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'image/png', ?, ?, ?, ?)
      `).run(id, name, description.trim(), relativePath, result.width, result.height, now, now);
    } catch (error) {
      if (existsSync(outputPath)) unlinkSync(outputPath);
      throw error;
    }
    return this.getProjectReference(id)!;
  }

  updateProjectReference(referenceId: string, description: string): ProjectReference {
    const result = this.sqlite.prepare(`
      UPDATE project_references SET description = ?, updated_at = ? WHERE id = ?
    `).run(description.trim(), new Date().toISOString(), referenceId);
    if (!result.changes) throw new Error('Nie znaleziono obrazu referencyjnego.');
    return this.getProjectReference(referenceId)!;
  }

  removeProjectReference(referenceId: string): void {
    const reference = this.getProjectReference(referenceId);
    if (!reference) throw new Error('Nie znaleziono obrazu referencyjnego.');
    this.sqlite.prepare('DELETE FROM project_references WHERE id = ?').run(referenceId);
    const absolutePath = this.resolveRelative(reference.relativePath);
    if (existsSync(absolutePath)) unlinkSync(absolutePath);
  }

  getProjectReference(referenceId: string): ProjectReference | null {
    const row = this.sqlite.prepare('SELECT * FROM project_references WHERE id = ?').get(referenceId) as Row | undefined;
    return row ? mapProjectReference(row) : null;
  }

  getProjectReferenceToolData(referenceId: string): { metadata: Record<string, unknown>; absolutePath: string } {
    const reference = this.getProjectReference(referenceId);
    if (!reference) throw new Error('Nie znaleziono obrazu referencyjnego.');
    return {
      metadata: {
        referenceId: reference.id,
        name: reference.name,
        description: reference.description,
        width: reference.width,
        height: reference.height,
      },
      absolutePath: this.resolveRelative(reference.relativePath),
    };
  }

  listProjectSettingsProposals(): ProjectSettingsProposal[] {
    return (this.sqlite.prepare(`
      SELECT * FROM project_settings_proposals
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC
    `).all() as Row[]).map(mapProjectSettingsProposal);
  }

  createProjectSettingsProposal(input: CreateProjectSettingsProposalInput): ProjectSettingsProposal {
    const references = [...new Set(input.referenceIds)];
    for (const referenceId of references) {
      if (!this.getProjectReference(referenceId)) {
        throw new Error(`Nie znaleziono obrazu referencyjnego: ${referenceId}.`);
      }
    }
    const project = this.getProject();
    if (project.projection === 'isometric'
      && input.settings.tileWidthPx !== undefined
      && input.settings.tileWidthPx % 2 !== 0) {
      throw new Error('Bazowa szerokość izometrycznego tile musi być parzysta.');
    }
    const before: ProjectSettingsSnapshot = {
      artBrief: project.artBrief,
      tileWidthPx: project.tileWidthPx,
      pixelsPerUnit: project.pixelsPerUnit,
      codexGenerationEnabled: project.codexGenerationEnabled,
      comfyUiEnabled: project.comfyUiEnabled,
      comfyUiProfile: project.comfyUiProfile,
      stableDiffusionCppEnabled: project.stableDiffusionCppEnabled,
    };
    const changes = Object.entries(input.settings).filter(([key, value]) => (
      value !== undefined && before[key as keyof ProjectSettingsSnapshot] !== value
    ));
    if (!changes.length) throw new Error('Propozycja nie zmienia żadnego ustawienia projektu.');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO project_settings_proposals (
        id, status, reason, before_json, proposed_json, reference_ids_json, created_at
      ) VALUES (?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.reason.trim(),
      JSON.stringify(before),
      JSON.stringify(input.settings),
      JSON.stringify(references),
      now,
    );
    return this.getProjectSettingsProposal(id)!;
  }

  reviewProjectSettingsProposal(
    proposalId: string,
    decision: 'approved' | 'rejected',
  ): ProjectSettingsProposal {
    const proposal = this.getProjectSettingsProposal(proposalId);
    if (!proposal) throw new Error('Nie znaleziono propozycji ustawień projektu.');
    if (proposal.status !== 'pending') throw new Error('Ta propozycja została już rozpatrzona.');
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      if (decision === 'approved') {
        const current = this.getProject();
        const nextTileWidth = proposal.proposed.tileWidthPx ?? current.tileWidthPx;
        if (current.projection === 'isometric' && nextTileWidth % 2 !== 0) {
          throw new Error('Bazowa szerokość izometrycznego tile musi być parzysta.');
        }
        const nextCodexEnabled = proposal.proposed.codexGenerationEnabled ?? current.codexGenerationEnabled;
        const nextComfyEnabled = proposal.proposed.comfyUiEnabled ?? current.comfyUiEnabled;
        const nextStableDiffusionCppEnabled = proposal.proposed.stableDiffusionCppEnabled
          ?? current.stableDiffusionCppEnabled;
        if (!nextCodexEnabled && !nextComfyEnabled && !nextStableDiffusionCppEnabled) {
          throw new Error('Włącz co najmniej jeden generator obrazów.');
        }
        this.sqlite.prepare(`
          UPDATE projects SET art_brief = ?, tile_width_px = ?, tile_height_px = ?,
            pixels_per_unit = ?, codex_generation_enabled = ?, comfyui_enabled = ?, comfyui_profile = ?,
            stable_diffusion_cpp_enabled = ?,
            style_summary_stale = 1, updated_at = ? WHERE id = ?
        `).run(
          proposal.proposed.artBrief ?? current.artBrief,
          nextTileWidth,
          tileHeightForProjection(current.projection, nextTileWidth),
          proposal.proposed.pixelsPerUnit ?? current.pixelsPerUnit,
          nextCodexEnabled ? 1 : 0,
          nextComfyEnabled ? 1 : 0,
          proposal.proposed.comfyUiProfile ?? current.comfyUiProfile,
          nextStableDiffusionCppEnabled ? 1 : 0,
          now,
          current.id,
        );
      }
      this.sqlite.prepare(`
        UPDATE project_settings_proposals SET status = ?, decided_at = ? WHERE id = ?
      `).run(decision, now, proposalId);
    })();
    return this.getProjectSettingsProposal(proposalId)!;
  }

  private getProjectSettingsProposal(proposalId: string): ProjectSettingsProposal | null {
    const row = this.sqlite.prepare('SELECT * FROM project_settings_proposals WHERE id = ?')
      .get(proposalId) as Row | undefined;
    return row ? mapProjectSettingsProposal(row) : null;
  }

  listAssets(): AssetSummary[] {
    const rows = this.sqlite.prepare(`
      SELECT a.*, COUNT(v.id) AS version_count,
        (SELECT id FROM asset_versions lv WHERE lv.asset_id = a.id ORDER BY lv.created_at DESC LIMIT 1) AS latest_id
      FROM assets a LEFT JOIN asset_versions v ON v.asset_id = a.id
      GROUP BY a.id ORDER BY a.updated_at DESC
    `).all() as Row[];
    return rows.map((row) => this.mapAssetSummary(row));
  }

  getAsset(assetId: string): AssetDetail | null {
    const row = this.sqlite.prepare(`
      SELECT a.*, COUNT(v.id) AS version_count,
        (SELECT id FROM asset_versions lv WHERE lv.asset_id = a.id ORDER BY lv.created_at DESC LIMIT 1) AS latest_id
      FROM assets a LEFT JOIN asset_versions v ON v.asset_id = a.id
      WHERE a.id = ? GROUP BY a.id
    `).get(assetId) as Row | undefined;
    if (!row) return null;
    return {
      ...this.mapAssetSummary(row),
      versions: (this.sqlite.prepare('SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY created_at DESC')
        .all(assetId) as Row[]).map((version) => this.mapVersion(version)),
    };
  }

  reviewVersion(input: ReviewVersionInput): AssetDetail {
    const row = this.sqlite.prepare('SELECT * FROM asset_versions WHERE id = ?').get(input.versionId) as Row | undefined;
    if (!row) throw new Error('Nie znaleziono wersji assetu.');
    if (!['needs_review', 'approved', 'rejected'].includes(String(row.status))) {
      throw new Error('Ta wersja nie jest gotowa do review.');
    }
    const category = String(row.category) as AssetCategory;
    if ((isTileAssetCategory(category) || isRoadAssetCategory(category))
      && (input.footprint.x !== 1 || input.footprint.y !== 1)) {
      throw new Error('Terrain tile i road tile muszą zachować footprint 1×1.');
    }
    if (input.decision === 'approved' && category === 'character') {
      const animation = this.mapCharacterAnimation(input.versionId, category);
      const expectedDirections = characterDirectionsForProjection(this.getProject().projection)
        .map((direction) => direction.id);
      const analyzedDirections = animation?.movementAnalysis.directions ?? [];
      if (!animation
        || animation.movementAnalysis.status !== 'passed'
        || !animation.movementAnalysis.summary.trim()
        || !animation.movementAnalysis.turnId
        || !animation.movementAnalysis.analyzedAt
        || analyzedDirections.length !== expectedDirections.length
        || analyzedDirections.some((direction, index) => (
          direction.direction !== expectedDirections[index]
          || direction.status !== 'passed'
          || !direction.message.trim()
        ))) {
        throw new Error('Nie można zatwierdzić postaci bez kompletnej, zaliczonej analizy ruchu.');
      }
    }
    const now = new Date().toISOString();
    const assetId = String(row.asset_id);
    this.sqlite.transaction(() => {
      if (input.decision === 'approved') {
        const existing = this.sqlite.prepare(`
          SELECT id FROM asset_versions
          WHERE asset_id = ? AND status = 'approved' AND id <> ? LIMIT 1
        `).get(assetId, input.versionId) as Row | undefined;
        if (existing) {
          throw new Error('Ten asset ma już zatwierdzoną wersję. Najpierw cofnij jej zatwierdzenie; tylko jedna wersja może być zatwierdzona.');
        }
      }
      this.sqlite.prepare(`
        UPDATE asset_versions SET status = ?, footprint_x = ?, footprint_y = ?,
          pivot_x = ?, pivot_y = ?, rejection_reason = ?, updated_at = ? WHERE id = ?
      `).run(
        input.decision, input.footprint.x, input.footprint.y,
        input.pivot.x, input.pivot.y, input.rejectionReason ?? '', now, input.versionId,
      );
      this.replaceTags(input.versionId, input.tags);
      if (input.decision === 'approved') {
        this.sqlite.prepare(`
          UPDATE assets SET current_approved_version_id = ?, updated_at = ? WHERE id = ?
        `).run(input.versionId, now, assetId);
        this.sqlite.prepare('UPDATE projects SET style_summary_stale = 1, updated_at = ?').run(now);
      } else if (String(row.status) === 'approved') {
        this.sqlite.prepare(`
          UPDATE assets SET current_approved_version_id = NULL, updated_at = ?
          WHERE id = ? AND current_approved_version_id = ?
        `).run(now, assetId, input.versionId);
        this.sqlite.prepare('UPDATE projects SET style_summary_stale = 1, updated_at = ?').run(now);
      }
    })();
    const job = this.getJobForVersion(input.versionId);
    if (job) {
      if (input.decision === 'rejected') {
        const reason = input.rejectionReason?.trim();
        this.addGenerationLog(
          job.id,
          'review',
          'warning',
          0,
          `Odrzucono wersję. Powód: ${reason || 'nie podano powodu'}.`,
        );
      } else {
        this.addGenerationLog(job.id, 'review', 'success', 0, 'Zatwierdzono wersję i dodano ją do registry.');
      }
    }
    return this.getAsset(assetId)!;
  }

  undoApproval(versionId: string): AssetDetail {
    const row = this.sqlite.prepare('SELECT asset_id, status FROM asset_versions WHERE id = ?').get(versionId) as Row | undefined;
    if (!row) throw new Error('Nie znaleziono wersji assetu.');
    if (String(row.status) !== 'approved') throw new Error('Cofnąć można tylko zatwierdzenie zatwierdzonej wersji.');
    const assetId = String(row.asset_id);
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE asset_versions SET status = 'needs_review', updated_at = ? WHERE id = ?
      `).run(now, versionId);
      this.sqlite.prepare(`
        UPDATE assets SET current_approved_version_id = NULL, updated_at = ?
        WHERE id = ? AND current_approved_version_id = ?
      `).run(now, assetId, versionId);
      this.sqlite.prepare('UPDATE projects SET style_summary_stale = 1, updated_at = ?').run(now);
    })();
    const job = this.getJobForVersion(versionId);
    if (job) this.addGenerationLog(job.id, 'review', 'info', 0, 'Cofnięto zatwierdzenie. Wersja ponownie oczekuje na review.');
    return this.getAsset(assetId)!;
  }

  undoRejection(versionId: string): AssetDetail {
    const row = this.sqlite.prepare('SELECT asset_id, status FROM asset_versions WHERE id = ?').get(versionId) as Row | undefined;
    if (!row) throw new Error('Nie znaleziono wersji assetu.');
    if (String(row.status) !== 'rejected') throw new Error('Cofnąć można tylko odrzucenie odrzuconej wersji.');
    const assetId = String(row.asset_id);
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE asset_versions SET status = 'needs_review', rejection_reason = '', updated_at = ? WHERE id = ?
      `).run(now, versionId);
      this.sqlite.prepare('UPDATE assets SET updated_at = ? WHERE id = ?').run(now, assetId);
    })();
    const job = this.getJobForVersion(versionId);
    if (job) this.addGenerationLog(job.id, 'review', 'info', 0, 'Cofnięto odrzucenie. Wersja ponownie oczekuje na review.');
    return this.getAsset(assetId)!;
  }

  listTags(): Array<{ slug: string; label: string; count: number }> {
    return this.sqlite.prepare(`
      SELECT t.slug, t.label, COUNT(avt.version_id) AS count FROM tags t
      LEFT JOIN asset_version_tags avt ON avt.tag_id = t.id
      GROUP BY t.id ORDER BY count DESC, t.label
    `).all() as Array<{ slug: string; label: string; count: number }>;
  }

  searchAssets(options: {
    query?: string; category?: string; tags?: string[]; statuses?: string[]; limit?: number;
  }): Array<Record<string, unknown>> {
    const statuses = options.statuses?.length ? options.statuses : ['approved'];
    const clauses = [`v.status IN (${statuses.map(() => '?').join(',')})`];
    const params: unknown[] = [...statuses];
    if (options.category) { clauses.push('v.category = ?'); params.push(options.category); }
    if (options.query) {
      clauses.push('(a.name LIKE ? OR a.description LIKE ? OR v.ai_description LIKE ?)');
      const query = `%${options.query}%`; params.push(query, query, query);
    }
    if (options.tags?.length) {
      clauses.push(`v.id IN (
        SELECT avt.version_id FROM asset_version_tags avt JOIN tags t ON t.id = avt.tag_id
        WHERE t.slug IN (${options.tags.map(() => '?').join(',')})
        GROUP BY avt.version_id HAVING COUNT(DISTINCT t.slug) = ?
      )`);
      params.push(...options.tags.map(normalizeTag), options.tags.length);
    }
    params.push(Math.min(Math.max(options.limit ?? 20, 1), 50));
    const rows = this.sqlite.prepare(`
      SELECT v.id AS version_id, a.id AS asset_id, a.name, v.category, v.status,
        v.ai_description, v.final_path, v.width, v.height, v.footprint_x, v.footprint_y,
        v.pivot_x, v.pivot_y, v.elevation_levels, v.relative_width, v.relative_height,
        v.road_connections
      FROM asset_versions v JOIN assets a ON a.id = v.asset_id
      WHERE ${clauses.join(' AND ')} ORDER BY v.updated_at DESC LIMIT ?
    `).all(...params) as Row[];
    return rows.map((row) => {
      const category = String(row.category) as AssetCategory;
      return {
        assetId: row.asset_id, versionId: row.version_id, name: row.name,
        category, status: row.status, description: row.ai_description,
        elevationLevels: row.elevation_levels,
        relativeSize: { width: row.relative_width, height: row.relative_height },
        roadVariants: category === 'road_tile' ? this.getRoadVariantMasks(String(row.version_id)) : [],
        characterAnimation: this.mapCharacterAnimation(String(row.version_id), category),
        tags: this.getVersionTags(String(row.version_id)),
        footprint: { x: row.footprint_x, y: row.footprint_y },
        pivot: { x: row.pivot_x, y: row.pivot_y }, width: row.width, height: row.height,
      };
    });
  }

  getAssetToolData(assetId: string, versionId?: string): { metadata: Record<string, unknown>; absolutePath: string } {
    const row = this.sqlite.prepare(`
      SELECT v.*, a.name FROM asset_versions v JOIN assets a ON a.id = v.asset_id
      WHERE a.id = ? AND v.id = COALESCE(?, a.current_approved_version_id)
    `).get(assetId, versionId ?? null) as Row | undefined;
    if (!row || !row.final_path) throw new Error('Asset nie ma dostępnej wersji obrazowej.');
    const category = String(row.category) as AssetCategory;
    return {
      metadata: {
        assetId, versionId: row.id, name: row.name, category,
        status: row.status, tags: this.getVersionTags(String(row.id)),
        elevationLevels: row.elevation_levels,
        relativeSize: { width: row.relative_width, height: row.relative_height },
        roadVariants: category === 'road_tile' ? this.getRoadVariantMasks(String(row.id)) : [],
        characterAnimation: this.mapCharacterAnimation(String(row.id), category),
        description: row.ai_description,
        footprint: { x: row.footprint_x, y: row.footprint_y },
        pivot: { x: row.pivot_x, y: row.pivot_y }, width: row.width, height: row.height,
      },
      absolutePath: this.resolveRelative(String(row.final_path)),
    };
  }

  getStyleHistory(): StyleSummaryRevision[] {
    return (this.sqlite.prepare(`
      SELECT * FROM style_summary_revisions ORDER BY created_at DESC, rowid DESC
    `).all() as Row[])
      .map(mapStyleRevision);
  }

  addStyleRevision(summary: string, source: 'ai' | 'manual' | 'restore', basedOnVersionId?: string): StyleSummaryRevision {
    const project = this.getProject();
    const previous = this.sqlite.prepare('SELECT active_style_summary_id FROM projects LIMIT 1').get() as Row;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO style_summary_revisions (id, summary, previous_id, based_on_version_id, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, summary, previous.active_style_summary_id ?? null, basedOnVersionId ?? null, source, now);
      this.sqlite.prepare(`
        UPDATE projects SET active_style_summary_id = ?, style_summary_stale = 0, updated_at = ? WHERE id = ?
      `).run(id, now, project.id);
    })();
    return this.getStyleHistory().find((revision) => revision.id === id)!;
  }

  restoreStyleRevision(revisionId: string): StyleSummaryRevision {
    const revision = this.getStyleHistory().find((item) => item.id === revisionId);
    if (!revision) throw new Error('Nie znaleziono rewizji stylu.');
    return this.addStyleRevision(revision.summary, 'restore', revision.basedOnVersionId ?? undefined);
  }

  markStyleStale(): void {
    this.sqlite.prepare('UPDATE projects SET style_summary_stale = 1, updated_at = ?')
      .run(new Date().toISOString());
  }

  setExportTarget(integration: ExportIntegration, target: string): void {
    const parsedIntegration = exportIntegrationSchema.parse(integration);
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO export_targets (integration, target_path, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(integration) DO UPDATE SET target_path = excluded.target_path, updated_at = excluded.updated_at
      `).run(parsedIntegration, target, now);
      this.sqlite.prepare('UPDATE projects SET updated_at = ?').run(now);
    })();
  }

  recordExport(
    integration: ExportIntegration,
    targetPath: string,
    manifestPath: string,
    assetCount: number,
  ): void {
    this.sqlite.prepare(`
      INSERT INTO export_records (id, integration, target_path, manifest_path, asset_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      exportIntegrationSchema.parse(integration),
      targetPath,
      manifestPath,
      assetCount,
      new Date().toISOString(),
    );
  }

  commitExport(
    integration: ExportIntegration,
    targetPath: string,
    manifestPath: string,
    assetCount: number,
  ): void {
    const parsedIntegration = exportIntegrationSchema.parse(integration);
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO export_targets (integration, target_path, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(integration) DO UPDATE SET target_path = excluded.target_path, updated_at = excluded.updated_at
      `).run(parsedIntegration, targetPath, now);
      this.sqlite.prepare('UPDATE projects SET updated_at = ?').run(now);
      this.sqlite.prepare(`
        INSERT INTO export_records (id, integration, target_path, manifest_path, asset_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), parsedIntegration, targetPath, manifestPath, assetCount, now);
    })();
  }

  approvedAssets(assetIds?: string[]): Array<{ asset: AssetSummary; version: AssetVersion; absolutePath: string }> {
    return this.listAssets()
      .filter((asset) => asset.currentApprovedVersionId && (!assetIds || assetIds.includes(asset.id)))
      .map((asset) => {
        const detail = this.getAsset(asset.id)!;
        const version = detail.versions.find((item) => item.id === asset.currentApprovedVersionId)!;
        return { asset, version, absolutePath: this.resolveRelative(version.finalPath!) };
      });
  }

  resolveRelative(relativePath: string): string {
    const resolved = path.resolve(this.rootPath, relativePath);
    const prefix = `${this.rootPath}${path.sep}`.toLocaleLowerCase();
    if (resolved.toLocaleLowerCase() !== this.rootPath.toLocaleLowerCase() && !resolved.toLocaleLowerCase().startsWith(prefix)) {
      throw new Error('Próba dostępu poza katalogiem projektu.');
    }
    return resolved;
  }

  relative(absolutePath: string): string {
    const resolved = path.resolve(absolutePath);
    this.resolveRelative(path.relative(this.rootPath, resolved));
    return path.relative(this.rootPath, resolved).split(path.sep).join('/');
  }

  private mapAssetSummary(row: Row): AssetSummary {
    const latestRow = row.latest_id
      ? this.sqlite.prepare('SELECT * FROM asset_versions WHERE id = ?').get(row.latest_id) as Row | undefined
      : undefined;
    return {
      id: String(row.id), name: String(row.name), description: String(row.description),
      category: String(row.category) as AssetCategory,
      elevationLevels: Number(row.elevation_levels),
      relativeWidth: Number(row.relative_width),
      relativeHeight: Number(row.relative_height),
      roadConnections: Number(row.road_connections),
      currentApprovedVersionId: row.current_approved_version_id ? String(row.current_approved_version_id) : null,
      latestVersion: latestRow ? this.mapVersion(latestRow) : null,
      versionCount: Number(row.version_count), codexThreadId: row.codex_thread_id ? String(row.codex_thread_id) : null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private characterAnimationSettingsForIteration(
    assetId: string,
    parentVersionId?: string,
  ): CharacterAnimationSettings | null {
    const row = parentVersionId
      ? this.sqlite.prepare(`
          SELECT c.action, c.frames_per_direction, c.frames_per_second
          FROM character_animation_sets c
          JOIN asset_versions v ON v.id = c.version_id
          WHERE v.asset_id = ? AND v.id = ?
        `).get(assetId, parentVersionId) as Row | undefined
      : this.sqlite.prepare(`
          SELECT c.action, c.frames_per_direction, c.frames_per_second
          FROM character_animation_sets c
          JOIN asset_versions v ON v.id = c.version_id
          WHERE v.asset_id = ?
          ORDER BY v.created_at DESC, v.rowid DESC
          LIMIT 1
        `).get(assetId) as Row | undefined;
    if (!row) return null;
    return characterAnimationSettingsSchema.parse({
      action: row.action,
      framesPerDirection: Number(row.frames_per_direction),
      framesPerSecond: Number(row.frames_per_second),
    });
  }

  private mapCharacterAnimation(versionId: string, category: AssetCategory): CharacterAnimationSet | null {
    if (category !== 'character') return null;
    const row = this.sqlite.prepare(`
      SELECT * FROM character_animation_sets WHERE version_id = ?
    `).get(versionId) as Row | undefined;
    if (!row) return null;
    const settings = characterAnimationSettingsSchema.parse({
      action: row.action,
      framesPerDirection: Number(row.frames_per_direction),
      framesPerSecond: Number(row.frames_per_second),
    });
    const frameSize = { width: Number(row.frame_width), height: Number(row.frame_height) };
    if (frameSize.width <= 0 || frameSize.height <= 0) {
      throw new Error('Baza zawiera nieprawidłowy rozmiar klatki animacji postaci.');
    }
    const status = String(row.analysis_status);
    if (!['pending', 'passed', 'failed'].includes(status)) {
      throw new Error('Baza zawiera nieprawidłowy status analizy ruchu postaci.');
    }
    return {
      settings,
      directions: [...characterDirectionsForProjection(this.getProject().projection)],
      frameSize,
      sheetSize: characterAnimationSheetSize(frameSize, settings),
      movementAnalysis: {
        status: status as CharacterMovementAnalysis['status'],
        summary: String(row.analysis_summary),
        directions: parseCharacterMovementDirectionAnalyses(row.analysis_json),
        turnId: row.analysis_turn_id ? String(row.analysis_turn_id) : null,
        analyzedAt: row.analyzed_at ? String(row.analyzed_at) : null,
      },
    };
  }

  private mapVersion(row: Row): AssetVersion {
    const finalPath = row.final_path ? String(row.final_path) : null;
    const roadVariants = (this.sqlite.prepare(`
      SELECT connection_mask, final_path, width, height
      FROM road_variants WHERE version_id = ? ORDER BY connection_mask
    `).all(String(row.id)) as Row[]).map((variant) => ({
      connectionMask: Number(variant.connection_mask),
      finalPath: String(variant.final_path),
      imageUrl: makeAssetUrl(String(variant.final_path)),
      width: Number(variant.width),
      height: Number(variant.height),
    }));
    const category = String(row.category) as AssetCategory;
    return {
      id: String(row.id), assetId: String(row.asset_id),
      parentVersionId: row.parent_version_id ? String(row.parent_version_id) : null,
      mode: String(row.mode) as AssetVersion['mode'], status: String(row.status) as VersionStatus,
      prompt: String(row.prompt), feedback: String(row.feedback), category,
      elevationLevels: Number(row.elevation_levels),
      relativeWidth: Number(row.relative_width),
      relativeHeight: Number(row.relative_height),
      roadConnections: Number(row.road_connections),
      roadVariants,
      characterAnimation: this.mapCharacterAnimation(String(row.id), category),
      tags: this.getVersionTags(String(row.id)), finalPath,
      imageUrl: finalPath ? makeAssetUrl(finalPath) : null,
      width: row.width === null ? null : Number(row.width), height: row.height === null ? null : Number(row.height),
      footprint: { x: Number(row.footprint_x), y: Number(row.footprint_y) },
      pivot: { x: Number(row.pivot_x), y: Number(row.pivot_y) },
      aiDescription: String(row.ai_description),
      aiVerificationStatus: String(row.ai_verification_status) as AssetVersion['aiVerificationStatus'],
      aiVerificationMessage: String(row.ai_verification_message),
      generatorProvider: String(row.generator_provider) as GeneratorProvider,
      generatorModel: String(row.generator_model),
      generatorWorkflowHash: String(row.generator_workflow_hash),
      providerRunId: String(row.provider_run_id),
      generationMetadata: parseJsonRecord(row.generation_metadata_json),
      rejectionReason: String(row.rejection_reason),
      error: String(row.error), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private replaceTags(versionId: string, labels: string[]): void {
    this.sqlite.prepare('DELETE FROM asset_version_tags WHERE version_id = ?').run(versionId);
    const unique = new Map(labels.map((label) => [normalizeTag(label), label.trim()]));
    for (const [slug, label] of unique) {
      if (!slug) continue;
      const existing = this.sqlite.prepare('SELECT id FROM tags WHERE slug = ?').get(slug) as Row | undefined;
      const tagId = existing ? String(existing.id) : randomUUID();
      if (!existing) this.sqlite.prepare('INSERT INTO tags (id, slug, label) VALUES (?, ?, ?)').run(tagId, slug, label);
      this.sqlite.prepare('INSERT OR IGNORE INTO asset_version_tags (version_id, tag_id) VALUES (?, ?)')
        .run(versionId, tagId);
    }
  }

  private getVersionTags(versionId: string): string[] {
    return (this.sqlite.prepare(`
      SELECT t.label FROM tags t JOIN asset_version_tags avt ON avt.tag_id = t.id
      WHERE avt.version_id = ? ORDER BY t.label
    `).all(versionId) as Array<{ label: string }>).map((tag) => tag.label);
  }

  private getRoadVariantMasks(versionId: string): number[] {
    return (this.sqlite.prepare(`
      SELECT connection_mask FROM road_variants WHERE version_id = ? ORDER BY connection_mask
    `).all(versionId) as Row[]).map((row) => Number(row.connection_mask));
  }
}

function mapJob(row: Row): GenerationJob {
  return {
    id: String(row.id), assetId: String(row.asset_id), versionId: String(row.version_id),
    generatorProvider: String(row.generator_provider) as GeneratorProvider,
    status: String(row.status) as VersionStatus, progress: String(row.progress), error: String(row.error),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseCharacterMovementDirectionAnalyses(value: unknown): CharacterMovementDirectionAnalysis[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? '[]')) as unknown;
  } catch {
    throw new Error('Baza zawiera uszkodzony raport analizy ruchu postaci.');
  }
  if (!Array.isArray(parsed)) throw new Error('Raport analizy ruchu postaci nie jest listą kierunków.');
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Raport analizy ruchu postaci zawiera nieprawidłowy wpis kierunku.');
    }
    const record = entry as Record<string, unknown>;
    const status = String(record.status);
    if (status !== 'passed' && status !== 'failed') {
      throw new Error('Raport analizy ruchu postaci zawiera nieprawidłowy status kierunku.');
    }
    return {
      direction: characterDirectionSchema.parse(record.direction),
      status,
      message: String(record.message ?? ''),
    };
  });
}

function mapGenerationLog(row: Row): GenerationLogEntry {
  return {
    id: String(row.id), jobId: String(row.job_id), assetId: String(row.asset_id), versionId: String(row.version_id),
    stage: String(row.stage) as GenerationStage, level: String(row.level) as GenerationLogLevel,
    attempt: Number(row.attempt), message: String(row.message), details: parseLogDetails(row.details_json),
    previewUrl: row.preview_path ? makeAssetUrl(String(row.preview_path)) : null,
    createdAt: String(row.created_at),
  };
}

function mapProjectReference(row: Row): ProjectReference {
  const relativePath = String(row.relative_path);
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    relativePath,
    imageUrl: makeAssetUrl(relativePath),
    width: Number(row.width),
    height: Number(row.height),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapProjectSettingsProposal(row: Row): ProjectSettingsProposal {
  return {
    id: String(row.id),
    status: String(row.status) as ProjectSettingsProposal['status'],
    reason: String(row.reason),
    before: JSON.parse(String(row.before_json)) as ProjectSettingsSnapshot,
    proposed: JSON.parse(String(row.proposed_json)) as Partial<ProjectSettingsSnapshot>,
    referenceIds: JSON.parse(String(row.reference_ids_json)) as string[],
    createdAt: String(row.created_at),
    decidedAt: row.decided_at ? String(row.decided_at) : null,
  };
}

function parseLogDetails(value: unknown): GenerationLogEntry['details'] {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value)) as Record<string, unknown>;
    if (typeof parsed.tool !== 'string' || !parsed.arguments || typeof parsed.arguments !== 'object') return null;
    return { tool: parsed.tool, arguments: parsed.arguments as Record<string, unknown> };
  } catch {
    return null;
  }
}

function mapStyleRevision(row: Row): StyleSummaryRevision {
  return {
    id: String(row.id), summary: String(row.summary), previousId: row.previous_id ? String(row.previous_id) : null,
    basedOnVersionId: row.based_on_version_id ? String(row.based_on_version_id) : null,
    source: String(row.source) as StyleSummaryRevision['source'], createdAt: String(row.created_at),
  };
}

export function normalizeTag(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('pl-PL')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function makeAssetUrl(relativePath: string): string {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  return `tilemap-asset://project/${encoded}`;
}
