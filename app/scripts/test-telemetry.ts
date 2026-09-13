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
import {
  FAN_FULL_RPM, FAN_MAX_SECONDS, FAN_MIN_SECONDS, FAN_STOPPED_RPM, fanSpinSeconds,
} from '../src/state/fan.ts';

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

  // The integrated GPU is the one the desktop actually renders on, so its
  // utilisation is the figure that moves. It comes from amdgpu's own
  // gpu_busy_percent, which lives on the DRM device rather than in hwmon.
  check('found the integrated GPU utilisation counter',
    sensors.igpuBusy !== null, String(sensors.igpuBusy));
  check('iGPU utilisation is a percentage, or null where absent',
    first.igpu.usagePct === null
    || (first.igpu.usagePct >= 0 && first.igpu.usagePct <= 100),
    String(first.igpu.usagePct));
  check('iGPU reports a number when the counter exists',
    sensors.igpuBusy === null || first.igpu.usagePct !== null,
    String(first.igpu.usagePct));

  console.log('\n3. CPU usage needs two samples');
  const second = await poller.sample();
  check('usage resolves once a delta exists',
    second.cpu.usagePct !== null && second.cpu.usagePct >= 0 && second.cpu.usagePct <= 100,
    String(second.cpu.usagePct));

  console.log('\n4. dGPU runtime-PM gate (fake sysfs)');
  const tmp = await mkdtemp(join(tmpdir(), 'nitrosense-gpu-'));
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

  // The fan spinner is a gauge, not a replica: a real fan turns far too fast
  // to animate honestly, so the mapping has to stay inside a range the eye can
  // follow while still moving visibly with the RPM.
  console.log('\nFan spinner timing');

  check('no reading does not spin', fanSpinSeconds(null) === null);
  check('undefined does not spin', fanSpinSeconds(undefined) === null);
  check('NaN does not spin', fanSpinSeconds(Number.NaN) === null);
  check('a stopped fan does not spin', fanSpinSeconds(0) === null);
  check('below the stop threshold does not spin',
    fanSpinSeconds(FAN_STOPPED_RPM - 1) === null);
  check('at the stop threshold it spins', fanSpinSeconds(FAN_STOPPED_RPM) !== null);

  const slow = fanSpinSeconds(1200);
  const fast = fanSpinSeconds(4200);
  check('faster RPM means less time per turn',
    slow !== null && fast !== null && fast < slow,
    `1200 -> ${slow}s, 4200 -> ${fast}s`);

  check('never faster than the floor',
    (fanSpinSeconds(99_999) as number) >= FAN_MIN_SECONDS);
  check('never slower than the ceiling',
    (fanSpinSeconds(FAN_STOPPED_RPM) as number) <= FAN_MAX_SECONDS);
  check('past full speed is pinned, not extrapolated',
    fanSpinSeconds(FAN_FULL_RPM) === fanSpinSeconds(FAN_FULL_RPM * 3));

  // A CSS animation-duration of 0s never advances, so a zero would freeze the
  // blades while the fan is spinning.
  check('a spinning fan never gets a zero duration',
    [150, 900, 2700, 4000, 6000].every((r) => (fanSpinSeconds(r) as number) > 0));

  // The everyday range on this machine is roughly 2000-3600 RPM. If those all
  // collapsed to one duration the spinner would tell you nothing.
  const everyday = [2000, 2600, 3200, 3600].map(fanSpinSeconds);
  check('the everyday range is visibly distinct',
    new Set(everyday).size === everyday.length, everyday.join(', '));

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
