import { app, dialog } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CreateProjectInput, RecentProject, UpdateProjectSettingsInput } from '../../shared/domain';
import { ProjectDatabase } from '../db/project-database';

interface SettingsFile {
  recentProjects: RecentProject[];
}

export class ProjectManager {
  private database: ProjectDatabase | null = null;
  private readonly grantedDirectories = new Set<string>();

  get current(): ProjectDatabase | null {
    return this.database;
  }

  async create(input: CreateProjectInput): Promise<ProjectDatabase | null> {
    const selection = await dialog.showOpenDialog({
      title: 'Wybierz katalog nadrzędny projektu',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Utwórz tutaj',
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const rootPath = path.join(selection.filePaths[0], slugify(input.name));
    if (existsSync(rootPath) && readdirSync(rootPath).length > 0) {
      throw new Error(`Katalog ${rootPath} już istnieje i nie jest pusty.`);
    }
    mkdirSync(rootPath, { recursive: true });
    this.close();
    this.database = ProjectDatabase.create(rootPath, input);
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

  async chooseUnityAssetsDirectory(): Promise<string | null> {
    const selection = await dialog.showOpenDialog({
      title: 'Wybierz katalog Assets projektu Unity',
      properties: ['openDirectory'],
      buttonLabel: 'Wybierz Assets',
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const selected = path.resolve(selection.filePaths[0]);
    if (path.basename(selected).toLocaleLowerCase() !== 'assets') {
      throw new Error('Wybierz bezpośrednio katalog Assets projektu Unity.');
    }
    this.grantedDirectories.add(selected.toLocaleLowerCase());
    return selected;
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

  isGrantedDirectory(directory: string): boolean {
    const resolved = path.resolve(directory).toLocaleLowerCase();
    const saved = this.database?.getProject().unityExportPath?.toLocaleLowerCase();
    return this.grantedDirectories.has(resolved) || saved === resolved;
  }

  recents(): RecentProject[] {
    return this.readSettings().recentProjects;
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

export function slugify(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tilemap-project';
}
