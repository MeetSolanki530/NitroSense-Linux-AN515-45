/**
 * Real thermal/performance mode switching.
 *
 * The daemon's platform_profile mechanism does not work on this hardware —
 * confirmed by direct testing (electron/damx-client.ts's thermal_profile
 * commands reach the driver, the driver's WMI call reports success, and the
 * firmware never applies it; a documented, unresolved firmware/ACPI-exposure
 * gap on this laptop family, not a decode bug we can patch around).
 *
 * On AN515-45 specifically, Windows' NitroSense "performance modes" are
 * confirmed (via the laptop's own review coverage) to be a thin wrapper over
 * *standard Windows power plans* rather than a proprietary Acer EC command.
 * The real Linux equivalent already exists and works: this machine's Ryzen
 * runs the `amd-pstate-epp` cpufreq driver, which exposes exactly the same
 * concept — governor + energy_performance_preference — natively, with no
 * custom driver and no ACPI reverse-engineering required.
 *
 * Two ways to apply a change, tried in order:
 *
 *   1. power-profiles-daemon, via `gdbus` (no extra npm dependency — this
 *      mirrors how nvidia-smi is already shelled out to elsewhere in this
 *      codebase). This is the standard freedesktop/GNOME abstraction for
 *      exactly this concept, usually pre-installed, and its own polkit
 *      policy typically allows the active session user to switch profiles
 *      with no password at all. Used first because it coordinates with
 *      anything else on the system that also watches power profiles,
 *      instead of fighting it with a second, uncoordinated writer.
 *
 *   2. Direct sysfs writes across every core's
 *      scaling_governor/energy_performance_preference, elevated with
 *      `pkexec` (present and setuid on this system). Falls back to this
 *      only if power-profiles-daemon is not running.
 *
 * Neither path touches the DAMX daemon in any way.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

const CPUFREQ_ROOT = '/sys/devices/system/cpu';

export type PowerBackend = 'power-profiles-daemon' | 'sysfs-pkexec' | 'unavailable';

export type PowerMode = 'quiet' | 'balanced' | 'performance';

export type PowerState = {
  available: boolean;
  backend: PowerBackend;
  driver: string | null;
  governor: string | null;
  epp: string | null;
  availableGovernors: string[];
  availableEpp: string[];
  /** Best-effort classification of the current governor+epp pair. null if it
   *  does not match any of our three modes (e.g. changed by another tool). */
  currentMode: PowerMode | null;
};

/** What each mode actually asks for. Chosen so the extremes are genuinely
 *  distinct: Quiet minimises both CPU aggressiveness and noise, Performance
 *  maximises both, Balanced sits at the driver's own real-world default
 *  (observed on this hardware: powersave + balance_performance). */
const MODE_TARGETS: Record<PowerMode, { governor: string; epp: string; cpuFan: number; gpuFan: number }> = {
  quiet: { governor: 'powersave', epp: 'power', cpuFan: 0, gpuFan: 0 },
  balanced: { governor: 'powersave', epp: 'balance_performance', cpuFan: 0, gpuFan: 0 },
  performance: { governor: 'performance', epp: 'performance', cpuFan: 100, gpuFan: 100 },
};

export function targetFor(mode: PowerMode): { governor: string; epp: string; cpuFan: number; gpuFan: number } {
  return MODE_TARGETS[mode];
}

function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function listCpus(): Promise<string[]> {
  try {
    const entries = await readdir(CPUFREQ_ROOT);
    const cpus: string[] = [];
    for (const e of entries) {
      if (/^cpu\d+$/.test(e)) {
        const path = `${CPUFREQ_ROOT}/${e}/cpufreq`;
        if ((await readText(`${path}/scaling_governor`)) !== null) cpus.push(path);
      }
    }
    return cpus.sort();
  } catch {
    return [];
  }
}

async function which(bin: string): Promise<boolean> {
  const r = await run('sh', ['-c', `command -v ${bin}`]);
  return r.code === 0;
}

/** power-profiles-daemon's three profiles map directly onto ours. */
const PPD_PROFILE: Record<PowerMode, string> = {
  quiet: 'power-saver',
  balanced: 'balanced',
  performance: 'performance',
};
const PPD_PROFILE_REVERSE: Record<string, PowerMode> = {
  'power-saver': 'quiet',
  balanced: 'balanced',
  performance: 'performance',
};

