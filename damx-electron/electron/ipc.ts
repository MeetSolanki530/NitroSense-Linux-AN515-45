/**
 * IPC boundary.
 *
 * The renderer never receives a generic send(command, params) passthrough.
 * That would hand a sandboxed web context an arbitrary write primitive backed
 * by a root daemon. Instead every capability is a named method here, mapped
 * to a daemon command only AFTER its arguments are validated in main against
 * the daemon's own accepted ranges.
 *
 * Validation duplicates the daemon's rules deliberately: the daemon rejects
 * bad values, but a buggy or compromised renderer should never get that far.
 */

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { DamxClient } from './damx-client.ts';
import type { DamxResponse } from './damx-client.ts';
import { InternalsManager } from './internals.ts';
import type { ModprobeParam } from './internals.ts';
import { TelemetryPoller } from './telemetry.ts';
import {
  bool, fourZoneConfig, intInRange, modprobeParam, nonEmptyString,
  powerMode, usbChargingLevel, zoneColors,
} from './validate.ts';
import type { Telemetry } from './telemetry.ts';
import { applyPowerMode, readPowerState, targetFor } from './cpupower.ts';
import { available as nitroKeyAvailable, CANDIDATES } from './nitro-key.ts';
import type { NitroKey } from './nitro-key.ts';

export const CH = {
  invoke: 'damx:invoke',
  telemetry: 'damx:telemetry',
  state: 'damx:state',
  connection: 'damx:connection',
  /** Fires when a candidate key is pressed during setup detection. */
  nitroKey: 'damx:nitro-key',
} as const;

export type Services = {
  client: DamxClient;
  internals: InternalsManager;
  telemetry: TelemetryPoller;
  nitroKey: NitroKey;
};

type Handler = (services: Services, args: Record<string, unknown>) => Promise<unknown>;

/**
 * The complete renderer-callable surface. Anything not listed here is
 * unreachable from the UI.
 */
