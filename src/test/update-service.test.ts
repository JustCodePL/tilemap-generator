import { describe, expect, it, vi } from 'vitest';
import type {
  AutoUpdateAdapter,
  AutoUpdateAdapterListeners,
  UpdateServiceOptions,
} from '../main/services/update-service';
import { UpdateService } from '../main/services/update-service';
import {
  compareTilemapVersions,
  macUpdateManifestBaseUrl,
  macUpdateManifestUrl,
  numericAppVersion,
  updateChannelForVersion,
} from '../shared/update-feed';

class FakeUpdateAdapter implements AutoUpdateAdapter {
  readonly fetchManifest = vi.fn(async () => manifestFor('0.2.0-beta.2'));
  readonly configure = vi.fn<AutoUpdateAdapter['configure']>();
  readonly checkForUpdates = vi.fn<AutoUpdateAdapter['checkForUpdates']>();
  readonly quitAndInstall = vi.fn<AutoUpdateAdapter['quitAndInstall']>();
  readonly unsubscribe = vi.fn();
  listeners: AutoUpdateAdapterListeners | null = null;

  readonly subscribe = vi.fn((listeners: AutoUpdateAdapterListeners) => {
    this.listeners = listeners;
    return this.unsubscribe;
  });
}

function createService(
  overrides: Partial<Omit<UpdateServiceOptions, 'adapter'>> = {},
): { adapter: FakeUpdateAdapter; service: UpdateService } {
  const adapter = new FakeUpdateAdapter();
  const service = new UpdateService({
    adapter,
    platform: 'darwin',
    architecture: 'arm64',
    packaged: true,
    version: '0.2.0-beta.1',
    now: () => new Date('2026-08-23T12:00:00.000Z'),
    ...overrides,
  });
  return { adapter, service };
}

function manifestFor(version: string) {
  return {
    currentRelease: version,
    releases: [{
      version,
      updateTo: {
        version,
        name: `Tilemap Generator ${version}`,
        notes: 'Poprawki generatora.',
        pub_date: '2026-08-23T11:00:00.000Z',
        url: `https://github.com/JustCodePL/tilemap-generator/releases/download/v${version}/tilemap-generator-darwin-arm64-${version}.zip`,
        serverUrl: `https://github.com/JustCodePL/tilemap-generator/releases/download/v${version}/tilemap-generator-darwin-arm64-${version}-update.json`,
      },
    }],
  };
}

describe('kontrakt wersji i feedu aktualizacji', () => {
  it('zachowuje pełny SemVer, wyprowadza wersję Apple i porównuje beta/stable', () => {
    expect(updateChannelForVersion('0.2.0-beta.1')).toBe('beta');
    expect(updateChannelForVersion('0.2.0')).toBe('stable');
    expect(numericAppVersion('0.2.0-beta.12')).toBe('0.2.0');
    expect(compareTilemapVersions('0.2.0-beta.2', '0.2.0-beta.1')).toBe(1);
    expect(compareTilemapVersions('0.2.0', '0.2.0-beta.99')).toBe(1);
    expect(compareTilemapVersions('0.1.9', '0.2.0-beta.1')).toBe(-1);
  });

  it('rozdziela manifest precheck od endpointu Squirrel', () => {
    expect(macUpdateManifestBaseUrl('0.2.0-beta.1', 'arm64')).toBe(
      'https://justcodepl.github.io/tilemap-generator/updates/beta/darwin/arm64',
    );
    expect(macUpdateManifestUrl('0.2.0', 'x64')).toBe(
      'https://justcodepl.github.io/tilemap-generator/updates/stable/darwin/x64/RELEASES.json',
    );
  });
});

