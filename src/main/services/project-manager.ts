import { app, dialog } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  projectProjectionSchema,
  type CreateProjectInput,
  type ProjectProjection,
  type RecentProject,
  type UpdateProjectSettingsInput,
} from '../../shared/domain';
import { ProjectDatabase } from '../db/project-database';

interface SettingsFile {
  recentProjects: RecentProject[];
}

const projectManifestSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  projection: projectProjectionSchema,
  database: z.literal('registry.sqlite'),
}).passthrough();

export interface AvailableProject {
  projectId: string;
  name: string;
  projection: ProjectProjection;
  rootPath: string;
  openedAt: string | null;
  active: boolean;
}

export class ProjectManager {
  private database: ProjectDatabase | null = null;
  private readonly grantedStorageDirectories = new Set<string>();

  get current(): ProjectDatabase | null {
    return this.database;
  }

  async chooseStorageDirectory(): Promise<string | null> {
    const selection = await dialog.showOpenDialog({
      title: 'Wybierz katalog biblioteki assetów',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Wybierz katalog',
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const storageDirectory = path.resolve(selection.filePaths[0]);
    if (!existsSync(storageDirectory) || !statSync(storageDirectory).isDirectory()) {
      throw new Error(`Katalog biblioteki nie istnieje: ${storageDirectory}`);
    }
    if (readdirSync(storageDirectory).length > 0) {
      throw new Error(`Katalog biblioteki ${storageDirectory} nie jest pusty.`);
    }
    this.grantedStorageDirectories.add(storageDirectory);
    return storageDirectory;
  }

  create(input: CreateProjectInput, storageDirectory: string): ProjectDatabase {
    const rootPath = path.resolve(storageDirectory);
    if (!this.grantedStorageDirectories.has(rootPath)) {
      throw new Error('Katalog biblioteki nie został wybrany przez dialog aplikacji.');
    }
    if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
      throw new Error(`Katalog biblioteki nie istnieje: ${rootPath}`);
    }
    if (readdirSync(rootPath).length > 0) {
      throw new Error(`Katalog biblioteki ${rootPath} nie jest pusty.`);
    }
    this.close();
    this.database = ProjectDatabase.create(rootPath, input);
    this.grantedStorageDirectories.delete(rootPath);
    this.addRecent(this.database.getProject().name, rootPath);
    return this.database;
  }

  async openDialog(): Promise<ProjectDatabase | null> {
    const selection = await dialog.showOpenDialog({
      title: 'Otwórz projekt Tilemap Generator',
      properties: ['openDirectory'],
      buttonLabel: 'Otwórz projekt',
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return this.open(selection.filePaths[0]);
  }

  open(rootPath: string): ProjectDatabase {
    const resolvedRoot = path.resolve(rootPath);
    if (!existsSync(resolvedRoot)) {
      throw new Error(`Projekt nie istnieje: ${resolvedRoot}`);
    }
    if (!existsSync(path.join(resolvedRoot, 'tilemap-project.json'))
      || !existsSync(path.join(resolvedRoot, 'registry.sqlite'))) {
      throw new Error(`Katalog nie zawiera kompletnego projektu Tilemap Generator: ${resolvedRoot}`);
    }
    this.close();
    this.database = new ProjectDatabase(resolvedRoot);
    const project = this.database.getProject();
    this.addRecent(project.name, resolvedRoot);
    return this.database;
  }

  update(input: UpdateProjectSettingsInput) {
    if (!this.database) throw new Error('Najpierw otwórz projekt.');
    const project = this.database.updateProjectSettings(input);
    this.addRecent(project.name, this.database.rootPath);
    return project;
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  async chooseReferenceImage(): Promise<string | null> {
    const selection = await dialog.showOpenDialog({
      title: 'Wybierz obraz referencyjny',
      properties: ['openFile'],
      buttonLabel: 'Dodaj referencję',
      filters: [{ name: 'Obrazy', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    return selection.canceled ? null : selection.filePaths[0] ?? null;
  }

  recents(): RecentProject[] {
    return this.readSettings().recentProjects;
  }

  availableProjects(): AvailableProject[] {
    const active = this.database?.getProject() ?? null;
    const activeRoot = this.database?.rootPath ?? null;
    const candidates: AvailableProject[] = [];
    if (active && activeRoot) {
      candidates.push({
        projectId: active.id,
        name: active.name,
        projection: active.projection,
        rootPath: activeRoot,
        openedAt: new Date().toISOString(),
        active: true,
      });
    }

    for (const recent of this.recents()) {
      const rootPath = path.resolve(recent.rootPath);
      if (activeRoot && samePath(rootPath, activeRoot)) continue;
      try {
        if (!existsSync(path.join(rootPath, 'registry.sqlite'))) continue;
        const manifest = projectManifestSchema.parse(JSON.parse(
          readFileSync(path.join(rootPath, 'tilemap-project.json'), 'utf8'),
        ));
        candidates.push({
          projectId: manifest.id,
          name: manifest.name,
          projection: manifest.projection,
          rootPath,
          openedAt: recent.openedAt,
          active: false,
        });
      } catch {
        // Stale or malformed recent entries stay visible in the ordinary UI,
        // but are never exposed as projects that an MCP client can activate.
      }
    }

    const seen = new Map<string, string>();
    for (const candidate of candidates) {
      const previousRoot = seen.get(candidate.projectId);
      if (previousRoot && !samePath(previousRoot, candidate.rootPath)) {
        throw new Error(`Identyfikator projektu ${candidate.projectId} występuje w więcej niż jednej bibliotece.`);
      }
      seen.set(candidate.projectId, candidate.rootPath);
    }
    return candidates.sort((left, right) => (
      Number(right.active) - Number(left.active)
      || String(right.openedAt ?? '').localeCompare(String(left.openedAt ?? ''))
      || left.name.localeCompare(right.name, 'pl')
    ));
  }

  openAvailableProject(projectId: string): ProjectDatabase {
    const matches = this.availableProjects().filter((project) => project.projectId === projectId);
    if (matches.length !== 1) {
      throw new Error(matches.length
        ? `Projekt ${projectId} jest niejednoznaczny.`
        : `Projekt ${projectId} nie jest dostępny.`);
    }
    if (matches[0].active && this.database) return this.database;
    const database = this.open(matches[0].rootPath);
    if (database.getProject().id !== projectId) {
      this.close();
      throw new Error('Projekt zmienił identyfikator podczas otwierania.');
    }
    return database;
  }

  removeRecent(rootPath: string): void {
    const settings = this.readSettings();
    const normalized = path.resolve(rootPath).toLocaleLowerCase();
    settings.recentProjects = settings.recentProjects.filter(
      (recent) => path.resolve(recent.rootPath).toLocaleLowerCase() !== normalized,
    );
    this.writeSettings(settings);
  }

  resolveAssetRequest(url: string): string {
    if (!this.database) throw new Error('Brak otwartego projektu.');
    const parsed = new URL(url);
    const relative = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');
    return this.database.resolveRelative(relative);
  }

  private addRecent(name: string, rootPath: string): void {
    const settings = this.readSettings();
    const normalized = path.resolve(rootPath).toLocaleLowerCase();
    settings.recentProjects = [
      { name, rootPath: path.resolve(rootPath), openedAt: new Date().toISOString() },
      ...settings.recentProjects.filter((recent) => recent.rootPath.toLocaleLowerCase() !== normalized),
    ].slice(0, 12);
    this.writeSettings(settings);
  }

  private settingsPath(): string {
    return path.join(app.getPath('userData'), 'settings.json');
  }

  private readSettings(): SettingsFile {
    try {
      return JSON.parse(readFileSync(this.settingsPath(), 'utf8')) as SettingsFile;
    } catch {
      return { recentProjects: [] };
    }
  }

  private writeSettings(settings: SettingsFile): void {
    mkdirSync(path.dirname(this.settingsPath()), { recursive: true });
    writeFileSync(this.settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase();
}

export function slugify(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tilemap-project';
}
