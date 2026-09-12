/**
 * Cross-checks the app's CPU and GPU usage numbers against independent tools.
 *
 * The question this answers is "are these real measurements or noise". It
 * samples with exactly the same arithmetic the app uses, then compares:
 *
 *   CPU  ->  top -bn2   (reads the same /proc/stat, different implementation)
 *   GPU  ->  nvidia-smi (the app's own source, shown raw for comparison)
 *   RAM  ->  free
 *
 * It also runs a deliberate busy phase: a number that tracks load is measuring
 * something, a number that does not is not.
 *
 *   node scripts/verify-telemetry.ts
 */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const run = promisify(execFile);

type Sample = { total: number; idle: number };

// Identical arithmetic to electron/telemetry.ts readCpuSample/cpuUsageFrom.
async function sample(): Promise<Sample> {
  const stat = await readFile('/proc/stat', 'utf8');
  const line = stat.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) throw new Error('no cpu line in /proc/stat');
  const p = line.split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
  const [user = 0, nice = 0, sys = 0, idle = 0, iowait = 0, irq = 0, soft = 0, steal = 0] = p;
  return { total: user + nice + sys + idle + iowait + irq + soft + steal, idle: idle + iowait };
}

function usage(prev: Sample, next: Sample): number {
  const t = next.total - prev.total;
  const i = next.idle - prev.idle;
  if (t <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, ((t - i) / t) * 100)) * 10) / 10;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Occupies one core for `ms`, so usage has something real to report. */
function burn(ms: number): void {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) {}
}

async function topCpu(): Promise<string> {
  try {
    const { stdout } = await run('top', ['-bn2', '-d', '1'], { timeout: 8_000 });
    const lines = stdout.split('\n').filter((l) => /^%?Cpu/i.test(l));
    const last = lines[lines.length - 1] ?? '';
    const idle = last.match(/([\d.,]+)\s*id/);
    if (!idle?.[1]) return last.trim() || 'unavailable';
    const busy = 100 - Number(idle[1].replace(',', '.'));
    return `${busy.toFixed(1)}% busy   (from: ${last.trim()})`;
  } catch {
    return 'unavailable (top not installed or timed out)';
  }
}

async function main(): Promise<void> {
  console.log(`host: ${os.hostname()}   cores: ${os.cpus().length}`);

  console.log('\n1. Idle-ish sample, 1s window');
  let a = await sample();
  await sleep(1_000);
  let b = await sample();
  const idlePct = usage(a, b);
  console.log(`   app method: ${idlePct}%`);

  console.log('\n2. Same window, but one core deliberately busy');
  a = await sample();
  burn(1_000);
  b = await sample();
  const busyPct = usage(a, b);
  const expected = Math.round((100 / os.cpus().length) * 10) / 10;
  console.log(`   app method: ${busyPct}%`);
  console.log(`   one core of ${os.cpus().length} saturated is about ${expected}%`);
  console.log(
    busyPct > idlePct
      ? `   -> rose by ${(busyPct - idlePct).toFixed(1)} points under real load`
      : '   -> DID NOT RISE under load, which would mean it is not measuring',
  );

  console.log('\n3. Independent cross-check: top');
  console.log(`   ${await topCpu()}`);

  console.log('\n4. GPU (the app reads exactly this)');
  try {
    const { stdout } = await run(
      'nvidia-smi',
      ['--query-gpu=name,temperature.gpu,utilization.gpu,clocks.gr',
       '--format=csv,noheader,nounits'],
      { timeout: 4_000 },
    );
    console.log(`   nvidia-smi: ${stdout.trim()}`);
    console.log('   fields: name, temp C, utilisation %, graphics clock MHz');
  } catch {
    console.log('   nvidia-smi unavailable — the app shows "--" rather than a guess.');
  }

  console.log('\n5. RAM cross-check');
  try {
    const info = await readFile('/proc/meminfo', 'utf8');
    const num = (k: string): number =>
      Number(info.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'))?.[1] ?? 0);
    const total = num('MemTotal');
    const avail = num('MemAvailable');
    console.log(`   app method: ${(((total - avail) / total) * 100).toFixed(1)}% used`);
    const { stdout } = await run('free', ['-m'], { timeout: 4_000 });
    console.log(`   free -m:\n${stdout.trimEnd().split('\n').map((l) => `     ${l}`).join('\n')}`);
  } catch {
    console.log('   free unavailable');
  }

  console.log('\nIf 2 rose under load and 3 broadly agrees, the numbers are real.');
}

void main();
