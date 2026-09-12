/**
 * Electron main process.
 *
 * Owns all privilege and I/O: the daemon socket, the telemetry pollers, the
 * window. The renderer is pure presentation and never touches net, fs or
 * child_process.
 *
 * Single-instance lock matters here beyond the usual reason. The Nitro key is
 * handled by nitro-key-detection.service, which guards with
 *   pgrep -f "/opt/damx/gui/DivAcerManagerMax"
 * before launching. If that guard ever fails to match, the lock keeps a
 * second press from opening a duplicate window — it focuses the existing one
 * instead.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DamxClient } from './damx-client.ts';
import { InternalsManager } from './internals.ts';
import { TelemetryPoller } from './telemetry.ts';
import { registerIpc } from './ipc.ts';
import type { Services } from './ipc.ts';

// Bundled to CommonJS, so __dirname is the real directory of main.cjs.
// import.meta.url does not exist in that output format.
const APP_DIR = __dirname;
const DEV_SERVER = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;
let services: Services | null = null;

/** Source icon path, present only when running unpackaged. */
function windowIcon(): string | null {
  const p = join(APP_DIR, '..', 'build', 'icons', '256x256.png');
  return existsSync(p) ? p : null;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    // Frameless: the tab strip and window controls are drawn by the renderer,
    // matching the NitroSense chrome.
    frame: false,
    backgroundColor: '#0b0806',
    // Packaged builds take the taskbar icon from the .desktop entry, but an
    // unpackaged run (npm start) has no desktop file, so point at the source
    // icon when it is there.
    ...(windowIcon() ? { icon: windowIcon() as string } : {}),
    webPreferences: {
      preload: join(APP_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Smoke mode: render, capture, exit. Used by scripts/smoke.sh to verify the
  // shell actually paints and that telemetry reaches the renderer, without a
  // human watching a window.
  // Integration hook: run a snippet in the renderer and print its result.
  // Used by scripts/test-writes.ts to drive real writes through the whole
  // chain (renderer -> preload -> validation -> socket -> daemon).
  const evalArg = process.argv.find((a) => a.startsWith('--smoke-eval='));
  if (evalArg) {
    const code = Buffer.from(evalArg.slice('--smoke-eval='.length), 'base64').toString('utf8');
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void win.webContents
          .executeJavaScript(code, true)
          .then((r) => console.log('[eval]', JSON.stringify(r)))
          .catch((e) => console.log('[eval-error]', String(e?.message ?? e)))
          .finally(() => app.exit(0));
      }, 1_200);
    });
  }

  const smokeOut = process.argv.find((a) => a.startsWith('--smoke-out='));
  if (smokeOut) {
    const outPath = smokeOut.slice('--smoke-out='.length);
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void win.webContents
          .capturePage()
          .then(async (img) => {
            const { writeFile } = await import('node:fs/promises');
            await writeFile(outPath, img.toPNG());
            console.log(`[smoke] captured ${outPath}`);
          })
          .catch((e) => console.error('[smoke] capture failed', e))
          .finally(() => app.exit(0));
      }, 3_000);
    });
  }

  // Never let the app navigate itself, and send real links to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const tabArg = process.argv.find((a) => a.startsWith('--smoke-tab='));
  const hash = tabArg ? tabArg.slice('--smoke-tab='.length) : '';

  if (DEV_SERVER) {
    void win.loadURL(DEV_SERVER + (hash ? `#${hash}` : ''));
  } else {
    void win.loadFile(join(APP_DIR, '../dist/index.html'), hash ? { hash } : undefined);
  }

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

function focusExisting(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Acquire before anything else: a second launch must not start a daemon
// connection or a telemetry poller before exiting.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusExisting);

  void app.whenReady().then(async () => {
    const client = new DamxClient();
    const internals = new InternalsManager(client);
    const telemetry = new TelemetryPoller({ intervalMs: 1_000 });

    services = { client, internals, telemetry };
    registerIpc(services, () => mainWindow);

    // Telemetry is independent of the daemon: sysfs works even when the
    // daemon is down, so the dashboard still shows temperatures.
    await telemetry.start();

    // Connecting is best-effort. A missing daemon is a visible degraded
    // state in the UI, not a startup failure.
    client.connect().catch(() => undefined);

    // Frameless chrome: the renderer draws the titlebar, so window controls
    // come back over IPC. Fixed command set, no arbitrary window access.
    ipcMain.on('damx:window', (_e, action: unknown) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
      else if (action === 'close') win.close();
    });

    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Plan decision (a): close means quit, no tray. The Nitro key guard only
    // launches when no process matches, so a tray-resident app would make the
    // key appear broken.
    services?.telemetry.stop();
    services?.client.close();
    app.quit();
  });
}
