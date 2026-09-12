/**
 * Development runner: Vite dev server + Electron, with reload.
 *
 *   renderer  edits hot-reload instantly through Vite HMR
 *   main/preload  edits rebuild and restart Electron automatically
 *
 * No extra dependencies — this replaces a `concurrently` invocation that was
 * never installed.
 *
 *   npm run dev
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import electronPath from 'electron';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const URL_ = `http://localhost:${PORT}`;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

let viteProc = null;
let electronProc = null;
let restarting = false;
let shuttingDown = false;

function run(cmd, args, opts = {}) {
  return spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function buildMain() {
  return new Promise((resolve, reject) => {
    const p = run(process.execPath, [join(ROOT, 'build-electron.mjs')], { stdio: 'pipe' });
    let err = '';
    p.stderr?.on('data', (d) => { err += d; });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
  });
}

async function waitForVite(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL_, { signal: AbortSignal.timeout(1000) });
      if (res.ok || res.status === 404) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function startElectron() {
  const env = { ...process.env, VITE_DEV_SERVER_URL: URL_ };
  // VS Code sets these for its own extension host; with ELECTRON_RUN_AS_NODE
  // set, Electron runs as plain Node and require('electron') returns a path
  // string instead of the API, so the app fails at startup.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  electronProc = run(electronPath, ['.', '--no-sandbox'], { env });
  electronProc.on('exit', (code) => {
    electronProc = null;
    if (restarting || shuttingDown) return;
    console.log(dim(`\nElectron exited (${code}). Shutting down the dev server.`));
    shutdown(0);
  });
}

async function restartElectron() {
  if (restarting) return;
  restarting = true;
  console.log(yellow('\n  main/preload changed — rebuilding and restarting Electron'));
  try {
    await buildMain();
  } catch (e) {
    console.error(`  build failed: ${e.message}`);
    restarting = false;
    return;
  }
  if (electronProc) {
    electronProc.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
  startElectron();
  restarting = false;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  electronProc?.kill();
  viteProc?.kill();
  setTimeout(() => process.exit(code), 200);
}

async function main() {
  console.log(green('\n  NitroSense dev\n'));
  console.log(dim('  renderer: hot reload via Vite'));
  console.log(dim('  main/preload: rebuild + restart on change'));
  console.log(dim('  ctrl-c to stop\n'));

  await buildMain();

  viteProc = run(join(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort']);
  viteProc.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`Vite exited (${code}).`);
      shutdown(1);
    }
  });

  if (!(await waitForVite())) {
    console.error('Vite did not start in time.');
    shutdown(1);
    return;
  }

  startElectron();

  // Rebuild + restart when the main process or preload changes. The renderer
  // is left to Vite, which reloads it without a restart.
  let pending = null;
  watch(join(ROOT, 'electron'), { recursive: true }, (_e, file) => {
    if (!file || !/\.(ts|mjs|js)$/.test(file)) return;
    clearTimeout(pending);
    pending = setTimeout(() => void restartElectron(), 150);
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

main().catch((e) => {
  console.error(e);
  shutdown(1);
});
