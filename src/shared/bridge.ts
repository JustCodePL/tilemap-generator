import type {
  AssetDetail,
  AssetSummary,
  AddProjectReferenceInput,
  CodexHealth,
  ComfyUiHealth,
  CreateProjectInput,
  EnqueueGenerationInput,
  ExportIntegration,
  ExportIntegrationDescriptor,
  ExportPreview,
  ExportPreviewInput,
  ExportRunResult,
  GenerationEvent,
  GenerationJob,
  GenerationLogEntry,
  ProjectInfo,
  ProjectReference,
  ProjectSettingsProposal,
  RecentProject,
  ReviewVersionInput,
  ReviewProjectSettingsProposalInput,
  StableDiffusionCppHealth,
  StableDiffusionCppInstallEvent,
  StableDiffusionCppModelId,
  StableDiffusionCppSetupInfo,
  StyleSummaryRevision,
  UpdateStyleInput,
  UpdateProjectReferenceInput,
  UpdateProjectSettingsInput,
} from './domain';
import type { AppUpdateState } from './update-feed';

export const ipcChannels = {
  projectCreate: 'projects:create',
  projectChooseStorage: 'projects:choose-storage',
  projectOpen: 'projects:open',
  projectOpenRecent: 'projects:open-recent',
  projectCurrent: 'projects:current',
  projectUpdate: 'projects:update',
  projectClose: 'projects:close',
  projectRecents: 'projects:recents',
  projectRemoveRecent: 'projects:remove-recent',
  projectSettingsProposals: 'projects:settings-proposals',
  projectSettingsProposalReview: 'projects:settings-proposal-review',
  projectChanged: 'projects:changed',
  assetsList: 'assets:list',
  assetsGet: 'assets:get',
  assetsReview: 'assets:review',
  assetsUndoApproval: 'assets:undo-approval',
  assetsUndoRejection: 'assets:undo-rejection',
  referencesList: 'references:list',
  referencesAdd: 'references:add',
  referencesUpdate: 'references:update',
  referencesRemove: 'references:remove',
  generationEnqueue: 'generation:enqueue',
  generationCancel: 'generation:cancel',
  generationRetry: 'generation:retry',
  generationVerify: 'generation:verify',
  generationJobs: 'generation:jobs',
  generationLogs: 'generation:logs',
  generationEvent: 'generation:event',
  styleHistory: 'style:history',
  styleUpdate: 'style:update',
  styleRestore: 'style:restore',
  styleRebuild: 'style:rebuild',
  exportChooseTarget: 'export:choose-target',
  exportIntegrations: 'export:integrations',
  exportPreview: 'export:preview',
  exportRun: 'export:run',
  codexHealth: 'codex:health',
  codexRefresh: 'codex:refresh',
  comfyHealth: 'comfy:health',
  comfyRefresh: 'comfy:refresh',
  stableDiffusionCppHealth: 'stable-diffusion-cpp:health',
  stableDiffusionCppRefresh: 'stable-diffusion-cpp:refresh',
  stableDiffusionCppSetup: 'stable-diffusion-cpp:setup',
  stableDiffusionCppInstall: 'stable-diffusion-cpp:install',
  stableDiffusionCppSelectModel: 'stable-diffusion-cpp:select-model',
  stableDiffusionCppCancelInstall: 'stable-diffusion-cpp:cancel-install',
  stableDiffusionCppInstallEvent: 'stable-diffusion-cpp:install-event',
  appUpdateStatus: 'app-update:status',
  appUpdateCheck: 'app-update:check',
  appUpdateInstall: 'app-update:install',
  appUpdateEvent: 'app-update:event',
} as const;

export interface TilemapGeneratorApi {
  projects: {
    chooseStorageDirectory(): Promise<string | null>;
    create(input: CreateProjectInput, storageDirectory: string): Promise<ProjectInfo>;
    open(): Promise<ProjectInfo | null>;
    openRecent(rootPath: string): Promise<ProjectInfo>;
    current(): Promise<ProjectInfo | null>;
    update(input: UpdateProjectSettingsInput): Promise<ProjectInfo>;
    close(): Promise<void>;
    recents(): Promise<RecentProject[]>;
    removeRecent(rootPath: string): Promise<void>;
    settingsProposals(): Promise<ProjectSettingsProposal[]>;
    reviewSettingsProposal(input: ReviewProjectSettingsProposalInput): Promise<ProjectSettingsProposal>;
    onChanged(listener: (project: ProjectInfo | null) => void): () => void;
  };
  assets: {
    list(): Promise<AssetSummary[]>;
    get(assetId: string): Promise<AssetDetail | null>;
    review(input: ReviewVersionInput): Promise<AssetDetail>;
    undoApproval(versionId: string): Promise<AssetDetail>;
    undoRejection(versionId: string): Promise<AssetDetail>;
  };
  references: {
    list(): Promise<ProjectReference[]>;
    add(input: AddProjectReferenceInput): Promise<ProjectReference | null>;
    update(input: UpdateProjectReferenceInput): Promise<ProjectReference>;
    remove(referenceId: string): Promise<void>;
  };
  generation: {
    enqueue(input: EnqueueGenerationInput): Promise<GenerationJob[]>;
    cancel(jobId: string): Promise<void>;
    retry(jobId: string): Promise<GenerationJob>;
    verify(versionId: string): Promise<AssetDetail>;
    jobs(): Promise<GenerationJob[]>;
    logs(assetId: string): Promise<GenerationLogEntry[]>;
    onEvent(listener: (event: GenerationEvent) => void): () => void;
  };
  style: {
    history(): Promise<StyleSummaryRevision[]>;
    update(input: UpdateStyleInput): Promise<StyleSummaryRevision>;
    restore(revisionId: string): Promise<StyleSummaryRevision>;
    rebuild(): Promise<void>;
  };
  export: {
    listIntegrations(): Promise<ExportIntegrationDescriptor[]>;
    chooseTarget(integration: ExportIntegration): Promise<string | null>;
    preview(input: ExportPreviewInput): Promise<ExportPreview>;
    run(token: string): Promise<ExportRunResult>;
  };
  codex: {
    health(): Promise<CodexHealth>;
    refresh(): Promise<CodexHealth>;
  };
  comfy: {
    health(): Promise<ComfyUiHealth>;
    refresh(): Promise<ComfyUiHealth>;
  };
  stableDiffusionCpp: {
    health(): Promise<StableDiffusionCppHealth>;
    refresh(): Promise<StableDiffusionCppHealth>;
    setup(): Promise<StableDiffusionCppSetupInfo>;
    install(modelId: StableDiffusionCppModelId): Promise<StableDiffusionCppSetupInfo>;
    selectModel(modelId: StableDiffusionCppModelId): Promise<StableDiffusionCppSetupInfo>;
    cancelInstall(): Promise<void>;
    onInstallEvent(listener: (event: StableDiffusionCppInstallEvent) => void): () => void;
  };
  updates: {
    status(): Promise<AppUpdateState>;
    check(): Promise<AppUpdateState>;
    install(): Promise<void>;
    onState(listener: (state: AppUpdateState) => void): () => void;
  };
}
