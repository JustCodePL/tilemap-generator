import type { Logger } from './app-logger';
import { nullLogger } from './app-logger';
import {
  type AppUpdateChannel,
  type AppUpdateState,
  type MacUpdateRelease,
  type MacUpdateArchitecture,
  compareTilemapVersions,
  isMacUpdateArchitecture,
  isTilemapReleaseVersion,
  macUpdateManifestUrl,
  parseMacUpdateManifest,
  updateChannelForVersion,
} from '../../shared/update-feed';

export interface DownloadedMacUpdate {
  releaseNotes: string;
  releaseName: string;
  releaseDate: Date;
  updateUrl: string;
}

export interface AutoUpdateAdapterListeners {
  checking(): void;
  available(): void;
  notAvailable(): void;
  downloaded(update: DownloadedMacUpdate): void;
  error(error: Error): void;
}

export interface AutoUpdateAdapter {
  fetchManifest(options: { url: string; headers: Record<string, string> }): Promise<unknown>;
  configure(options: { url: string; serverType: 'default'; headers: Record<string, string> }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  subscribe(listeners: AutoUpdateAdapterListeners): () => void;
}

export interface UpdateServiceOptions {
  adapter: AutoUpdateAdapter;
  platform: string;
  architecture: string;
  packaged: boolean;
  version: string;
  logger?: Logger;
  now?: () => Date;
}

type UpdateStateListener = (state: AppUpdateState) => void;

export class UpdateService {
  private readonly adapter: AutoUpdateAdapter;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly listeners = new Set<UpdateStateListener>();
  private readonly environment: Omit<UpdateServiceOptions, 'adapter' | 'logger' | 'now'>;
  private state: AppUpdateState;
  private unsubscribeAdapter: (() => void) | null = null;
  private configuredUrl: string | null = null;
  private automaticCheckStarted = false;
  private checkingPromise: Promise<AppUpdateState> | null = null;
  private pendingRelease: MacUpdateRelease | null = null;

  constructor(options: UpdateServiceOptions) {
    this.adapter = options.adapter;
    this.logger = options.logger ?? nullLogger;
    this.now = options.now ?? (() => new Date());
    this.environment = {
      platform: options.platform,
      architecture: options.architecture,
      packaged: options.packaged,
      version: options.version,
    };
    this.state = initialState(this.environment);
  }

  status(): AppUpdateState {
    return { ...this.state };
  }

  onState(listener: UpdateStateListener): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  start(): Promise<AppUpdateState> {
    if (!this.state.enabled || this.automaticCheckStarted) return Promise.resolve(this.status());
    this.automaticCheckStarted = true;
    return this.check();
  }

  check(): Promise<AppUpdateState> {
    if (!this.state.enabled) return Promise.resolve(this.status());
    if (this.checkingPromise) return this.checkingPromise;
    if (['checking', 'downloading', 'downloaded', 'installing'].includes(this.state.status)) {
      return Promise.resolve(this.status());
    }

    const operation = this.performCheck().finally(() => {
      if (this.checkingPromise === operation) this.checkingPromise = null;
    });
    this.checkingPromise = operation;
    return operation;
  }

