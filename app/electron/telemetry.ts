/**
 * Telemetry — live hardware readings for the dashboard.
 *
 * The hardware service provides NO telemetry: get_all_settings returns settings
 * only, with no temperatures, usage, clocks or RPM. Every number on the Home
 * screen has to be gathered here, the same way the Avalonia app did it, but
 * with three deliberate differences:
 *
 *  1. Sensors are discovered BY NAME (each hwmon device's `name` file), never by index. hwmon
 *     numbering is not stable across reboots.
 *
 *  2. Discovery is re-runnable. Loading linuwu_sense adds hwmon devices
 *     (that is where fan RPM comes from), so a cache populated once at
 *     startup goes permanently stale the moment the Internals Manager
 *     reloads the driver. The old app cached at startup and had this bug.
 *
 *  3. nvidia-smi is gated on the dGPU's runtime power state. Polling it
 *     unconditionally keeps the discrete GPU awake, costing battery and idle
 *     heat. Reading power/runtime_status first is cheap, reproduces the
 *     "Discrete GPU is idle" state from the NitroSense UI, and lets the card
 *     stay asleep. The old app called nvidia-smi every tick regardless.
 *
 * CPU usage is computed as a delta between consecutive ticks rather than by
 * sleeping 100ms inside the sample, so nothing blocks.
 */

import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

const HWMON_ROOT = '/sys/class/hwmon';
const POWER_SUPPLY_ROOT = '/sys/class/power_supply';
const NVIDIA_PCI_ROOT = '/sys/bus/pci/drivers/nvidia';

export type Reading = number | null;

export type Telemetry = {
  timestamp: number;
  /** model is read once at discovery — it is static hardware info, not a sample. */
  cpu: { usagePct: Reading; tempC: Reading; model: string | null };
  /** Discrete NVIDIA GPU. `idle` true means runtime-suspended: show "--". */
  gpu: {
    present: boolean;
    idle: boolean;
    name: string | null;
    tempC: Reading;
    usagePct: Reading;
    clockMhz: Reading;
  };
  /**
   * Integrated Radeon.
   *
   * Utilisation comes from amdgpu's own gpu_busy_percent, a plain sysfs read
   * with no equivalent of nvidia-smi's cost, so unlike the discrete card there
   * is no reason to gate it behind a runtime-power check.
   *
   * This is the GPU the desktop actually renders on, which is why the discrete
   * one reads 0% nearly all the time.
   */
  igpu: { tempC: Reading; usagePct: Reading; name: string | null };
  system: { tempC: Reading };
  ram: { usedPct: Reading; totalKb: Reading; availableKb: Reading };
  /** Null until linuwu_sense is loaded — it provides the fan hwmon. */
  fans: { cpuRpm: Reading; gpuRpm: Reading };
  battery: { percent: Reading; status: string | null; acConnected: boolean | null };
};

type HwmonDevice = { path: string; name: string };

export type SensorMap = {
  cpuTemp: string | null;
  cpuModel: string | null;
  systemTemp: string | null;
  igpuTemp: string | null;
  igpuBusy: string | null;
  /** Resolved once at discovery: the name never changes while running. */
  igpuName: string | null;
  fanInputs: string[];
  batteryDir: string | null;
  acDir: string | null;
  nvidiaPciPath: string | null;
  hasNvidiaSmi: boolean;
};

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readNumber(path: string): Promise<Reading> {
  const raw = await readText(path);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** hwmon values are in millidegrees. */
async function readTempC(path: string | null): Promise<Reading> {
  if (!path) return null;
  const milli = await readNumber(path);
  return milli === null ? null : Math.round((milli / 1000) * 10) / 10;
}

/**
 * A readable name for the integrated GPU.
 *
 * sysfs only carries numeric PCI ids for it — 0x1002:0x1638 here — and there is
 * no in-kernel name to read, so this shells out to lspci, which owns the
 * vendor/device database that turns those into "Cezanne [Radeon Vega Series]".
 *
 * Done once at discovery rather than per sample: the name cannot change while
 * the machine is running, and a process spawn on every poll would be absurd.
 *
 * Returns null when lspci is absent, which is common on minimal installs. The
 * caller treats a missing name as "do not show the row" rather than an error.
 */
async function readIgpuName(pciSlot: string | null): Promise<string | null> {
  if (!pciSlot) return null;
  return new Promise((resolve) => {
    execFile('lspci', ['-mm', '-s', pciSlot], { timeout: 3_000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // -mm quotes each field: slot "Class" "Vendor" "Device" ...
      // The third quoted field is the device name, which is the useful one.
      const fields = stdout.match(/"([^"]*)"/g);
      const device = fields?.[2]?.replace(/"/g, '').trim();
      resolve(device && device.length > 0 ? device : null);
    });
  });
}

/**
 * A percentage that is already a percentage.
 *
 * amdgpu's gpu_busy_percent is a whole number 0-100, unlike the millidegree
 * temperatures beside it, so it needs no scaling — only clamping, because a
 * driver returning something outside the range should not put a line off the
 * top of a chart.
 */
async function readPercent(path: string | null): Promise<Reading> {
  if (!path) return null;
  const n = await readNumber(path);
  if (n === null) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

async function listHwmon(): Promise<HwmonDevice[]> {
  let entries: string[];
  try {
    entries = await readdir(HWMON_ROOT);
  } catch {
    return [];
  }
  const devices: HwmonDevice[] = [];
  for (const entry of entries) {
    const path = `${HWMON_ROOT}/${entry}`;
    const name = await readText(`${path}/name`);
    if (name) devices.push({ path, name });
  }
  return devices;
}

/** First existing path from a list of candidates. */
async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if ((await readText(c)) !== null) return c;
  }
  return null;
}

