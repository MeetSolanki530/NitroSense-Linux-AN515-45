/**
 * Telemetry tests. Runs against this machine's real sensors, plus a fake
 * sysfs node to exercise the dGPU runtime-PM gate (which cannot be forced
 * on demand on real hardware).
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSensors, readGpuState, TelemetryPoller } from '../electron/telemetry.ts';
import type { SensorMap } from '../electron/telemetry.ts';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

const plausibleTemp = (v: number | null): boolean => v !== null && v > 0 && v < 120;

async function main(): Promise<void> {
  console.log('\n1. Sensor discovery (by name, on real hardware)');
  const sensors = await discoverSensors();
  check('found a CPU temperature sensor', sensors.cpuTemp !== null, String(sensors.cpuTemp));
  check('found a battery', sensors.batteryDir !== null, String(sensors.batteryDir));
  check('found an AC adapter', sensors.acDir !== null, String(sensors.acDir));
  check('discovery returns paths, not indices',
    sensors.cpuTemp === null || sensors.cpuTemp.startsWith('/sys/'), String(sensors.cpuTemp));
  console.log(`  ${'\x1b[2m'}fan inputs: ${sensors.fanInputs.length} ` +
    `(0 is expected until linuwu_sense is loaded)\x1b[0m`);

  console.log('\n2. Live sample');
  const poller = new TelemetryPoller({ intervalMs: 300 });
  const first = await poller.sample();
  check('CPU temperature is plausible', plausibleTemp(first.cpu.tempC), String(first.cpu.tempC));
  check('RAM usage is a percentage',
    first.ram.usedPct !== null && first.ram.usedPct >= 0 && first.ram.usedPct <= 100,
    String(first.ram.usedPct));
  check('battery percentage is sane',
    first.battery.percent !== null && first.battery.percent >= 0 && first.battery.percent <= 100,
    String(first.battery.percent));
  check('AC state is known', typeof first.battery.acConnected === 'boolean');
  check('fans report null rather than fabricating zero',
    sensors.fanInputs.length > 0 || first.fans.cpuRpm === null);

  console.log('\n3. CPU usage needs two samples');
  const second = await poller.sample();
  check('usage resolves once a delta exists',
    second.cpu.usagePct !== null && second.cpu.usagePct >= 0 && second.cpu.usagePct <= 100,
    String(second.cpu.usagePct));

  console.log('\n4. dGPU runtime-PM gate (fake sysfs)');
  const tmp = await mkdtemp(join(tmpdir(), 'damx-gpu-'));
  try {
    await mkdir(join(tmp, 'power'), { recursive: true });

    await writeFile(join(tmp, 'power', 'runtime_status'), 'suspended\n');
    const suspendedMap: SensorMap = { ...sensors, nvidiaPciPath: tmp, hasNvidiaSmi: true };
    // PATH is emptied so any nvidia-smi call would fail outright; idle must
    // still be reported, proving the gate returned before invoking it.
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    const suspended = await readGpuState(suspendedMap);
    process.env.PATH = savedPath;

    check('suspended dGPU reports present', suspended.present === true);
    check('suspended dGPU reports idle', suspended.idle === true);
    check('suspended dGPU reports no values (shows "--")',
      suspended.tempC === null && suspended.usagePct === null && suspended.clockMhz === null);

    await writeFile(join(tmp, 'power', 'runtime_status'), 'active\n');
    const activeNoSmi: SensorMap = { ...sensors, nvidiaPciPath: tmp, hasNvidiaSmi: false };
    const absent = await readGpuState(activeNoSmi);
    check('no nvidia-smi means GPU reported absent, not idle',
      absent.present === false && absent.idle === false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log('\n5. Re-runnable discovery (driver reload adds devices)');
  const before = poller.sensors;
  const again = await poller.rediscover();
  check('rediscover() returns a fresh map', again !== null);
  check('repeated discovery is stable', JSON.stringify(before) === JSON.stringify(again));

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
