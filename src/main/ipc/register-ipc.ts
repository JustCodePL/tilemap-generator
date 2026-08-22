import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import {
  addProjectReferenceSchema,
  createProjectSchema,
  enqueueGenerationSchema,
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
import { CodexService } from '../codex/codex-service';
import { ComfyService } from '../comfy/comfy-service';
import { StableDiffusionCppService } from '../stable-diffusion/stable-diffusion-cpp-service';
import { GenerationQueue } from '../services/generation-queue';
import { ProjectManager } from '../services/project-manager';
import { UnityExporter } from '../services/unity-exporter';
import type { Logger } from '../services/app-logger';

const uuidSchema = z.string().uuid();
const projectPathSchema = z.string().trim().min(1).max(32_767);

export function registerIpc(mainWindow: BrowserWindow, projects: ProjectManager, logger: Logger): () => Promise<void> {
  const codex = new CodexService(logger);
  const comfy = new ComfyService(logger);
  const stableDiffusionCpp = new StableDiffusionCppService(logger);
  const queue = new GenerationQueue(codex, logger, comfy, stableDiffusionCpp);
  const exporter = new UnityExporter();

  queue.on('event', (event) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.generationEvent, event);
  });
  stableDiffusionCpp.on('install-event', (event) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.stableDiffusionCppInstallEvent, event);
  });

  const register = <T>(channel: string, handler: (payload: T) => unknown | Promise<unknown>) => {
    ipcMain.handle(channel, async (event, payload: T) => {
      validateSender(mainWindow, event.sender.id, event.senderFrame?.url ?? '');
      return handler(payload);
    });
  };

  const activate = async () => {
    const database = requireProject(projects);
    await Promise.all([codex.connect(database), comfy.refresh(), stableDiffusionCpp.refresh()]);
    queue.attach(database);
  };

  register(ipcChannels.projectCreate, async (payload) => {
    const database = await projects.create(createProjectSchema.parse(payload));
    if (!database) return null;
    await activate();
    return database.getProject();
  });
  register(ipcChannels.projectOpen, async () => {
    const database = await projects.openDialog();
    if (!database) return null;
    await activate();
    return database.getProject();
  });
  register(ipcChannels.projectOpenRecent, async (payload) => {
    const database = projects.open(projectPathSchema.parse(payload));
    await activate();
    return database.getProject();
  });
  register(ipcChannels.projectCurrent, () => projects.current?.getProject() ?? null);
  register(ipcChannels.projectUpdate, (payload) => {
    const updated = projects.update(updateProjectSettingsSchema.parse(payload));
    queue.setMaxConcurrentJobs(updated.maxConcurrentJobs);
    return updated;
  });
  register(ipcChannels.projectClose, async () => {
    await queue.shutdown();
    await codex.disconnect();
    projects.close();
  });
  register(ipcChannels.projectRecents, () => projects.recents());
  register(ipcChannels.projectRemoveRecent, (payload) => projects.removeRecent(projectPathSchema.parse(payload)));
  register(ipcChannels.projectSettingsProposals, () => (
    requireProject(projects).listProjectSettingsProposals()
  ));
  register(ipcChannels.projectSettingsProposalReview, (payload) => {
    const input = reviewProjectSettingsProposalSchema.parse(payload);
    return requireProject(projects).reviewProjectSettingsProposal(input.proposalId, input.decision);
  });

  register(ipcChannels.assetsList, () => requireProject(projects).listAssets());
  register(ipcChannels.assetsGet, (payload) => requireProject(projects).getAsset(uuidSchema.parse(payload)));
  register(ipcChannels.assetsReview, (payload) => {
    const input = reviewVersionSchema.parse(payload);
    const database = requireProject(projects);
    const detail = database.reviewVersion(input);
    if (input.decision === 'approved') void queue.updateStyleAfterApproval(detail.id, input.versionId);
    return detail;
  });
  register(ipcChannels.assetsUndoApproval, (payload) => (
    requireProject(projects).undoApproval(uuidSchema.parse(payload))
  ));
  register(ipcChannels.assetsUndoRejection, (payload) => (
    requireProject(projects).undoRejection(uuidSchema.parse(payload))
  ));

  register(ipcChannels.referencesList, () => requireProject(projects).listProjectReferences());
  register(ipcChannels.referencesAdd, async (payload) => {
    const input = addProjectReferenceSchema.parse(payload);
    const sourcePath = await projects.chooseReferenceImage();
    return sourcePath ? requireProject(projects).addProjectReference(sourcePath, input.description) : null;
  });
  register(ipcChannels.referencesUpdate, (payload) => {
    const input = updateProjectReferenceSchema.parse(payload);
    return requireProject(projects).updateProjectReference(input.referenceId, input.description);
  });
  register(ipcChannels.referencesRemove, (payload) => (
    requireProject(projects).removeProjectReference(uuidSchema.parse(payload))
  ));

  register(ipcChannels.generationEnqueue, (payload) => {
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
  register(ipcChannels.generationCancel, (payload) => queue.cancel(uuidSchema.parse(payload)));
  register(ipcChannels.generationRetry, (payload) => queue.retry(uuidSchema.parse(payload)));
  register(ipcChannels.generationVerify, (payload) => queue.verify(uuidSchema.parse(payload)));
  register(ipcChannels.generationJobs, () => queue.jobs());
  register(ipcChannels.generationLogs, (payload) => queue.logs(uuidSchema.parse(payload)));

  register(ipcChannels.styleHistory, () => requireProject(projects).getStyleHistory());
  register(ipcChannels.styleUpdate, (payload) => {
    const input = updateStyleSchema.parse(payload);
    return requireProject(projects).addStyleRevision(input.summary, 'manual');
  });
  register(ipcChannels.styleRestore, (payload) => requireProject(projects).restoreStyleRevision(uuidSchema.parse(payload)));
  register(ipcChannels.styleRebuild, () => queue.rebuildStyle());

  register(ipcChannels.exportChooseTarget, () => projects.chooseUnityAssetsDirectory());
  register(ipcChannels.exportPreview, (payload) => {
    const input = exportPreviewSchema.parse(payload);
    return exporter.preview(requireProject(projects), input, (candidate) => projects.isGrantedDirectory(candidate));
  });
  register(ipcChannels.exportRun, (payload) => exporter.run(requireProject(projects), uuidSchema.parse(payload)));

  register(ipcChannels.codexHealth, () => codex.health());
  register(ipcChannels.codexRefresh, async () => codex.connect(requireProject(projects)));
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

  return async () => {
    await queue.shutdown();
    stableDiffusionCpp.cancelInstall();
    await codex.disconnect();
    projects.close();
    for (const channel of Object.values(ipcChannels)) {
      if (channel !== ipcChannels.generationEvent && channel !== ipcChannels.stableDiffusionCppInstallEvent) {
        ipcMain.removeHandler(channel);
      }
    }
  };
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