function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('sh', ['-c', `command -v ${bin}`], (err) => resolve(!err));
  });
}

/**
 * CPU model name from /proc/cpuinfo, e.g. "AMD Ryzen 7 5800H with Radeon
 * Graphics". Static hardware info, so this is read once at discovery rather
 * than every tick — unlike temperature or usage, it cannot change while the
 * machine is running.
 */
async function readCpuModel(): Promise<string | null> {
  const info = await readText('/proc/cpuinfo');
  if (!info) return null;
  const line = info.split('\n').find((l) => l.startsWith('model name'));
  if (!line) return null;
  const value = line.split(':')[1]?.trim();
  return value || null;
}

/**
 * Locate every sensor by name. Safe to call repeatedly — and it must be
 * called again after the driver is reloaded, because that is when the fan
 * hwmon appears.
 */
export async function discoverSensors(): Promise<SensorMap> {
  const devices = await listHwmon();
  const byName = (n: string): HwmonDevice | undefined =>
    devices.find((d) => d.name === n);

  // CPU: k10temp (AMD, e.g. Ryzen 7 5800H) or coretemp (Intel).
  const cpuDev = byName('k10temp') ?? byName('coretemp');
  const cpuTemp = cpuDev
    ? await firstExisting([`${cpuDev.path}/temp1_input`, `${cpuDev.path}/temp2_input`])
    : null;
  const cpuModel = await readCpuModel();

  const sysDev = byName('acpitz');
  const systemTemp = sysDev ? await firstExisting([`${sysDev.path}/temp1_input`]) : null;

  const igpuDev = byName('amdgpu');
  const igpuTemp = igpuDev ? await firstExisting([`${igpuDev.path}/temp1_input`]) : null;

  /*
   * amdgpu's utilisation counter.
   *
   * It lives on the DRM device rather than in hwmon, so it is found by walking
   * the cards and asking each one's driver, instead of by hwmon name. The
   * hwmon device does sit under the same PCI device, so its path would also
   * reach it, but that relationship is not guaranteed and the DRM walk is
   * unambiguous.
   */
  let igpuBusy: string | null = null;
  let igpuSlot: string | null = null;
  for (const card of ['card0', 'card1', 'card2', 'card3']) {
    const dev = `/sys/class/drm/${card}/device`;
    const uevent = await readText(`${dev}/uevent`);
    if (uevent === null || !uevent.includes('DRIVER=amdgpu')) continue;
    igpuBusy = await firstExisting([`${dev}/gpu_busy_percent`]);
    // PCI_SLOT_NAME is in the same uevent, and is how lspci is matched below.
    igpuSlot = uevent.match(/PCI_SLOT_NAME=(\S+)/)?.[1] ?? null;
    if (igpuBusy) break;
  }

  const igpuName = await readIgpuName(igpuSlot);

  // Fan RPM: whichever hwmon exposes fan*_input. On Acer hardware this comes
  // from linuwu_sense/acer-wmi, so it is absent until that driver loads.
  const fanInputs: string[] = [];
  for (const dev of devices) {
    for (const idx of [1, 2, 3, 4]) {
      const p = `${dev.path}/fan${idx}_input`;
      if ((await readText(p)) !== null) fanInputs.push(p);
    }
  }

  // Battery / AC, by type rather than by assuming BAT1/ACAD.
  let batteryDir: string | null = null;
  let acDir: string | null = null;
  try {
    for (const entry of await readdir(POWER_SUPPLY_ROOT)) {
      const dir = `${POWER_SUPPLY_ROOT}/${entry}`;
      const type = await readText(`${dir}/type`);
      if (type === 'Battery' && !batteryDir) batteryDir = dir;
      if (type === 'Mains' && !acDir) acDir = dir;
    }
  } catch {
    /* no power supply class */
  }

  // Discrete NVIDIA GPU PCI node, for the runtime-PM gate.
  let nvidiaPciPath: string | null = null;
  try {
    const entries = await readdir(NVIDIA_PCI_ROOT);
    const bdf = entries.find((e) => /^\d{4}:\d{2}:\d{2}\.\d$/.test(e));
    if (bdf) nvidiaPciPath = `${NVIDIA_PCI_ROOT}/${bdf}`;
  } catch {
    /* nvidia driver not bound */
  }

  return {
    cpuTemp,
    cpuModel,
    systemTemp,
    igpuTemp,
    igpuBusy,
    igpuName,
    fanInputs,
    batteryDir,
    acDir,
    nvidiaPciPath,
    hasNvidiaSmi: await which('nvidia-smi'),
  };
}

