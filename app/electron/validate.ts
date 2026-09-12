/**
 * Argument validation for the IPC boundary.
 *
 * Separate from ipc.ts so it carries no Electron import and can be unit
 * tested directly. These rules deliberately mirror the daemon's own checks:
 * the daemon rejects bad values anyway, but a buggy or compromised renderer
 * should never reach it.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export function intInRange(v: unknown, lo: number, hi: number, label: string): number {
  if (!isInt(v) || v < lo || v > hi) {
    throw new ValidationError(
      `${label} must be an integer between ${lo} and ${hi} (got ${String(v)})`,
    );
  }
  return v;
}

export function bool(v: unknown, label: string): boolean {
  if (typeof v !== 'boolean') {
    throw new ValidationError(`${label} must be a boolean (got ${String(v)})`);
  }
  return v;
}

export function hexColor(v: unknown, label: string): string {
  if (typeof v !== 'string' || !/^[0-9a-fA-F]{6}$/.test(v)) {
    throw new ValidationError(
      `${label} must be a 6-digit hex colour like "ff6a00" (got ${String(v)})`,
    );
  }
  return v.toLowerCase();
}

/** The daemon accepts only these four USB charging levels. */
export const USB_CHARGING_LEVELS = [0, 10, 20, 30] as const;

export function usbChargingLevel(v: unknown): number {
  if (!isInt(v) || !USB_CHARGING_LEVELS.includes(v as 0 | 10 | 20 | 30)) {
    throw new ValidationError(
      `level must be one of ${USB_CHARGING_LEVELS.join(', ')} (got ${String(v)})`,
    );
  }
  return v;
}

export const MODPROBE_PARAMS = ['nitro_v4', 'predator_v4', 'enable_all'] as const;
export type ModprobeParamName = (typeof MODPROBE_PARAMS)[number];

export function modprobeParam(v: unknown): ModprobeParamName {
  if (typeof v !== 'string' || !MODPROBE_PARAMS.includes(v as ModprobeParamName)) {
    throw new ValidationError(`parameter must be one of ${MODPROBE_PARAMS.join(', ')}`);
  }
  return v as ModprobeParamName;
}

export const POWER_MODES = ['quiet', 'balanced', 'performance'] as const;
export type PowerModeName = (typeof POWER_MODES)[number];

export function powerMode(v: unknown): PowerModeName {
  if (typeof v !== 'string' || !POWER_MODES.includes(v as PowerModeName)) {
    throw new ValidationError(`mode must be one of ${POWER_MODES.join(', ')}`);
  }
  return v as PowerModeName;
}

export function nonEmptyString(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return v;
}

export function zoneColors(v: unknown): [string, string, string, string] {
  if (!Array.isArray(v) || v.length !== 4) {
    throw new ValidationError('zones must be an array of exactly 4 hex colours');
  }
  return [
    hexColor(v[0], 'zones[0]'),
    hexColor(v[1], 'zones[1]'),
    hexColor(v[2], 'zones[2]'),
    hexColor(v[3], 'zones[3]'),
  ];
}

/** Four-zone effect parameters, matching the daemon's documented ranges. */
export function fourZoneConfig(a: Record<string, unknown>): {
  mode: number; speed: number; brightness: number; direction: number;
  red: number; green: number; blue: number;
} {
  return {
    mode: intInRange(a.mode, 0, 5, 'mode'),
    speed: intInRange(a.speed, 0, 9, 'speed'),
    brightness: intInRange(a.brightness, 0, 100, 'brightness'),
    direction: intInRange(a.direction, 1, 2, 'direction'),
    red: intInRange(a.red, 0, 255, 'red'),
    green: intInRange(a.green, 0, 255, 'green'),
    blue: intInRange(a.blue, 0, 255, 'blue'),
  };
}
