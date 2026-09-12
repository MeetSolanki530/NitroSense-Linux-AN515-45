/**
 * Regression test for a real bug found reviewing Performance.tsx: the
 * Automatic/Manual toggle was seeded once from `useState(!auto)` at mount,
 * when `settings` is still null (isAuto(null) is always true) — so if the
 * daemon's fan_speed was ALREADY in manual mode when the app opened (left
 * that way by an earlier session), the toggle would permanently show
 * "Automatic" selected while the sliders underneath quietly displayed the
 * real non-zero duty values, disabled.
 *
 * This launches the real Electron app against a mock daemon that starts
 * already in manual mode, then reads the actual DOM to confirm the toggle
 * and sliders reflect that truth on load — not the mount-time guess.
 */
import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SOCK = '/tmp/damx-fan-sync-test.sock';
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

function runInRenderer(code: string): Promise<unknown> {
  const encoded = Buffer.from(code, 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DAMX_SOCKET: SOCK };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    execFile(
      'npx',
      ['electron', '.', '--no-sandbox', '--smoke-tab=performance', `--smoke-eval=${encoded}`],
      { env, timeout: 60_000 },
      (err, stdout) => {
        const line = stdout.split('\n').find((l) => l.startsWith('[eval] '));
        const errLine = stdout.split('\n').find((l) => l.startsWith('[eval-error] '));
        if (errLine) return reject(new Error(errLine));
        if (!line) return reject(err ?? new Error(`no result\n${stdout}`));
        resolve(JSON.parse(line.slice('[eval] '.length)));
      },
    );
  });
}

async function main(): Promise<void> {
  // Seeded already-manual, matching a machine where fan duty was left set
  // by a previous session — the exact case the bug missed.
  const mock = spawn('python3', ['scripts/mock-daemon.py', SOCK, '--start-forced', '--start-manual-fan'], {
    stdio: 'ignore',
  });
  await sleep(1200);

  try {
    console.log('\n1. Fan toggle reflects real hardware state on first load');
    const r = (await runInRenderer(`
      (async () => {
        // Let the initial get_all_settings resolve and the component render.
        await new Promise((r) => setTimeout(r, 800));
        const activeSeg = document.querySelector('.seg-active')?.textContent ?? null;
        const sliderInputs = [...document.querySelectorAll('.slider input[type="range"]')];
        const sliderValues = sliderInputs.map((el) => el.value);
        const sliderDisabled = sliderInputs.map((el) => el.disabled);
        const settings = await window.damx.getSettings();
        return { activeSeg, sliderValues, sliderDisabled, fanSpeed: settings.fan_speed };
      })()
    `)) as {
      activeSeg: string | null;
      sliderValues: string[];
      sliderDisabled: boolean[];
      fanSpeed: { cpu: string; gpu: string };
    };

    check('daemon really did start in manual (45/50)',
      r.fanSpeed.cpu === '45' && r.fanSpeed.gpu === '50', JSON.stringify(r.fanSpeed));
    check('toggle shows Manual active, not Automatic',
      r.activeSeg === 'Manual', `active segment: ${r.activeSeg}`);
    check('sliders are enabled, not disabled/muted',
      r.sliderDisabled.every((d) => d === false), JSON.stringify(r.sliderDisabled));
    check('sliders show the real duty values',
      r.sliderValues.includes('45') && r.sliderValues.includes('50'),
      JSON.stringify(r.sliderValues));
  } finally {
    mock.kill();
  }

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