type CpuSample = { total: number; idle: number };

async function readCpuSample(): Promise<CpuSample | null> {
  const stat = await readText('/proc/stat');
  if (!stat) return null;
  const line = stat.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
  if (parts.length < 4) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
  return {
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    idle: idle + iowait,
  };
}

function cpuUsageFrom(prev: CpuSample, next: CpuSample): Reading {
  const totalDelta = next.total - prev.total;
  const idleDelta = next.idle - prev.idle;
  if (totalDelta <= 0) return null;
  const pct = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

async function readRam(): Promise<Telemetry['ram']> {
  const info = await readText('/proc/meminfo');
  if (!info) return { usedPct: null, totalKb: null, availableKb: null };
  const get = (key: string): Reading => {
    const m = info.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const totalKb = get('MemTotal');
  const availableKb = get('MemAvailable');
  if (totalKb === null || availableKb === null || totalKb === 0) {
    return { usedPct: null, totalKb, availableKb };
  }
  return {
    usedPct: Math.round(((totalKb - availableKb) / totalKb) * 1000) / 10,
    totalKb,
    availableKb,
  };
}

type NvidiaSample = {
  name: string | null;
  tempC: Reading;
  usagePct: Reading;
  clockMhz: Reading;
};

function runNvidiaSmi(timeoutMs = 2_000): Promise<NvidiaSample | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,temperature.gpu,utilization.gpu,clocks.gr', '--format=csv,noheader,nounits'],
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const line = stdout.trim().split('\n')[0];
        if (!line) return resolve(null);
        const [name, temp, util, clock] = line.split(',').map((s) => s.trim());
        const num = (v: string | undefined): Reading => {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };
        resolve({
          name: name || null,
          tempC: num(temp),
          usagePct: num(util),
          clockMhz: num(clock),
        });
      },
    );
  });
}

/**
 * Read the dGPU, but only wake it if it is already awake.
 *
 * runtime_status is a cheap sysfs read; nvidia-smi is not, and calling it on
 * a runtime-suspended card RESUMES it. Gating here is what lets the discrete
 * GPU stay asleep while the dashboard is open, and is what produces the
 * "Discrete GPU is idle" state from the NitroSense UI.
 */
export async function readGpuState(s: SensorMap): Promise<Telemetry['gpu']> {
  const idleState = {
    present: true,
    idle: true,
    name: null,
    tempC: null,
    usagePct: null,
    clockMhz: null,
  };

  if (!s.hasNvidiaSmi || !s.nvidiaPciPath) {
    return { ...idleState, present: false, idle: false };
  }

  const runtimeStatus = await readText(`${s.nvidiaPciPath}/power/runtime_status`);
  if (runtimeStatus === 'suspended') {
    // Deliberately do NOT call nvidia-smi: it would wake the card.
    return idleState;
  }

  const sample = await runNvidiaSmi();
  if (!sample) return idleState;

  return {
    present: true,
    idle: false,
    name: sample.name,
    tempC: sample.tempC,
    usagePct: sample.usagePct,
    clockMhz: sample.clockMhz,
  };
}

