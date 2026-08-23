import { dialog } from 'electron';
import path from 'node:path';
import type {
  ExportIntegration,
  ExportIntegrationDescriptor,
  ExportPreview,
  ExportPreviewInput,
  ExportRunResult,
} from '../../shared/domain';
import type { ProjectDatabase } from '../db/project-database';
import { PhaserExporter } from './phaser-exporter';
import { UnityExporter } from './unity-exporter';

const PREVIEW_TTL_MS = 10 * 60_000;

export interface ExportIntegrationAdapter {
  readonly integration: ExportIntegration;
  readonly descriptor: ExportIntegrationDescriptor;
  readonly targetDialog: { title: string; buttonLabel: string };
  validateTarget(targetDirectory: string): string;
  preview(database: ProjectDatabase, input: ExportPreviewInput): Promise<ExportPreview>;
  run(database: ProjectDatabase, token: string): ExportRunResult;
}

interface PendingRoute {
  projectId: string;
  integration: ExportIntegration;
  createdAt: number;
}

export class ExportService {
  private readonly adapters: Map<ExportIntegration, ExportIntegrationAdapter>;
  private readonly grantedTargets = new Set<string>();
  private readonly pendingRoutes = new Map<string, PendingRoute>();

  constructor(adapters: ExportIntegrationAdapter[] = [new UnityExporter(), new PhaserExporter()]) {
    if (adapters.some((adapter) => adapter.descriptor.id !== adapter.integration)) {
      throw new Error('Id descriptora musi odpowiadać id integracji eksportu.');
    }
    this.adapters = new Map(adapters.map((adapter) => [adapter.integration, adapter]));
    if (this.adapters.size !== adapters.length) {
      throw new Error('Każda integracja eksportu może być zarejestrowana tylko raz.');
    }
  }

  listIntegrations(): ExportIntegrationDescriptor[] {
    return [...this.adapters.values()].map((adapter) => ({ ...adapter.descriptor }));
  }

  async chooseTarget(database: ProjectDatabase, integration: ExportIntegration): Promise<string | null> {
    const adapter = this.requireAdapter(integration);
    const selection = await dialog.showOpenDialog({
      title: adapter.targetDialog.title,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: adapter.targetDialog.buttonLabel,
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const targetDirectory = adapter.validateTarget(selection.filePaths[0]);
    this.grantedTargets.add(grantKey(database.getProject().id, integration, targetDirectory));
    return targetDirectory;
  }

  async preview(database: ProjectDatabase, input: ExportPreviewInput): Promise<ExportPreview> {
    const adapter = this.requireAdapter(input.integration);
    const project = database.getProject();
    const targetDirectory = adapter.validateTarget(input.targetDirectory);
    if (!this.isGranted(project, input.integration, targetDirectory)) {
      throw new Error('Katalog docelowy nie został wybrany przez dialog aplikacji dla tej integracji i projektu.');
    }
    const preview = await adapter.preview(database, { ...input, targetDirectory });
    if (preview.integration !== input.integration) {
      throw new Error('Integracja zwróciła podgląd innego formatu eksportu.');
    }
    this.pendingRoutes.set(preview.token, {
      projectId: project.id,
      integration: input.integration,
      createdAt: Date.now(),
    });
    this.cleanup();
    return preview;
  }

  run(database: ProjectDatabase, token: string): ExportRunResult {
    const route = this.pendingRoutes.get(token);
    if (!route || Date.now() - route.createdAt > PREVIEW_TTL_MS) {
      this.pendingRoutes.delete(token);
      throw new Error('Podgląd eksportu wygasł. Wygeneruj go ponownie.');
    }
    if (route.projectId !== database.getProject().id) {
      this.pendingRoutes.delete(token);
      throw new Error('Podgląd eksportu należy do innego projektu. Przygotuj go ponownie.');
    }
    this.pendingRoutes.delete(token);
    return this.requireAdapter(route.integration).run(database, token);
  }

  private isGranted(
    project: ReturnType<ProjectDatabase['getProject']>,
    integration: ExportIntegration,
    targetDirectory: string,
  ): boolean {
    const savedTarget = project.exportTargets[integration];
    return this.grantedTargets.has(grantKey(project.id, integration, targetDirectory))
      || (savedTarget !== undefined && pathKey(savedTarget) === pathKey(targetDirectory));
  }

  private requireAdapter(integration: ExportIntegration): ExportIntegrationAdapter {
    const adapter = this.adapters.get(integration);
    if (!adapter) throw new Error(`Nieobsługiwana integracja eksportu: ${integration}.`);
    return adapter;
  }

  private cleanup(): void {
    const cutoff = Date.now() - PREVIEW_TTL_MS;
    for (const [token, route] of this.pendingRoutes) {
      if (route.createdAt < cutoff) this.pendingRoutes.delete(token);
    }
  }
}

function grantKey(projectId: string, integration: ExportIntegration, targetDirectory: string): string {
  return JSON.stringify([projectId, integration, pathKey(targetDirectory)]);
}

function pathKey(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}
