import { app, BrowserWindow, net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpc } from './ipc/register-ipc';
import { AppLogger } from './services/app-logger';
import { ProjectManager } from './services/project-manager';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

protocol.registerSchemesAsPrivileged([{
  scheme: 'tilemap-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
}]);

let mainWindow: BrowserWindow | null = null;
let cleanup: (() => Promise<void>) | null = null;
let cleanupStarted = false;
let readyToQuit = false;
let windowCreation: Promise<void> | null = null;
const projects = new ProjectManager();

function createWindow(): Promise<void> {
  if (cleanupStarted || readyToQuit) return Promise.resolve();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return Promise.resolve();
  }
  windowCreation ??= createWindowOnce().finally(() => { windowCreation = null; });
  return windowCreation;
}

async function createWindowOnce(): Promise<void> {
  if (cleanup) {
    const previousCleanup = cleanup;
    cleanup = null;
    await previousCleanup();
  }

  const window = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0b0e12',
    title: 'Tilemap Generator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? new URL(url).origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
      : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });
  window.on('close', (event) => {
    if (process.platform !== 'darwin' || cleanupStarted || readyToQuit) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  try {
    const userDataPath = app.getPath('userData');
    cleanup = await registerIpc(window, projects, new AppLogger(userDataPath), userDataPath);
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
      await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }
  } catch (error) {
    const partialCleanup = cleanup;
    cleanup = null;
    await partialCleanup?.();
    if (!window.isDestroyed()) window.destroy();
    if (mainWindow === window) mainWindow = null;
    throw error;
  }
}

void app.whenReady().then(async () => {
  protocol.handle('tilemap-asset', (request) => {
    try {
      return net.fetch(pathToFileURL(projects.resolveAssetRequest(request.url)).toString());
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 404 });
    }
  });
  await createWindow();
  const smokeQuitMs = Number(process.env.TILEMAP_SMOKE_AUTO_QUIT_MS ?? 0);
  if (Number.isFinite(smokeQuitMs) && smokeQuitMs > 0 && smokeQuitMs <= 60_000) {
    setTimeout(() => app.quit(), smokeQuitMs);
  }
  app.on('activate', () => {
    void createWindow();
  });
}).catch((error) => {
  console.error('Nie udało się uruchomić Tilemap Generator.', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (readyToQuit) return;
  if (cleanupStarted) {
    event.preventDefault();
    return;
  }
  if (!cleanup) return;
  event.preventDefault();
  cleanupStarted = true;
  const shutdown = cleanup;
  cleanup = null;
  void shutdown().finally(() => {
    readyToQuit = true;
    app.quit();
  });
});
