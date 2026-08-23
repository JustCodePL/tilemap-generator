import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import {
  addProjectReferenceSchema,
  createProjectSchema,
  enqueueGenerationSchema,
  exportIntegrationSchema,
  exportPreviewSchema,
  installStableDiffusionCppSchema,
  reviewProjectSettingsProposalSchema,
  reviewVersionSchema,
  updateProjectReferenceSchema,
  updateProjectSettingsSchema,
  updateStyleSchema,
  stableDiffusionCppModelIdSchema,
} from '../../shared/domain';
import { ipcChannels } from '../../shared/bridge';
import { tilemapMcpScopes } from '../../shared/mcp';
import { CodexService } from '../codex/codex-service';
import { ComfyService } from '../comfy/comfy-service';
import {
  LocalBridgeRequestError,
  LocalBridgeServer,
} from '../mcp/local-bridge-server';
import {
  TilemapMcpBackendService,
  type TilemapMcpProjectGateway,
  type TilemapMcpProjectRuntime,
} from '../mcp/tilemap-mcp-backend-service';
import { StableDiffusionCppService } from '../stable-diffusion/stable-diffusion-cpp-service';
import { GenerationQueue } from '../services/generation-queue';
import { ExportService } from '../services/export-service';
import { ProjectManager } from '../services/project-manager';
import { createElectronAutoUpdateAdapter } from '../services/electron-auto-update-adapter';
import { UpdateService } from '../services/update-service';
import type { Logger } from '../services/app-logger';
import type { ProjectDatabase } from '../db/project-database';

const uuidSchema = z.string().uuid();
const projectPathSchema = z.string().trim().min(1).max(32_767);
const createProjectRequestSchema = z.object({
  input: z.unknown(),
  storageDirectory: projectPathSchema,
});