async function ppdGetActiveProfile(): Promise<string | null> {
  const r = await run('gdbus', [
    'call', '--system',
    '--dest', 'net.hadess.PowerProfiles',
    '--object-path', '/net/hadess/PowerProfiles',
    '--method', 'org.freedesktop.DBus.Properties.Get',
    'net.hadess.PowerProfiles', 'ActiveProfile',
  ]);
  if (r.code !== 0) return null;
  // gdbus prints e.g.  (<'balanced'>,)
  const m = r.stdout.match(/<'([^']+)'>/);
  return m ? (m[1] as string) : null;
}

async function ppdSetActiveProfile(profile: string): Promise<boolean> {
  const r = await run('gdbus', [
    'call', '--system',
    '--dest', 'net.hadess.PowerProfiles',
    '--object-path', '/net/hadess/PowerProfiles',
    '--method', 'org.freedesktop.DBus.Properties.Set',
    'net.hadess.PowerProfiles', 'ActiveProfile', `<'${profile}'>`,
  ]);
  return r.code === 0;
}

/** Detects which backend can actually be used right now, without assuming. */
async function detectBackend(): Promise<PowerBackend> {
  if (await which('gdbus')) {
    const active = await ppdGetActiveProfile();
    if (active !== null) return 'power-profiles-daemon';
  }
  if (await which('pkexec')) {
    const cpus = await listCpus();
    if (cpus.length > 0) return 'sysfs-pkexec';
  }
  return 'unavailable';
}

export async function readPowerState(): Promise<PowerState> {
  const cpus = await listCpus();
  if (cpus.length === 0) {
    return {
      available: false, backend: 'unavailable', driver: null, governor: null, epp: null,
      availableGovernors: [], availableEpp: [], currentMode: null,
    };
  }

  const first = cpus[0] as string;
  const [driver, governor, epp, availableGovernorsRaw, availableEppRaw] = await Promise.all([
    readText(`${first}/scaling_driver`),
    readText(`${first}/scaling_governor`),
    readText(`${first}/energy_performance_preference`),
    readText(`${first}/scaling_available_governors`),
    readText(`${first}/energy_performance_available_preferences`),
  ]);

  const availableGovernors = availableGovernorsRaw ? availableGovernorsRaw.split(/\s+/).filter(Boolean) : [];
  const availableEpp = availableEppRaw ? availableEppRaw.split(/\s+/).filter(Boolean) : [];

  const backend = await detectBackend();

  // If power-profiles-daemon is the live backend, its own active profile is
  // the more authoritative source of "current mode" than re-deriving it from
  // raw governor/epp, since ppd may have applied something outside our three
  // targets' exact shape.
  let currentMode: PowerMode | null = null;
  if (backend === 'power-profiles-daemon') {
    const active = await ppdGetActiveProfile();
    currentMode = active ? (PPD_PROFILE_REVERSE[active] ?? null) : null;
  } else {
    currentMode = (Object.keys(MODE_TARGETS) as PowerMode[]).find(
      (m) => MODE_TARGETS[m].governor === governor && MODE_TARGETS[m].epp === epp,
    ) ?? null;
  }

  return {
    available: backend !== 'unavailable' && availableEpp.length > 0,
    backend,
    driver,
    governor,
    epp,
    availableGovernors,
    availableEpp,
    currentMode,
  };
}

export type ApplyResult = { ok: boolean; backend: PowerBackend; error?: string };

/** Applies governor+EPP only. Fan speed is orchestrated by the IPC layer,
 *  which also calls the daemon's existing, already-working setFanSpeed —
 *  kept separate so this module never needs to know about the daemon. */
export async function applyPowerMode(mode: PowerMode): Promise<ApplyResult> {
  const target = MODE_TARGETS[mode];
  const backend = await detectBackend();

  if (backend === 'power-profiles-daemon') {
    const ok = await ppdSetActiveProfile(PPD_PROFILE[mode]);
    return ok
      ? { ok: true, backend }
      : { ok: false, backend, error: 'power-profiles-daemon rejected the profile change' };
  }

  if (backend === 'sysfs-pkexec') {
    const cpus = await listCpus();
    // One pkexec call writing every core, rather than one per core: pkexec's
    // polkit prompt would otherwise appear up to 16 times per mode switch.
    const script = cpus
      .map((c) => `echo '${target.governor}' > '${c}/scaling_governor'; ` +
                  `echo '${target.epp}' > '${c}/energy_performance_preference';`)
      .join(' ');
    const r = await run('pkexec', ['sh', '-c', script], 20_000);
    return r.code === 0
      ? { ok: true, backend }
      : { ok: false, backend, error: r.stderr.trim() || `pkexec exited ${r.code}` };
  }

  return { ok: false, backend: 'unavailable', error: 'No supported power-management backend found' };
}
