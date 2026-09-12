/**
 * Electron main process.
 *
 * Owns all privilege and I/O: the daemon socket, the telemetry pollers, the
 * window. The renderer is pure presentation and never touches net, fs or
 * child_process.
 *
 * The single-instance lock does three jobs here, not one.
 *
 *  1. The usual one: a second launch focuses the existing window.
 *
 *  2. It backstops the Nitro key. The key runs the launcher, and if anything
 *     ever launches a second copy, the lock keeps it from opening a duplicate
 *     window and focuses the existing one instead.
 *
 *  3. It is how the key is identified during setup. The relaunch carries a
 *     marker in its argv naming which candidate key fired, and the lock
 *     delivers that argv to the running app. See electron/nitro-key.ts for
 *     why detection has to work this way.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HardwareClient } from './hardware-client.ts';
import { InternalsManager } from './internals.ts';
import { TelemetryPoller } from './telemetry.ts';
import { CH, registerIpc } from './ipc.ts';
import type { Services } from './ipc.ts';
import { NitroKey, acceleratorFromArgv } from './nitro-key.ts';

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

let splash: BrowserWindow | null = null;
let splashShownAt = 0;
/** Long enough to read, short enough not to be in the way. */
const SPLASH_MIN_MS = 1_100;

/**
 * Branded window shown while the main window loads.
 *
 * This exists because of how the app is launched: the Nitro key starts a cold
 * Electron process, and the gap before the first paint is dead time with no
 * feedback at all — the key looks like it did nothing. A frameless window with
 * the mark covers that gap.
 *
 * Skipped in smoke/eval runs, which must not have an extra window competing
 * for focus or capture.
 */
function createSplash(): void {
  if (process.argv.some((a) => a.startsWith('--smoke-'))) return;

  const file = join(APP_DIR, '../dist/splash.html');
  if (!existsSync(file)) return;

  splash = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    center: true,
    backgroundColor: '#00000000',
    ...(windowIcon() ? { icon: windowIcon() as string } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  splash.once('ready-to-show', () => {
    splashShownAt = Date.now();
    splash?.show();
  });
  splash.on('closed', () => { splash = null; });
  void splash.loadFile(file);
}

function closeSplash(): void {
  if (!splash) return;
  splash.close();
  splash = null;
}

/** How long the splash still owes the user before it may close. */
function splashRemainingMs(): number {
  if (!splash) return 0;
  if (splashShownAt === 0) return SPLASH_MIN_MS;
  return Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
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

  win.once('ready-to-show', () => {
    // Hand over from the splash rather than stacking both windows: wait out
    // whatever the splash still owes, then swap in one step.
    setTimeout(() => {
      win.show();
      win.focus();
      closeSplash();
    }, splashRemainingMs());
  });

  // Safety net: if the page never becomes ready (daemon wedged, load error),
  // the splash must not sit on top of everything forever.
  setTimeout(() => {
    if (!splash) return;
    closeSplash();
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 15_000);

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
  app.on('second-instance', (_event, argv) => {
    // A relaunch during setup is how we learn which key the user pressed:
    // the shortcut runs the launcher with a marker, the lock sends us its
    // argv, and the renderer gets told which candidate fired.
    const accel = acceleratorFromArgv(argv);
    if (accel) mainWindow?.webContents.send(CH.nitroKey, { accelerator: accel });
    focusExisting();
  });

  void app.whenReady().then(async () => {
    // First, before any I/O: the Nitro key gives no feedback of its own, so
    // something must appear immediately or the key looks dead. Everything
    // below (socket connect, telemetry start) happens behind it.
    createSplash();

    const client = new HardwareClient();
    const internals = new InternalsManager(client);
    const telemetry = new TelemetryPoller({ intervalMs: 1_000 });
    const nitroKey = new NitroKey(app.getPath('userData'), join(APP_DIR, '../scripts/launch.sh'));

    services = { client, internals, telemetry, nitroKey };
    registerIpc(services, () => mainWindow);

    // Telemetry is independent of the daemon: sysfs works even when the
    // daemon is down, so the dashboard still shows temperatures.
    await telemetry.start();

    // Connecting is best-effort. A missing daemon is a visible degraded
    // state in the UI, not a startup failure.
    client.connect().catch(() => undefined);

    // Frameless chrome: the renderer draws the titlebar, so window controls
    // come back over IPC. Fixed command set, no arbitrary window access.
    ipcMain.on('nitrosense:window', (_e, action: unknown) => {
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
    // Close means quit, no tray. The key launches the app only when no
    // process matches, so a tray-resident app would make the key look broken.
    app.quit();
  });

  // Runs on every exit path, not just the window being closed: a logout, a
  // SIGTERM or app.quit() from anywhere else must still release the socket and
  // stop the poller rather than leaving a process holding them.
  app.on('before-quit', () => {
    closeSplash();
    services?.telemetry.stop();
    services?.client.close();
  });

  // A signal is not an error, but without a handler the default action kills
  // the process before before-quit can run.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => app.quit());
  }

  // Never leave a window up in an unknown state after an unexpected failure:
  // log it and exit, so the next launch starts clean.
  process.on('uncaughtException', (err) => {
    console.error('[nitrosense] fatal:', err);
    try {
      closeSplash();
      services?.telemetry.stop();
      services?.client.close();
    } finally {
      app.exit(1);
    }
  });
}