export type TelemetryOptions = {
  intervalMs?: number;
  /** Re-run sensor discovery every N ticks, so devices added by a driver reload appear. */
  rediscoverEveryTicks?: number;
};

export class TelemetryPoller extends EventEmitter {
  #intervalMs: number;
  #rediscoverEvery: number;
  #timer: NodeJS.Timeout | null = null;
  #sensors: SensorMap | null = null;
  #prevCpu: CpuSample | null = null;
  #ticks = 0;
  #inFlight = false;

  constructor(opts: TelemetryOptions = {}) {
    super();
    this.#intervalMs = opts.intervalMs ?? 1_000;
    this.#rediscoverEvery = opts.rediscoverEveryTicks ?? 30;
  }

  get sensors(): SensorMap | null {
    return this.#sensors;
  }

  /** Force a re-scan. Call after the Internals Manager reloads the driver. */
  async rediscover(): Promise<SensorMap> {
    this.#sensors = await discoverSensors();
    this.emit('sensors', this.#sensors);
    return this.#sensors;
  }

  async start(): Promise<void> {
    if (this.#timer) return;
    await this.rediscover();
    // Prime the CPU counter so the first emitted sample has a real delta.
    this.#prevCpu = await readCpuSample();
    this.#timer = setInterval(() => void this.#tick(), this.#intervalMs);
    // Brief pause before the first emission so the CPU delta is meaningful;
    // firing immediately would always report null usage on tick 1.
    setTimeout(() => void this.#tick(), 150);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Read every sensor once. */
  async sample(): Promise<Telemetry> {
    if (!this.#sensors) await this.rediscover();
    const s = this.#sensors as SensorMap;

    const [cpuTempC, systemTempC, igpuTempC, igpuUsagePct, ram, cpuSample] = await Promise.all([
      readTempC(s.cpuTemp),
      readTempC(s.systemTemp),
      readTempC(s.igpuTemp),
      readPercent(s.igpuBusy),
      readRam(),
      readCpuSample(),
    ]);

    let usagePct: Reading = null;
    if (this.#prevCpu && cpuSample) usagePct = cpuUsageFrom(this.#prevCpu, cpuSample);
    if (cpuSample) this.#prevCpu = cpuSample;

    const fans = await this.#readFans(s);
    const battery = await this.#readBattery(s);
    const gpu = await readGpuState(s);

    return {
      timestamp: Date.now(),
      cpu: { usagePct, tempC: cpuTempC, model: s.cpuModel },
      gpu,
      igpu: { tempC: igpuTempC, usagePct: igpuUsagePct, name: s.igpuName },
      system: { tempC: systemTempC },
      ram,
      fans,
      battery,
    };
  }

  async #readFans(s: SensorMap): Promise<Telemetry['fans']> {
    if (s.fanInputs.length === 0) return { cpuRpm: null, gpuRpm: null };
    const [cpuRpm, gpuRpm] = await Promise.all([
      readNumber(s.fanInputs[0] as string),
      s.fanInputs[1] ? readNumber(s.fanInputs[1]) : Promise.resolve(null),
    ]);
    return { cpuRpm, gpuRpm };
  }

  async #readBattery(s: SensorMap): Promise<Telemetry['battery']> {
    const percent = s.batteryDir ? await readNumber(`${s.batteryDir}/capacity`) : null;
    const status = s.batteryDir ? await readText(`${s.batteryDir}/status`) : null;
    const online = s.acDir ? await readNumber(`${s.acDir}/online`) : null;
    return { percent, status, acConnected: online === null ? null : online === 1 };
  }

  async #tick(): Promise<void> {
    // Never let slow sensors overlap into a pile-up.
    if (this.#inFlight) return;
    this.#inFlight = true;
    try {
      this.#ticks++;
      if (this.#ticks % this.#rediscoverEvery === 0) await this.rediscover();
      this.emit('telemetry', await this.sample());
    } catch (e) {
      this.emit('error', e);
    } finally {
      this.#inFlight = false;
    }
  }
}
