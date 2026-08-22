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
const projects = new ProjectManager();

function createWindow(): void {
  mainWindow = new BrowserWindow({
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

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? new URL(url).origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
      : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });

  cleanup = registerIpc(mainWindow, projects, new AppLogger(app.getPath('userData')));
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

void app.whenReady().then(() => {
  protocol.handle('tilemap-asset', (request) => {
    try {
      return net.fetch(pathToFileURL(projects.resolveAssetRequest(request.url)).toString());
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 404 });
    }
  });
  createWindow();
  const smokeQuitMs = Number(process.env.TILEMAP_SMOKE_AUTO_QUIT_MS ?? 0);
  if (Number.isFinite(smokeQuitMs) && smokeQuitMs > 0 && smokeQuitMs <= 60_000) {
    setTimeout(() => app.quit(), smokeQuitMs);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (readyToQuit || !cleanup) return;
  event.preventDefault();
  if (cleanupStarted) return;
  cleanupStarted = true;
  void cleanup().finally(() => {
    readyToQuit = true;
    cleanup = null;
    app.quit();
  });
});
