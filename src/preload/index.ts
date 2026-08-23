import { contextBridge, ipcRenderer } from 'electron';
import { ipcChannels, type TilemapGeneratorApi } from '../shared/bridge';
import type { GenerationEvent } from '../shared/domain';

const api: TilemapGeneratorApi = {
  projects: {
    chooseStorageDirectory: () => ipcRenderer.invoke(ipcChannels.projectChooseStorage),
    create: (input, storageDirectory) => ipcRenderer.invoke(
      ipcChannels.projectCreate,
      { input, storageDirectory },
    ),
    open: () => ipcRenderer.invoke(ipcChannels.projectOpen),
    openRecent: (rootPath) => ipcRenderer.invoke(ipcChannels.projectOpenRecent, rootPath),
    current: () => ipcRenderer.invoke(ipcChannels.projectCurrent),
    update: (input) => ipcRenderer.invoke(ipcChannels.projectUpdate, input),
    close: () => ipcRenderer.invoke(ipcChannels.projectClose),
    recents: () => ipcRenderer.invoke(ipcChannels.projectRecents),
    removeRecent: (rootPath) => ipcRenderer.invoke(ipcChannels.projectRemoveRecent, rootPath),
    settingsProposals: () => ipcRenderer.invoke(ipcChannels.projectSettingsProposals),
    reviewSettingsProposal: (input) => ipcRenderer.invoke(ipcChannels.projectSettingsProposalReview, input),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, project: Parameters<typeof listener>[0]) => listener(project);
      ipcRenderer.on(ipcChannels.projectChanged, handler);
      return () => ipcRenderer.removeListener(ipcChannels.projectChanged, handler);
    },
  },
  assets: {
    list: () => ipcRenderer.invoke(ipcChannels.assetsList),
    get: (assetId) => ipcRenderer.invoke(ipcChannels.assetsGet, assetId),
    review: (input) => ipcRenderer.invoke(ipcChannels.assetsReview, input),
    undoApproval: (versionId) => ipcRenderer.invoke(ipcChannels.assetsUndoApproval, versionId),
    undoRejection: (versionId) => ipcRenderer.invoke(ipcChannels.assetsUndoRejection, versionId),
  },
  references: {
    list: () => ipcRenderer.invoke(ipcChannels.referencesList),
    add: (input) => ipcRenderer.invoke(ipcChannels.referencesAdd, input),
    update: (input) => ipcRenderer.invoke(ipcChannels.referencesUpdate, input),
    remove: (referenceId) => ipcRenderer.invoke(ipcChannels.referencesRemove, referenceId),
  },
  generation: {
    enqueue: (input) => ipcRenderer.invoke(ipcChannels.generationEnqueue, input),
    cancel: (jobId) => ipcRenderer.invoke(ipcChannels.generationCancel, jobId),
    retry: (jobId) => ipcRenderer.invoke(ipcChannels.generationRetry, jobId),
    verify: (versionId) => ipcRenderer.invoke(ipcChannels.generationVerify, versionId),
    jobs: () => ipcRenderer.invoke(ipcChannels.generationJobs),
    logs: (assetId) => ipcRenderer.invoke(ipcChannels.generationLogs, assetId),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: GenerationEvent) => listener(payload);
      ipcRenderer.on(ipcChannels.generationEvent, handler);
      return () => ipcRenderer.removeListener(ipcChannels.generationEvent, handler);
    },
  },
  style: {
    history: () => ipcRenderer.invoke(ipcChannels.styleHistory),
    update: (input) => ipcRenderer.invoke(ipcChannels.styleUpdate, input),
    restore: (revisionId) => ipcRenderer.invoke(ipcChannels.styleRestore, revisionId),
    rebuild: () => ipcRenderer.invoke(ipcChannels.styleRebuild),
  },
  export: {
    listIntegrations: () => ipcRenderer.invoke(ipcChannels.exportIntegrations),
    chooseTarget: (integration) => ipcRenderer.invoke(ipcChannels.exportChooseTarget, integration),
    preview: (input) => ipcRenderer.invoke(ipcChannels.exportPreview, input),
    run: (token) => ipcRenderer.invoke(ipcChannels.exportRun, token),
  },
  codex: {
    health: () => ipcRenderer.invoke(ipcChannels.codexHealth),
    refresh: () => ipcRenderer.invoke(ipcChannels.codexRefresh),
  },
  comfy: {
    health: () => ipcRenderer.invoke(ipcChannels.comfyHealth),
    refresh: () => ipcRenderer.invoke(ipcChannels.comfyRefresh),
  },
  stableDiffusionCpp: {
    health: () => ipcRenderer.invoke(ipcChannels.stableDiffusionCppHealth),
    refresh: () => ipcRenderer.invoke(ipcChannels.stableDiffusionCppRefresh),
    setup: () => ipcRenderer.invoke(ipcChannels.stableDiffusionCppSetup),
    install: (modelId) => ipcRenderer.invoke(ipcChannels.stableDiffusionCppInstall, { modelId }),
    selectModel: (modelId) => ipcRenderer.invoke(ipcChannels.stableDiffusionCppSelectModel, modelId),
    cancelInstall: () => ipcRenderer.invoke(ipcChannels.stableDiffusionCppCancelInstall),
    onInstallEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
      ipcRenderer.on(ipcChannels.stableDiffusionCppInstallEvent, handler);
      return () => ipcRenderer.removeListener(ipcChannels.stableDiffusionCppInstallEvent, handler);
    },
  },
  updates: {
    status: () => ipcRenderer.invoke(ipcChannels.appUpdateStatus),
    check: () => ipcRenderer.invoke(ipcChannels.appUpdateCheck),
    install: () => ipcRenderer.invoke(ipcChannels.appUpdateInstall),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
      ipcRenderer.on(ipcChannels.appUpdateEvent, handler);
      return () => ipcRenderer.removeListener(ipcChannels.appUpdateEvent, handler);
    },
  },
};

contextBridge.exposeInMainWorld('tilemap', api);