  install(): void {
    if (!this.state.enabled || this.state.status !== 'downloaded') {
      throw new Error('Aktualizacja nie została jeszcze pobrana.');
    }
    this.setState({
      status: 'installing',
      message: 'Zamykanie aplikacji i instalowanie aktualizacji…',
    });
    try {
      this.logger.info('updates.install-started', {
        channel: this.state.channel,
        architecture: this.state.architecture,
        release: this.state.availableVersion,
      });
      this.adapter.quitAndInstall();
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  stop(): void {
    this.unsubscribeAdapter?.();
    this.unsubscribeAdapter = null;
    this.configuredUrl = null;
  }

  private async performCheck(): Promise<AppUpdateState> {
    this.pendingRelease = null;
    this.setState({
      status: 'checking',
      message: 'Sprawdzanie dostępności aktualizacji…',
      availableVersion: null,
      releaseNotes: null,
      releaseDate: null,
    });
    const headers = updateRequestHeaders(this.state);
    this.logger.info('updates.precheck-started', {
      channel: this.state.channel,
      architecture: this.state.architecture,
      version: this.state.currentVersion,
    });

    try {
      const rawManifest = await this.adapter.fetchManifest({
        url: this.state.feedUrl!,
        headers,
      });
      const manifest = parseMacUpdateManifest(
        rawManifest,
        this.state.channel,
        this.state.architecture as MacUpdateArchitecture,
      );
      const release = manifest.releases[0];
      if (compareTilemapVersions(release.version, this.state.currentVersion) <= 0) {
        this.setState({
          status: 'up-to-date',
          message: 'Masz najnowszą wersję w wybranym kanale.',
          checkedAt: this.now().toISOString(),
        });
        this.logger.info('updates.up-to-date', {
          channel: this.state.channel,
          architecture: this.state.architecture,
          version: this.state.currentVersion,
          feedVersion: release.version,
        });
        return this.status();
      }

      this.pendingRelease = release;
      this.setState({
        availableVersion: release.version,
        releaseNotes: cleanText(release.updateTo.notes, 4_000) || null,
        releaseDate: release.updateTo.pub_date,
      });
      if (!this.initializeAdapter(headers, release.updateTo.serverUrl)) return this.status();

      this.adapter.checkForUpdates();
      this.logger.info('updates.check-started', {
        channel: this.state.channel,
        architecture: this.state.architecture,
        version: this.state.currentVersion,
        availableVersion: release.version,
      });
    } catch (error) {
      this.handleError(error);
    }
    return this.status();
  }

  private initializeAdapter(headers: Record<string, string>, serverUrl: string): boolean {
    if (!this.unsubscribeAdapter) {
      this.unsubscribeAdapter = this.adapter.subscribe({
        checking: () => this.setState({
          status: 'checking',
          message: 'Aktualizacja została potwierdzona. Sprawdzanie pakietu instalacyjnego…',
        }),
        available: () => this.setState({
          status: 'downloading',
          message: 'Nowa wersja jest dostępna. Trwa bezpieczne pobieranie…',
        }),
        notAvailable: () => this.handleError(new Error(
          'Feed UPDATE.json nie potwierdził wersji wskazanej przez RELEASES.json.',
        )),
        downloaded: (update) => {
          const release = this.pendingRelease;
          const releaseDate = validIsoDate(update.releaseDate) ?? release?.updateTo.pub_date ?? null;
          this.setState({
            status: 'downloaded',
            message: 'Aktualizacja została pobrana. Uruchom ponownie aplikację, aby ją zainstalować.',
            availableVersion: release?.version ?? (cleanText(update.releaseName, 200) || 'Nowa wersja'),
            releaseNotes: cleanText(update.releaseNotes, 4_000)
              || (release ? cleanText(release.updateTo.notes, 4_000) : '')
              || null,
            releaseDate,
            checkedAt: this.now().toISOString(),
          });
          this.logger.info('updates.downloaded', {
            channel: this.state.channel,
            architecture: this.state.architecture,
            release: this.state.availableVersion,
            updateOrigin: safeOrigin(update.updateUrl),
          });
        },
        error: (error) => this.handleError(error),
      });
    }
    if (this.configuredUrl === serverUrl) return true;

    try {
      this.adapter.configure({
        url: serverUrl,
        serverType: 'default',
        headers,
      });
      this.configuredUrl = serverUrl;
      return true;
    } catch (error) {
      this.handleError(error);
      return false;
    }
  }

  private handleError(error: unknown): void {
    const message = errorMessage(error);
    this.setState({
      status: 'error',
      message: `Nie udało się sprawdzić aktualizacji: ${message}`,
      checkedAt: this.now().toISOString(),
    });
    this.logger.warn('updates.failed', {
      channel: this.state.channel,
      architecture: this.state.architecture,
      message,
    });
  }

  private setState(update: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...update };
    const snapshot = this.status();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function initialState(
  environment: Omit<UpdateServiceOptions, 'adapter' | 'logger' | 'now'>,
): AppUpdateState {
  const channel = safeUpdateChannel(environment.version);
  const base = {
    channel,
    architecture: environment.architecture,
    currentVersion: environment.version,
    availableVersion: null,
    releaseNotes: null,
    releaseDate: null,
    checkedAt: null,
  } as const;
  if (environment.platform !== 'darwin') return {
    ...base,
    enabled: false,
    status: 'disabled',
    feedUrl: null,
    message: 'Automatyczne aktualizacje są dostępne tylko w aplikacji macOS.',
  };
  if (!environment.packaged) return {
    ...base,
    enabled: false,
    status: 'disabled',
    feedUrl: null,
    message: 'Aktualizacje są wyłączone w trybie developerskim.',
  };
  if (!isTilemapReleaseVersion(environment.version)) return {
    ...base,
    enabled: false,
    status: 'disabled',
    feedUrl: null,
    message: `Nieprawidłowa wersja aplikacji: ${environment.version}.`,
  };
  if (!isMacUpdateArchitecture(environment.architecture)) return {
    ...base,
    enabled: false,
    status: 'disabled',
    feedUrl: null,
    message: `Brak feedu aktualizacji dla architektury ${environment.architecture}.`,
  };
  return {
    ...base,
    enabled: true,
    status: 'idle',
    feedUrl: macUpdateManifestUrl(environment.version, environment.architecture),
    message: 'Aktualizacje są gotowe do sprawdzenia.',
  };
}

function safeUpdateChannel(version: string): AppUpdateChannel {
  try {
    return updateChannelForVersion(version);
  } catch {
    return version.includes('-') ? 'beta' : 'stable';
  }
}

function updateRequestHeaders(state: AppUpdateState): Record<string, string> {
  return {
    'Cache-Control': 'no-cache',
    'User-Agent': `Tilemap-Generator/${state.currentVersion} (${state.architecture}; ${state.channel})`,
  };
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return cleanText(value, 500) || 'nieznany błąd';
}

function cleanText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function validIsoDate(value: Date): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
