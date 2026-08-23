import { autoUpdater, net } from 'electron';
import type { AutoUpdateAdapter } from './update-service';

const manifestSizeLimit = 256 * 1_024;
const manifestTimeoutMs = 15_000;

export function createElectronAutoUpdateAdapter(): AutoUpdateAdapter {
  return {
    fetchManifest: async (options) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), manifestTimeoutMs);
      try {
        const response = await net.fetch(options.url, {
          method: 'GET',
          headers: options.headers,
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Feed aktualizacji odpowiedział HTTP ${response.status}.`);
        }
        const announcedSize = Number(response.headers.get('content-length'));
        if (Number.isFinite(announcedSize) && announcedSize > manifestSizeLimit) {
          throw new Error('Manifest aktualizacji przekracza limit rozmiaru.');
        }
        const body = await response.text();
        if (Buffer.byteLength(body, 'utf8') > manifestSizeLimit) {
          throw new Error('Manifest aktualizacji przekracza limit rozmiaru.');
        }
        try {
          return JSON.parse(body) as unknown;
        } catch {
          throw new Error('Feed aktualizacji nie zawiera prawidłowego JSON.');
        }
      } finally {
        clearTimeout(timeout);
      }
    },
    configure: (options) => autoUpdater.setFeedURL(options),
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    subscribe: (listeners) => {
      const checking = () => listeners.checking();
      const available = () => listeners.available();
      const notAvailable = () => listeners.notAvailable();
      const downloaded = (
        _event: Electron.Event,
        releaseNotes: string,
        releaseName: string,
        releaseDate: Date,
        updateUrl: string,
      ) => listeners.downloaded({ releaseNotes, releaseName, releaseDate, updateUrl });
      const error = (value: Error) => listeners.error(value);

      autoUpdater.on('checking-for-update', checking);
      autoUpdater.on('update-available', available);
      autoUpdater.on('update-not-available', notAvailable);
      autoUpdater.on('update-downloaded', downloaded);
      autoUpdater.on('error', error);

      return () => {
        autoUpdater.removeListener('checking-for-update', checking);
        autoUpdater.removeListener('update-available', available);
        autoUpdater.removeListener('update-not-available', notAvailable);
        autoUpdater.removeListener('update-downloaded', downloaded);
        autoUpdater.removeListener('error', error);
      };
    },
  };
}
