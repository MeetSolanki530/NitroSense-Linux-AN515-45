/**
 * Live telemetry readout — step 3 deliverable.
 *
 * Shows exactly what the Home screen will bind to. Needs no daemon and no
 * root; it reads sysfs and (when the dGPU is awake) nvidia-smi.
 *
 *     node scripts/monitor.ts          # ctrl-c to stop
 */
import { TelemetryPoller } from '../electron/telemetry.ts';
import type { Telemetry } from '../electron/telemetry.ts';

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;

/** Mirrors the UI: a missing reading is "--", never a fabricated 0. */
const val = (v: number | null, unit = '', width = 6): string =>
  (v === null ? '--' : `${v}${unit}`).padStart(width);

function bar(pct: number | null, width = 24): string {
  if (pct === null) return dim('·'.repeat(width));
  const filled = Math.round((pct / 100) * width);
  return cyan('█'.repeat(filled)) + dim('░'.repeat(width - filled));
}

function render(t: Telemetry): void {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${bold('telemetry')}  ${dim(new Date(t.timestamp).toLocaleTimeString())}`);
  lines.push('');
  lines.push(`  CPU     ${val(t.cpu.usagePct, '%')}  ${bar(t.cpu.usagePct)}  ${val(t.cpu.tempC, 'C')}`);
  lines.push(`  RAM     ${val(t.ram.usedPct, '%')}  ${bar(t.ram.usedPct)}`);

  if (!t.gpu.present) {
    lines.push(`  GPU     ${dim('not present (no nvidia-smi or driver unbound)')}`);
  } else if (t.gpu.idle) {
    lines.push(`  GPU     ${dim('Discrete GPU is idle')}  ${dim('(runtime-suspended; not polled)')}`);
  } else {
    lines.push(`  GPU     ${val(t.gpu.usagePct, '%')}  ${bar(t.gpu.usagePct)}  ${val(t.gpu.tempC, 'C')}  ${val(t.gpu.clockMhz, 'MHz', 8)}`);
    if (t.gpu.name) lines.push(`          ${dim(t.gpu.name)}`);
  }

  lines.push(`  iGPU    ${' '.repeat(6)}  ${' '.repeat(24)}  ${val(t.igpu.tempC, 'C')}`);
  lines.push(`  System  ${' '.repeat(6)}  ${' '.repeat(24)}  ${val(t.system.tempC, 'C')}`);
  lines.push('');
  lines.push(`  Fans    CPU ${val(t.fans.cpuRpm, ' RPM', 9)}   GPU ${val(t.fans.gpuRpm, ' RPM', 9)}`);
  if (t.fans.cpuRpm === null) {
    lines.push(`          ${dim('no fan hwmon — expected until linuwu_sense is loaded')}`);
  }
  lines.push('');
  lines.push(
    `  Battery ${val(t.battery.percent, '%')}  ${t.battery.status ?? dim('—')}` +
      `  ${t.battery.acConnected ? 'AC connected' : 'on battery'}`,
  );
  lines.push('');
  lines.push(dim('  ctrl-c to stop'));

  process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const poller = new TelemetryPoller({ intervalMs: 1_000 });
  poller.on('telemetry', render);
  poller.on('error', (e: unknown) => console.error('telemetry error:', e));
  await poller.start();

  const stop = (): void => {
    poller.stop();
    process.stdout.write('\n');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
