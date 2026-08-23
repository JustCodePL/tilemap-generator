import { afterEach, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  fetch: vi.fn(),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  net: { fetch: electron.fetch },
  autoUpdater: {
    setFeedURL: electron.setFeedURL,
    checkForUpdates: electron.checkForUpdates,
    quitAndInstall: electron.quitAndInstall,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

afterEach(() => vi.clearAllMocks());

it('pobiera manifest z limitem, bez cache i bez redirectów', async () => {
  electron.fetch.mockResolvedValue(new Response('{"currentRelease":"0.2.0"}', {
    status: 200,
    headers: { 'content-length': '26' },
  }));
  const { createElectronAutoUpdateAdapter } = await import('../main/services/electron-auto-update-adapter');
  const adapter = createElectronAutoUpdateAdapter();

  await expect(adapter.fetchManifest({
    url: 'https://justcodepl.github.io/tilemap-generator/updates/beta/darwin/arm64/RELEASES.json',
    headers: { 'Cache-Control': 'no-cache' },
  })).resolves.toEqual({ currentRelease: '0.2.0' });
  expect(electron.fetch).toHaveBeenCalledWith(
    'https://justcodepl.github.io/tilemap-generator/updates/beta/darwin/arm64/RELEASES.json',
    expect.objectContaining({
      method: 'GET',
      headers: { 'Cache-Control': 'no-cache' },
      cache: 'no-store',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }),
  );
});

it.each([
  ['HTTP error', new Response('', { status: 404 }), 'HTTP 404'],
  ['invalid JSON', new Response('<html>no</html>', { status: 200 }), 'prawidłowego JSON'],
  ['oversized manifest', new Response('{}', {
    status: 200,
    headers: { 'content-length': String(256 * 1_024 + 1) },
  }), 'limit rozmiaru'],
] as const)('odrzuca %s bez uruchamiania Squirrel', async (_label, response, message) => {
  electron.fetch.mockResolvedValue(response);
  const { createElectronAutoUpdateAdapter } = await import('../main/services/electron-auto-update-adapter');
  const adapter = createElectronAutoUpdateAdapter();

  await expect(adapter.fetchManifest({
    url: 'https://justcodepl.github.io/tilemap-generator/updates/stable/darwin/arm64/RELEASES.json',
    headers: {},
  })).rejects.toThrow(message);
  expect(electron.setFeedURL).not.toHaveBeenCalled();
  expect(electron.checkForUpdates).not.toHaveBeenCalled();
});

it('przekazuje do Electron wyłącznie endpoint serverType default po prechecku', async () => {
  const { createElectronAutoUpdateAdapter } = await import('../main/services/electron-auto-update-adapter');
  const adapter = createElectronAutoUpdateAdapter();
  const config = {
    url: 'https://github.com/JustCodePL/tilemap-generator/releases/download/v0.2.0-beta.2/tilemap-generator-darwin-arm64-0.2.0-beta.2-update.json',
    serverType: 'default' as const,
    headers: { 'Cache-Control': 'no-cache' },
  };

  adapter.configure(config);
  adapter.checkForUpdates();

  expect(electron.setFeedURL).toHaveBeenCalledWith(config);
  expect(electron.checkForUpdates).toHaveBeenCalledOnce();
});