const HANDLERS: Record<string, Handler> = {
  // ---- read ----
  getSettings: async ({ client }) => unwrap(await client.send('get_all_settings')),
  getSupportedFeatures: async ({ client }) => unwrap(await client.send('get_supported_features')),
  getVersion: async ({ client }) => unwrap(await client.send('get_version')),
  getModprobeParameter: async ({ client }) => unwrap(await client.send('get_modprobe_parameter')),
  getTelemetry: async ({ telemetry }) => telemetry.sample(),
  getConnectionState: async ({ client }) => client.state,

  // ---- thermal / fan ----
  setThermalProfile: async ({ client }, a) => {
    const profile = nonEmptyString(a.profile, 'profile');
    // The daemon only accepts values the kernel reports, so check against the
    // live list rather than a hardcoded set.
    const current = unwrap(await client.send('get_thermal_profile')) as { available?: string[] };
    const available = current?.available ?? [];
    if (available.length > 0 && !available.includes(profile)) {
      throw new Error(`profile must be one of ${available.join(', ')} (got "${profile}")`);
    }
    return unwrap(await client.send('set_thermal_profile', { profile }));
  },

  setFanSpeed: async ({ client }, a) =>
    unwrap(
      await client.send('set_fan_speed', {
        cpu: intInRange(a.cpu, 0, 100, 'cpu'),
        gpu: intInRange(a.gpu, 0, 100, 'gpu'),
      }),
    ),

  // ---- real thermal/performance mode switching ----
  //
  // The daemon's own thermal_profile is confirmed non-functional on this
  // hardware (see electron/cpupower.ts's header comment for the full trace).
  // This is the working replacement: CPU governor + energy_performance_
  // preference via the standard amd-pstate-epp driver, combined with the
  // daemon's own set_fan_speed (which DOES work) for the fan tier. Two
  // independently-failable systems, so both outcomes are reported rather
  // than collapsed into one boolean — a fan-speed failure must not be
  // hidden behind a successful CPU-mode change or vice versa.
  getPowerState: async () => readPowerState(),

  // --- NitroSense key setup -------------------------------------------
  // Detection works by binding every candidate at once and seeing which one
  // relaunches us; see electron/nitro-key.ts for why listening is not an
  // option here.
  nitroKeyState: async ({ nitroKey }) => ({
    ...(await nitroKey.config()),
    available: await nitroKeyAvailable(),
    candidates: [...CANDIDATES],
  }),
  nitroKeyBegin: async ({ nitroKey }) => ({ ok: await nitroKey.beginDetection() }),
  nitroKeyConfirm: async ({ nitroKey }, a) => {
    const accel = nonEmptyString(a.accelerator, 'accelerator');
    if (!(CANDIDATES as readonly string[]).includes(accel)) {
      throw new Error(`Unknown accelerator: ${accel}`);
    }
    await nitroKey.confirm(accel);
    return { ok: true };
  },
  nitroKeyDecline: async ({ nitroKey }) => {
    await nitroKey.decline();
    return { ok: true };
  },
  nitroKeyCancel: async ({ nitroKey }) => {
    await nitroKey.clearBindings();
    return { ok: true };
  },
  setPowerMode: async ({ client }, a) => {
    const mode = powerMode(a.mode);
    const target = targetFor(mode);

    const cpu = await applyPowerMode(mode);

    let fan: { ok: boolean; error?: string };
    try {
      unwrap(await client.send('set_fan_speed', { cpu: target.cpuFan, gpu: target.gpuFan }));
      fan = { ok: true };
    } catch (e) {
      fan = { ok: false, error: (e as Error).message };
    }

    return { mode, cpu, fan };
  },

  // ---- toggles ----
  setBacklightTimeout: async ({ client }, a) =>
    unwrap(await client.send('set_backlight_timeout', { enabled: bool(a.enabled, 'enabled') })),
  setBatteryLimiter: async ({ client }, a) =>
    unwrap(await client.send('set_battery_limiter', { enabled: bool(a.enabled, 'enabled') })),
  setBatteryCalibration: async ({ client }, a) =>
    unwrap(await client.send('set_battery_calibration', { enabled: bool(a.enabled, 'enabled') })),
  setBootAnimationSound: async ({ client }, a) =>
    unwrap(await client.send('set_boot_animation_sound', { enabled: bool(a.enabled, 'enabled') })),
  setLcdOverride: async ({ client }, a) =>
    unwrap(await client.send('set_lcd_override', { enabled: bool(a.enabled, 'enabled') })),

  // ---- usb charging: the daemon accepts only these four levels ----
  setUsbCharging: async ({ client }, a) =>
    unwrap(await client.send('set_usb_charging', { level: usbChargingLevel(a.level) })),

  // ---- keyboard rgb ----
  setPerZoneMode: async ({ client }, a) => {
    const [zone1, zone2, zone3, zone4] = zoneColors(a.zones);
    return unwrap(
      await client.send('set_per_zone_mode', {
        zone1, zone2, zone3, zone4,
        brightness: intInRange(a.brightness, 0, 100, 'brightness'),
      }),
    );
  },

  setFourZoneMode: async ({ client }, a) =>
    unwrap(await client.send('set_four_zone_mode', fourZoneConfig(a))),

  // ---- internals: each restarts the daemon, so each returns a feature diff ----
  internalsState: async ({ internals }) => internals.readState(),
  forceModel: async ({ internals, telemetry }, a) => {
    const r = await internals.forceModel(modprobeParam(a.parameter));
    await telemetry.rediscover(); // the driver reload may have added the fan hwmon
    return r;
  },
  persistParameter: async ({ internals, telemetry }, a) => {
    const r = await internals.persistParameter(modprobeParam(a.parameter));
    await telemetry.rediscover();
    return r;
  },
  removeParameter: async ({ internals, telemetry }) => {
    const r = await internals.removeParameter();
    await telemetry.rediscover();
    return r;
  },
  restartDaemon: async ({ internals }) => internals.restartDaemon(),
  restartDriversAndDaemon: async ({ internals, telemetry }) => {
    const r = await internals.restartDriversAndDaemon();
    await telemetry.rediscover();
    return r;
  },
};

export const RENDERER_METHODS = Object.keys(HANDLERS);

/** Surface daemon-level failures as thrown errors so the renderer sees one failure mode. */
function unwrap(res: DamxResponse): unknown {
  if (!res.success) throw new Error(res.error ?? 'Daemon reported failure');
  return res.data ?? { message: res.message };
}

export function registerIpc(services: Services, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CH.invoke, async (_event, method: unknown, args: unknown) => {
    if (typeof method !== 'string' || !Object.hasOwn(HANDLERS, method)) {
      return { ok: false, error: `Unknown method: ${String(method)}` };
    }
    const params = (args ?? {}) as Record<string, unknown>;
    try {
      const data = await (HANDLERS[method] as Handler)(services, params);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  const send = (channel: string, payload: unknown): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  services.telemetry.on('telemetry', (t: Telemetry) => send(CH.telemetry, t));
  services.client.on('state', (s: string) => send(CH.connection, s));
}