describe('UpdateService', () => {
  it('robi precheck pełnego SemVer i dopiero dla nowszej wersji uruchamia Squirrel default', async () => {
    const { adapter, service } = createService();

    const state = await service.start();

    expect(adapter.fetchManifest).toHaveBeenCalledWith({
      url: 'https://justcodepl.github.io/tilemap-generator/updates/beta/darwin/arm64/RELEASES.json',
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': 'Tilemap-Generator/0.2.0-beta.1 (arm64; beta)',
      },
    });
    expect(adapter.subscribe).toHaveBeenCalledOnce();
    expect(adapter.configure).toHaveBeenCalledWith({
      url: 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.2.0-beta.2/tilemap-generator-darwin-arm64-0.2.0-beta.2-update.json',
      serverType: 'default',
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': 'Tilemap-Generator/0.2.0-beta.1 (arm64; beta)',
      },
    });
    expect(adapter.checkForUpdates).toHaveBeenCalledOnce();
    expect(state).toMatchObject({ status: 'checking', availableVersion: '0.2.0-beta.2' });

    await service.start();
    await service.check();
    expect(adapter.fetchManifest).toHaveBeenCalledOnce();
    expect(adapter.checkForUpdates).toHaveBeenCalledOnce();
  });

  it.each(['0.2.0-beta.1', '0.1.9'])('oznacza feed %s jako lokalnie aktualny bez dotykania Squirrel', async (feedVersion) => {
    const { adapter, service } = createService();
    adapter.fetchManifest.mockResolvedValue(manifestFor(feedVersion));

    await service.start();

    expect(service.status()).toMatchObject({
      status: 'up-to-date',
      checkedAt: '2026-08-23T12:00:00.000Z',
    });
    expect(adapter.subscribe).not.toHaveBeenCalled();
    expect(adapter.configure).not.toHaveBeenCalled();
    expect(adapter.checkForUpdates).not.toHaveBeenCalled();
  });

  it.each([
    { platform: 'linux', packaged: true, architecture: 'arm64', version: '0.2.0-beta.1' },
    { platform: 'darwin', packaged: false, architecture: 'arm64', version: '0.2.0-beta.1' },
    { platform: 'darwin', packaged: true, architecture: 'ia32', version: '0.2.0-beta.1' },
    { platform: 'darwin', packaged: true, architecture: 'arm64', version: '0.2-beta' },
  ])('nie dotyka sieci dla niewspieranego środowiska: $platform/$architecture/$version', async (environment) => {
    const { adapter, service } = createService(environment);

    expect(await service.start()).toMatchObject({ enabled: false, status: 'disabled', feedUrl: null });
    expect(await service.check()).toMatchObject({ enabled: false, status: 'disabled' });
    expect(adapter.fetchManifest).not.toHaveBeenCalled();
    expect(adapter.subscribe).not.toHaveBeenCalled();
    expect(adapter.configure).not.toHaveBeenCalled();
    expect(adapter.checkForUpdates).not.toHaveBeenCalled();
  });

  it('przechodzi przez pobieranie i pozwala instalować wyłącznie pobrany update', async () => {
    const { adapter, service } = createService();
    expect(() => service.install()).toThrow('Aktualizacja nie została jeszcze pobrana.');
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();

    await service.start();
    adapter.listeners?.available();
    expect(service.status()).toMatchObject({ status: 'downloading' });

    adapter.listeners?.downloaded({
      releaseNotes: ' Poprawki\n generatora. ',
      releaseName: 'Tilemap Generator 0.2.0-beta.2',
      releaseDate: new Date('2026-08-23T11:00:00.000Z'),
      updateUrl: 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.2.0-beta.2/update.zip',
    });
    expect(service.status()).toMatchObject({
      status: 'downloaded',
      availableVersion: '0.2.0-beta.2',
      releaseNotes: 'Poprawki generatora.',
      releaseDate: '2026-08-23T11:00:00.000Z',
      checkedAt: '2026-08-23T12:00:00.000Z',
    });

    service.install();
    expect(adapter.quitAndInstall).toHaveBeenCalledOnce();
    expect(service.status().status).toBe('installing');
  });

  it('zamienia błąd offline prechecku w stan diagnostyczny i pozwala na ręczny retry', async () => {
    const { adapter, service } = createService();
    adapter.fetchManifest.mockRejectedValueOnce(new Error('The network connection was lost'));

    await service.start();
    expect(service.status()).toMatchObject({
      status: 'error',
      message: 'Nie udało się sprawdzić aktualizacji: The network connection was lost',
    });
    expect(adapter.configure).not.toHaveBeenCalled();

    await service.check();
    expect(adapter.fetchManifest).toHaveBeenCalledTimes(2);
    expect(adapter.checkForUpdates).toHaveBeenCalledOnce();
    expect(service.status().status).toBe('checking');
  });

  it.each([
    { label: 'obcy URL', mutate: (manifest: ReturnType<typeof manifestFor>) => { manifest.releases[0].updateTo.url = 'https://example.com/update.zip'; } },
    { label: 'obcy endpoint Squirrel', mutate: (manifest: ReturnType<typeof manifestFor>) => { manifest.releases[0].updateTo.serverUrl = 'https://example.com/update.json'; } },
    { label: 'endpoint innego taga', mutate: (manifest: ReturnType<typeof manifestFor>) => { manifest.releases[0].updateTo.serverUrl = 'https://github.com/JustCodePL/tilemap-generator/releases/download/v9.9.9/tilemap-update.json'; } },
    { label: 'endpoint innej architektury', mutate: (manifest: ReturnType<typeof manifestFor>) => { manifest.releases[0].updateTo.serverUrl = 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.2.0-beta.2/tilemap-generator-darwin-x64-0.2.0-beta.2-update.json'; } },
    { label: 'niespójna wersja', mutate: (manifest: ReturnType<typeof manifestFor>) => { manifest.releases[0].updateTo.version = '0.2.0-beta.3'; } },
    { label: 'brak wydania', mutate: (manifest: ReturnType<typeof manifestFor>) => { manifest.releases = []; } },
  ])('odrzuca niebezpieczny manifest: $label', async ({ mutate }) => {
    const { adapter, service } = createService();
    const manifest = manifestFor('0.2.0-beta.2');
    mutate(manifest);
    adapter.fetchManifest.mockResolvedValue(manifest);

    await service.start();

    expect(service.status().status).toBe('error');
    expect(adapter.subscribe).not.toHaveBeenCalled();
    expect(adapter.configure).not.toHaveBeenCalled();
    expect(adapter.checkForUpdates).not.toHaveBeenCalled();
  });

  it('odrzuca wersję beta w feedzie stable', async () => {
    const { adapter, service } = createService({ version: '0.2.0' });
    adapter.fetchManifest.mockResolvedValue(manifestFor('0.3.0-beta.1'));

    await service.start();

    expect(service.status()).toMatchObject({ status: 'error' });
    expect(adapter.configure).not.toHaveBeenCalled();
  });

  it('obsługuje synchroniczny błąd konfiguracji bez wyjątku i bez requestu Squirrel', async () => {
    const { adapter, service } = createService();
    adapter.configure.mockImplementationOnce(() => { throw new Error('invalid feed'); });

    await expect(service.start()).resolves.toMatchObject({ status: 'error' });
    expect(adapter.checkForUpdates).not.toHaveBeenCalled();
  });

  it('traktuje rozbieżność RELEASES/UPDATE jako błąd zamiast fałszywego up-to-date', async () => {
    const { adapter, service } = createService();
    await service.start();

    adapter.listeners?.notAvailable();

    expect(service.status()).toMatchObject({
      status: 'error',
      message: expect.stringContaining('UPDATE.json nie potwierdził wersji'),
    });
  });

  it('po błędzie konfiguruje ponownie immutable endpoint, gdy manifest wskazuje nowszy release', async () => {
    const { adapter, service } = createService();
    await service.start();
    adapter.listeners?.error(new Error('download failed'));
    adapter.fetchManifest.mockResolvedValue(manifestFor('0.2.0-beta.3'));

    await service.check();

    expect(adapter.configure).toHaveBeenCalledTimes(2);
    expect(adapter.configure).toHaveBeenLastCalledWith(expect.objectContaining({
      url: expect.stringContaining('/v0.2.0-beta.3/'),
      serverType: 'default',
    }));
    expect(adapter.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('scala równoległe prechecki w jeden request', async () => {
    const { adapter, service } = createService();
    let resolveManifest!: (value: ReturnType<typeof manifestFor>) => void;
    adapter.fetchManifest.mockImplementationOnce(() => new Promise((resolve) => {
      resolveManifest = resolve;
    }));

    const automatic = service.start();
    const manual = service.check();
    expect(adapter.fetchManifest).toHaveBeenCalledOnce();
    resolveManifest(manifestFor('0.2.0-beta.2'));

    await expect(Promise.all([automatic, manual])).resolves.toHaveLength(2);
    expect(adapter.checkForUpdates).toHaveBeenCalledOnce();
  });

  it('usuwa wszystkie listenery podczas zamknięcia', async () => {
    const { adapter, service } = createService();
    await service.start();

    service.stop();

    expect(adapter.unsubscribe).toHaveBeenCalledOnce();
  });
});
