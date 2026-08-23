import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const appListeners = new Map<string, Listener>();
  const windows: FakeBrowserWindow[] = [];
  const registerIpc = vi.fn(() => vi.fn(async () => undefined));

  class FakeBrowserWindow {
    readonly listeners = new Map<string, Listener>();
    readonly webContents = {
      id: windows.length + 1,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    };
    hidden = false;
    focused = false;
    destroyed = false;

    constructor() {
      windows.push(this);
    }

    static getAllWindows(): FakeBrowserWindow[] {
      return windows.filter((window) => !window.destroyed);
    }

    on(event: string, listener: Listener): void {
      this.listeners.set(event, listener);
    }

    emit(event: string, ...args: unknown[]): void {
      this.listeners.get(event)?.(...args);
    }

    isDestroyed(): boolean { return this.destroyed; }
    show(): void { this.hidden = false; }
    hide(): void { this.hidden = true; }
    focus(): void { this.focused = true; }
    loadURL(): Promise<void> { return Promise.resolve(); }
    loadFile(): Promise<void> { return Promise.resolve(); }
  }

  return {
    appListeners,
    windows,
    registerIpc,
    BrowserWindow: FakeBrowserWindow,
    app: {
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn((event: string, listener: Listener) => appListeners.set(event, listener)),
      getPath: vi.fn(() => '/tmp/tilemap-generator-test-user-data'),
      quit: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  app: state.app,
  BrowserWindow: state.BrowserWindow,
  net: { fetch: vi.fn() },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));
vi.mock('../main/ipc/register-ipc', () => ({ registerIpc: state.registerIpc }));
vi.mock('../main/services/app-logger', () => ({ AppLogger: class AppLogger {} }));
vi.mock('../main/services/project-manager', () => ({
  ProjectManager: class ProjectManager {
    resolveAssetRequest(): string { return '/tmp/not-used'; }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  state.appListeners.clear();
  state.windows.splice(0);
  state.registerIpc.mockClear();
  state.app.quit.mockClear();
  delete (globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_DEV_SERVER_URL;
  delete (globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_NAME;
});

it('na macOS ukrywa zamknięte okno i ponownie je pokazuje bez duplikowania IPC', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  (globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_DEV_SERVER_URL = 'http://127.0.0.1:5173';
  (globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_NAME = 'main_window';

  await import('../main/index');
  await vi.waitFor(() => expect(state.windows).toHaveLength(1));
  const window = state.windows[0];
  expect(state.registerIpc).toHaveBeenCalledTimes(1);

  const closeEvent = { preventDefault: vi.fn() };
  window.emit('close', closeEvent);
  expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
  expect(window.hidden).toBe(true);

  state.appListeners.get('activate')?.();
  await vi.waitFor(() => expect(window.hidden).toBe(false));
  expect(window.focused).toBe(true);
  expect(state.windows).toHaveLength(1);
  expect(state.registerIpc).toHaveBeenCalledTimes(1);
});

it('nie pozwala drugiemu Cmd-Q ominąć trwającego cleanup aplikacji', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  (globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_DEV_SERVER_URL = 'http://127.0.0.1:5173';
  (globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_NAME = 'main_window';
  let finishCleanup: () => void = () => undefined;
  const cleanup = vi.fn(() => new Promise<undefined>((resolve) => {
    finishCleanup = () => resolve(undefined);
  }));
  state.registerIpc.mockImplementationOnce(() => cleanup);

  await import('../main/index');
  await vi.waitFor(() => expect(state.windows).toHaveLength(1));
  const beforeQuit = state.appListeners.get('before-quit');
  expect(beforeQuit).toBeTypeOf('function');

  const firstEvent = { preventDefault: vi.fn() };
  beforeQuit?.(firstEvent);
  expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();

  const repeatedEvent = { preventDefault: vi.fn() };
  beforeQuit?.(repeatedEvent);
  expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(state.app.quit).not.toHaveBeenCalled();

  finishCleanup();
  await vi.waitFor(() => expect(state.app.quit).toHaveBeenCalledOnce());
  const finalEvent = { preventDefault: vi.fn() };
  beforeQuit?.(finalEvent);
  expect(finalEvent.preventDefault).not.toHaveBeenCalled();
});
