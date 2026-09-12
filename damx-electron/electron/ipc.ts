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
import type { Telemetry } from './telemetry.ts';

export const CH = {
  invoke: 'damx:invoke',
  telemetry: 'damx:telemetry',
  state: 'damx:state',
  connection: 'damx:connection',
} as const;

class ValidationError extends Error {}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function intInRange(v: unknown, lo: number, hi: number, label: string): number {
  if (!isInt(v) || v < lo || v > hi) {
    throw new ValidationError(`${label} must be an integer between ${lo} and ${hi} (got ${String(v)})`);
  }
  return v;
}

function bool(v: unknown, label: string): boolean {
  if (typeof v !== 'boolean') throw new ValidationError(`${label} must be a boolean (got ${String(v)})`);
  return v;
}

function hexColor(v: unknown, label: string): string {
  if (typeof v !== 'string' || !/^[0-9a-fA-F]{6}$/.test(v)) {
    throw new ValidationError(`${label} must be a 6-digit hex colour like "ff6a00" (got ${String(v)})`);
  }
  return v.toLowerCase();
}

const MODPROBE_PARAMS: ReadonlySet<string> = new Set(['nitro_v4', 'predator_v4', 'enable_all']);

function modprobeParam(v: unknown): ModprobeParam {
  if (typeof v !== 'string' || !MODPROBE_PARAMS.has(v)) {
    throw new ValidationError(`parameter must be one of ${[...MODPROBE_PARAMS].join(', ')}`);
  }
  return v as ModprobeParam;
}

export type Services = {
  client: DamxClient;
  internals: InternalsManager;
  telemetry: TelemetryPoller;
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
    const profile = a.profile;
    if (typeof profile !== 'string' || profile.length === 0) {
      throw new ValidationError('profile must be a non-empty string');
    }
    // The daemon only accepts values the kernel reports, so check against the
    // live list rather than a hardcoded set.
    const current = unwrap(await client.send('get_thermal_profile')) as { available?: string[] };
    const available = current?.available ?? [];
    if (available.length > 0 && !available.includes(profile)) {
      throw new ValidationError(`profile must be one of ${available.join(', ')} (got "${profile}")`);
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
  setUsbCharging: async ({ client }, a) => {
    const level = a.level;
    if (!isInt(level) || ![0, 10, 20, 30].includes(level)) {
      throw new ValidationError(`level must be 0, 10, 20 or 30 (got ${String(level)})`);
    }
    return unwrap(await client.send('set_usb_charging', { level }));
  },

  // ---- keyboard rgb ----
  setPerZoneMode: async ({ client }, a) => {
    const zones = a.zones;
    if (!Array.isArray(zones) || zones.length !== 4) {
      throw new ValidationError('zones must be an array of exactly 4 hex colours');
    }
    return unwrap(
      await client.send('set_per_zone_mode', {
        zone1: hexColor(zones[0], 'zones[0]'),
        zone2: hexColor(zones[1], 'zones[1]'),
        zone3: hexColor(zones[2], 'zones[2]'),
        zone4: hexColor(zones[3], 'zones[3]'),
        brightness: intInRange(a.brightness, 0, 100, 'brightness'),
      }),
    );
  },

  setFourZoneMode: async ({ client }, a) =>
    unwrap(
      await client.send('set_four_zone_mode', {
        mode: intInRange(a.mode, 0, 7, 'mode'),
        speed: intInRange(a.speed, 0, 9, 'speed'),
        brightness: intInRange(a.brightness, 0, 100, 'brightness'),
        direction: intInRange(a.direction, 1, 2, 'direction'),
        red: intInRange(a.red, 0, 255, 'red'),
        green: intInRange(a.green, 0, 255, 'green'),
        blue: intInRange(a.blue, 0, 255, 'blue'),
      }),
    ),

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
