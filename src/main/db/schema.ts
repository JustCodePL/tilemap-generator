import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  artBrief: text('art_brief').notNull().default(''),
  projection: text('projection').notNull().default('isometric'),
  tileWidthPx: integer('tile_width_px').notNull(),
  tileHeightPx: integer('tile_height_px').notNull(),
  pixelsPerUnit: integer('pixels_per_unit').notNull(),
  maxConcurrentJobs: integer('max_concurrent_jobs').notNull().default(1),
  aiVerificationEnabled: integer('ai_verification_enabled', { mode: 'boolean' }).notNull().default(true),
  codexGenerationEnabled: integer('codex_generation_enabled', { mode: 'boolean' }).notNull().default(true),
  comfyUiEnabled: integer('comfyui_enabled', { mode: 'boolean' }).notNull().default(false),
  comfyUiProfile: text('comfyui_profile').notNull().default('z_image_turbo'),
  stableDiffusionCppEnabled: integer('stable_diffusion_cpp_enabled', { mode: 'boolean' }).notNull().default(false),
  activeStyleSummaryId: text('active_style_summary_id'),
  styleSummaryStale: integer('style_summary_stale', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  category: text('category').notNull().default('other'),
  elevationLevels: integer('elevation_levels').notNull().default(0),
  relativeWidth: real('relative_width').notNull().default(1),
  relativeHeight: real('relative_height').notNull().default(1),
  roadConnections: integer('road_connections').notNull().default(0),
  currentApprovedVersionId: text('current_approved_version_id'),
  codexThreadId: text('codex_thread_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const assetVersions = sqliteTable('asset_versions', {
  id: text('id').primaryKey(),
  assetId: text('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  parentVersionId: text('parent_version_id'),
  mode: text('mode').notNull(),
  status: text('status').notNull(),
  prompt: text('prompt').notNull(),
  feedback: text('feedback').notNull().default(''),
  category: text('category').notNull().default('other'),
  elevationLevels: integer('elevation_levels').notNull().default(0),
  relativeWidth: real('relative_width').notNull().default(1),
  relativeHeight: real('relative_height').notNull().default(1),
  roadConnections: integer('road_connections').notNull().default(0),
  finalPath: text('final_path'),
  sourcePath: text('source_path'),
  width: integer('width'),
  height: integer('height'),
  footprintX: integer('footprint_x').notNull().default(1),
  footprintY: integer('footprint_y').notNull().default(1),
  pivotX: real('pivot_x').notNull().default(0.5),
  pivotY: real('pivot_y').notNull().default(0),
  aiDescription: text('ai_description').notNull().default(''),
  aiVerificationStatus: text('ai_verification_status').notNull().default('passed'),
  aiVerificationMessage: text('ai_verification_message').notNull().default(''),
  generatorProvider: text('generator_provider').notNull().default('codex'),
  generatorModel: text('generator_model').notNull().default(''),
  generatorWorkflowHash: text('generator_workflow_hash').notNull().default(''),
  providerRunId: text('provider_run_id').notNull().default(''),
  generationMetadataJson: text('generation_metadata_json').notNull().default('{}'),
  rejectionReason: text('rejection_reason').notNull().default(''),
  codexTurnId: text('codex_turn_id'),
  error: text('error').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const roadVariants = sqliteTable('road_variants', {
  versionId: text('version_id').notNull().references(() => assetVersions.id, { onDelete: 'cascade' }),
  connectionMask: integer('connection_mask').notNull(),
  finalPath: text('final_path').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
}, (table) => [primaryKey({ columns: [table.versionId, table.connectionMask] })]);

export const characterAnimationSets = sqliteTable('character_animation_sets', {
  versionId: text('version_id').primaryKey().references(() => assetVersions.id, { onDelete: 'cascade' }),
  action: text('action').notNull().default('walk'),
  framesPerDirection: integer('frames_per_direction').notNull().default(4),
  framesPerSecond: integer('frames_per_second').notNull().default(8),
  frameWidth: integer('frame_width').notNull(),
  frameHeight: integer('frame_height').notNull(),
  analysisStatus: text('analysis_status').notNull().default('pending'),
  analysisSummary: text('analysis_summary').notNull().default(''),
  analysisJson: text('analysis_json').notNull().default('[]'),
  analysisTurnId: text('analysis_turn_id'),
  analyzedAt: text('analyzed_at'),
});

export const generationJobs = sqliteTable('generation_jobs', {
  id: text('id').primaryKey(),
  assetId: text('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  versionId: text('version_id').notNull().references(() => assetVersions.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  progress: text('progress').notNull().default('Oczekuje w kolejce'),
  error: text('error').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});

export const generationArtifacts = sqliteTable('generation_artifacts', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => generationJobs.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  relativePath: text('relative_path').notNull(),
  mimeType: text('mime_type').notNull(),
  createdAt: text('created_at').notNull(),
});

export const generationJobLogs = sqliteTable('generation_job_logs', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => generationJobs.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  level: text('level').notNull(),
  attempt: integer('attempt').notNull().default(1),
  message: text('message').notNull(),
  detailsJson: text('details_json').notNull().default(''),
  createdAt: text('created_at').notNull(),
});

export const projectReferences = sqliteTable('project_references', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  relativePath: text('relative_path').notNull(),
  mimeType: text('mime_type').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const projectSettingsProposals = sqliteTable('project_settings_proposals', {
  id: text('id').primaryKey(),
  status: text('status').notNull().default('pending'),
  reason: text('reason').notNull(),
  beforeJson: text('before_json').notNull(),
  proposedJson: text('proposed_json').notNull(),
  referenceIdsJson: text('reference_ids_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  decidedAt: text('decided_at'),
});

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  label: text('label').notNull(),
});

export const assetVersionTags = sqliteTable('asset_version_tags', {
  versionId: text('version_id').notNull().references(() => assetVersions.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
}, (table) => [primaryKey({ columns: [table.versionId, table.tagId] })]);

export const styleSummaryRevisions = sqliteTable('style_summary_revisions', {
  id: text('id').primaryKey(),
  summary: text('summary').notNull(),
  previousId: text('previous_id'),
  basedOnVersionId: text('based_on_version_id'),
  source: text('source').notNull(),
  createdAt: text('created_at').notNull(),
});

export const exportTargets = sqliteTable('export_targets', {
  integration: text('integration').primaryKey(),
  targetPath: text('target_path').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const exportRecords = sqliteTable('export_records', {
  id: text('id').primaryKey(),
  integration: text('integration').notNull().default('unity'),
  targetPath: text('target_path').notNull(),
  manifestPath: text('manifest_path').notNull(),
  assetCount: integer('asset_count').notNull(),
  createdAt: text('created_at').notNull(),
});