export async function registerIpc(
  mainWindow: BrowserWindow,
  projects: ProjectManager,
  logger: Logger,
  userDataPath: string,
): Promise<() => Promise<void>> {
  const codex = new CodexService(logger);
  const comfy = new ComfyService(logger);
  const stableDiffusionCpp = new StableDiffusionCppService(logger);
  const queue = new GenerationQueue(codex, logger, comfy, stableDiffusionCpp);
  const exporter = new ExportService();
  const updates = new UpdateService({
    adapter: createElectronAutoUpdateAdapter(),
    platform: process.platform,
    architecture: process.arch,
    packaged: app.isPackaged,
    version: app.getVersion(),
    logger,
  });
  let transitionTail: Promise<void> = Promise.resolve();
  let shuttingDown = false;
  const activeIpcOperations = new Set<Promise<unknown>>();

  queue.on('event', (event) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.generationEvent, event);
  });
  stableDiffusionCpp.on('install-event', (event) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.stableDiffusionCppInstallEvent, event);
  });
  const unsubscribeUpdates = updates.onState((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.appUpdateEvent, state);
  });

  const register = <T>(channel: string, handler: (payload: T) => unknown | Promise<unknown>) => {
    ipcMain.handle(channel, async (event, payload: T) => {
      validateSender(mainWindow, event.sender.id, event.senderFrame?.url ?? '');
      if (shuttingDown) throw new Error('Aplikacja jest zamykana.');
      const operation = Promise.resolve().then(() => handler(payload));
      activeIpcOperations.add(operation);
      try {
        return await operation;
      } finally {
        activeIpcOperations.delete(operation);
      }
    });
  };

  const activate = async () => {
    const database = requireProject(projects);
    await Promise.all([codex.connect(database), comfy.refresh(), stableDiffusionCpp.refresh()]);
    queue.attach(database);
  };

  const withProjectTransition = <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (shuttingDown) return Promise.reject(new Error('Aplikacja jest zamykana.'));
    const result = transitionTail.then(operation, operation);
    transitionTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const registerSerialized = <T>(
    channel: string,
    handler: (payload: T) => unknown | Promise<unknown>,
  ) => register(channel, (payload: T) => withProjectTransition(() => handler(payload)));

  const stopCurrentProject = async () => {
    await queue.shutdown();
    await codex.disconnect();
  };

  const notifyExternalProjectChange = () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(ipcChannels.projectChanged, projects.current?.getProject() ?? null);
    }
  };

  const currentMcpRuntime = (): TilemapMcpProjectRuntime | null => {
    const database = projects.current;
    return database && queue.isAttachedTo(database)
      ? { database, generationQueue: queue }
      : null;
  };

  const restorePreviousProject = async (
    previous: ProjectDatabase | null,
    previousRootPath: string | null,
  ): Promise<boolean> => {
    try {
      if (!previousRootPath) {
        projects.close();
        return true;
      }
      if (projects.current !== previous) {
        projects.close();
        projects.open(previousRootPath);
      }
      await activate();
      return true;
    } catch (error) {
      projects.close();
      logger.error('project.transition.rollback-failed', safeErrorDetails(error));
      return false;
    }
  };

  const switchProject = async (
    open: () => ProjectDatabase | null | Promise<ProjectDatabase | null>,
    notifyRenderer: boolean,
  ): Promise<ProjectDatabase | null> => {
    const previous = projects.current;
    const previousRootPath = previous?.rootPath ?? null;
    await stopCurrentProject();
    try {
      const database = await open();
      if (!database) {
        await restorePreviousProject(previous, previousRootPath);
        if (notifyRenderer) notifyExternalProjectChange();
        return null;
      }
      await activate();
      if (notifyRenderer) notifyExternalProjectChange();
      return database;
    } catch (error) {
      const restored = await restorePreviousProject(previous, previousRootPath);
      if (notifyRenderer || !restored) notifyExternalProjectChange();
      throw error;
    }
  };

  const mcpGateway: TilemapMcpProjectGateway = {
    listProjectDescriptors: () => projects.availableProjects().map((project) => ({
      projectId: project.projectId,
      name: project.name,
      ...(project.openedAt ? { openedAt: project.openedAt } : {}),
      active: project.active,
    })),
    activateProject: async (projectId) => {
      const current = projects.current;
      if (current?.getProject().id === projectId && queue.isAttachedTo(current)) {
        return { database: current, generationQueue: queue };
      }
      const database = await switchProject(() => projects.openAvailableProject(projectId), true);
      if (!database) throw new Error('Nie udało się aktywować projektu dla MCP.');
      return { database, generationQueue: queue };
    },
    getActiveRuntime: () => currentMcpRuntime(),
  };

  const mcpBridge = process.platform === 'win32'
    ? null
    : new LocalBridgeServer(path.join(userDataPath, 'mcp'), async () => {
      const backend = new TilemapMcpBackendService(mcpGateway, tilemapMcpScopes);
      return {
        handleRequest: (method, params) => withProjectTransition(async () => {
          try {
            return await backend.call(method, params);
          } catch (error) {
            throw new LocalBridgeRequestError(-32010, publicMcpErrorMessage(error));
          }
        }),
      };
    }, { requestTimeoutMs: 150_000 });

  if (mcpBridge) {
    try {
      const endpoint = await mcpBridge.start();
      logger.info('mcp.bridge.ready', {
        protocolVersion: endpoint.protocolVersion,
        platform: process.platform,
      });
    } catch (error) {
      logger.error('mcp.bridge.start-failed', safeErrorDetails(error));
    }
  }

  register(ipcChannels.projectChooseStorage, () => projects.chooseStorageDirectory());
  register(ipcChannels.projectCreate, async (payload) => {
    const request = createProjectRequestSchema.parse(payload);
    const input = createProjectSchema.parse(request.input);
    return withProjectTransition(async () => {
      const database = await switchProject(
        () => projects.create(input, request.storageDirectory),
        false,
      );
      if (!database) throw new Error('Nie udało się utworzyć projektu.');
      return database.getProject();
    });
  });
  register(ipcChannels.projectOpen, () => withProjectTransition(async () => {
    const database = await switchProject(() => projects.openDialog(), false);
    return database?.getProject() ?? null;
  }));
  register(ipcChannels.projectOpenRecent, (payload) => {
    const rootPath = projectPathSchema.parse(payload);
    return withProjectTransition(async () => {
      const database = await switchProject(() => projects.open(rootPath), false);
      if (!database) throw new Error('Nie udało się otworzyć projektu.');
      return database.getProject();
    });
  });
  registerSerialized(ipcChannels.projectCurrent, () => projects.current?.getProject() ?? null);
  registerSerialized(ipcChannels.projectUpdate, (payload) => {
    const updated = projects.update(updateProjectSettingsSchema.parse(payload));
    queue.setMaxConcurrentJobs(updated.maxConcurrentJobs);
    return updated;
  });
  register(ipcChannels.projectClose, () => withProjectTransition(async () => {
    await stopCurrentProject();
    projects.close();
  }));
  registerSerialized(ipcChannels.projectRecents, () => projects.recents());
  registerSerialized(ipcChannels.projectRemoveRecent, (payload) => projects.removeRecent(projectPathSchema.parse(payload)));
  registerSerialized(ipcChannels.projectSettingsProposals, () => (
    requireProject(projects).listProjectSettingsProposals()
  ));
  registerSerialized(ipcChannels.projectSettingsProposalReview, (payload) => {
    const input = reviewProjectSettingsProposalSchema.parse(payload);
    return requireProject(projects).reviewProjectSettingsProposal(input.proposalId, input.decision);
  });

  registerSerialized(ipcChannels.assetsList, () => requireProject(projects).listAssets());
  registerSerialized(ipcChannels.assetsGet, (payload) => requireProject(projects).getAsset(uuidSchema.parse(payload)));
  registerSerialized(ipcChannels.assetsReview, (payload) => {
    const input = reviewVersionSchema.parse(payload);
    const database = requireProject(projects);
    const detail = database.reviewVersion(input);
    if (input.decision === 'approved') void queue.updateStyleAfterApproval(detail.id, input.versionId);
    return detail;
  });
  registerSerialized(ipcChannels.assetsUndoApproval, (payload) => (
    requireProject(projects).undoApproval(uuidSchema.parse(payload))
  ));
  registerSerialized(ipcChannels.assetsUndoRejection, (payload) => (
    requireProject(projects).undoRejection(uuidSchema.parse(payload))
  ));

  registerSerialized(ipcChannels.referencesList, () => requireProject(projects).listProjectReferences());
  registerSerialized(ipcChannels.referencesAdd, async (payload) => {
    const input = addProjectReferenceSchema.parse(payload);
    const sourcePath = await projects.chooseReferenceImage();
    return sourcePath ? requireProject(projects).addProjectReference(sourcePath, input.description) : null;
  });
  registerSerialized(ipcChannels.referencesUpdate, (payload) => {
    const input = updateProjectReferenceSchema.parse(payload);
    return requireProject(projects).updateProjectReference(input.referenceId, input.description);
  });
  registerSerialized(ipcChannels.referencesRemove, (payload) => (
    requireProject(projects).removeProjectReference(uuidSchema.parse(payload))
  ));

  registerSerialized(ipcChannels.generationEnqueue, (payload) => {
    const input = enqueueGenerationSchema.parse(payload);
    const jobs = queue.enqueueEnabled(input);
    logger.info('generation.enqueued', {
      assetId: jobs[0]?.assetId ?? input.assetId ?? null,
      versionIds: jobs.map((job) => job.versionId),
      category: input.category ?? null,
      relativeWidth: input.relativeWidth ?? null,
      relativeHeight: input.relativeHeight ?? null,
      footprint: input.footprint,
      providers: jobs.map((job) => job.generatorProvider),
    });
    return jobs;
  });
  registerSerialized(ipcChannels.generationCancel, (payload) => queue.cancel(uuidSchema.parse(payload)));
  registerSerialized(ipcChannels.generationRetry, (payload) => queue.retry(uuidSchema.parse(payload)));
  registerSerialized(ipcChannels.generationVerify, (payload) => queue.verify(uuidSchema.parse(payload)));
  registerSerialized(ipcChannels.generationJobs, () => queue.jobs());
  registerSerialized(ipcChannels.generationLogs, (payload) => queue.logs(uuidSchema.parse(payload)));

  registerSerialized(ipcChannels.styleHistory, () => requireProject(projects).getStyleHistory());
  registerSerialized(ipcChannels.styleUpdate, (payload) => {
    const input = updateStyleSchema.parse(payload);
    return requireProject(projects).addStyleRevision(input.summary, 'manual');
  });
  registerSerialized(ipcChannels.styleRestore, (payload) => requireProject(projects).restoreStyleRevision(uuidSchema.parse(payload)));
  registerSerialized(ipcChannels.styleRebuild, () => queue.rebuildStyle());

  register(ipcChannels.exportIntegrations, () => exporter.listIntegrations());
  registerSerialized(ipcChannels.exportChooseTarget, (payload) => (
    exporter.chooseTarget(requireProject(projects), exportIntegrationSchema.parse(payload))
  ));
  registerSerialized(ipcChannels.exportPreview, (payload) => {
    const input = exportPreviewSchema.parse(payload);
    return exporter.preview(requireProject(projects), input);
  });
  registerSerialized(ipcChannels.exportRun, (payload) => exporter.run(requireProject(projects), uuidSchema.parse(payload)));

  register(ipcChannels.codexHealth, () => codex.health());
  registerSerialized(ipcChannels.codexRefresh, async () => codex.connect(requireProject(projects)));
  register(ipcChannels.comfyHealth, () => comfy.health());
  register(ipcChannels.comfyRefresh, () => comfy.refresh());
  register(ipcChannels.stableDiffusionCppHealth, () => stableDiffusionCpp.health());
  register(ipcChannels.stableDiffusionCppRefresh, () => stableDiffusionCpp.refresh());
  register(ipcChannels.stableDiffusionCppSetup, () => stableDiffusionCpp.setup());
  register(ipcChannels.stableDiffusionCppInstall, (payload) => (
    stableDiffusionCpp.install(installStableDiffusionCppSchema.parse(payload).modelId)
  ));
  register(ipcChannels.stableDiffusionCppSelectModel, (payload) => (
    stableDiffusionCpp.selectModel(stableDiffusionCppModelIdSchema.parse(payload))
  ));
  register(ipcChannels.stableDiffusionCppCancelInstall, () => stableDiffusionCpp.cancelInstall());
  register(ipcChannels.appUpdateStatus, () => updates.status());
  register(ipcChannels.appUpdateCheck, () => updates.check());
  register(ipcChannels.appUpdateInstall, () => updates.install());

  void updates.start();

  return async () => {
    shuttingDown = true;
    unsubscribeUpdates();
    updates.stop();
    stableDiffusionCpp.cancelInstall();
    await mcpBridge?.stop();
    await Promise.allSettled([...activeIpcOperations]);
    await transitionTail;
    await stopCurrentProject();
    projects.close();
    for (const channel of Object.values(ipcChannels)) {
      if (channel !== ipcChannels.generationEvent
        && channel !== ipcChannels.stableDiffusionCppInstallEvent
        && channel !== ipcChannels.appUpdateEvent
        && channel !== ipcChannels.projectChanged) {
        ipcMain.removeHandler(channel);
      }
    }
  };
}

function publicMcpErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Nieprawidłowe dane narzędzia: ${error.issues.map((issue) => (
      `${issue.path.join('.') || 'input'}: ${issue.message}`
    )).join('; ')}`;
  }
  return error instanceof Error ? error.message : 'Operacja MCP nie powiodła się.';
}

function safeErrorDetails(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };
}

function requireProject(projects: ProjectManager) {
  if (!projects.current) throw new Error('Najpierw otwórz projekt.');
  return projects.current;
}

function validateSender(window: BrowserWindow, senderId: number, senderUrl: string): void {
  if (senderId !== window.webContents.id) throw new Error('Odrzucono IPC z obcego renderera.');
  const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  if (devUrl) {
    if (new URL(senderUrl).origin !== new URL(devUrl).origin) throw new Error('Odrzucono IPC z nieznanego originu.');
  } else if (!senderUrl.startsWith('file://')) {
    throw new Error('Odrzucono IPC spoza spakowanej aplikacji.');
  }
}
