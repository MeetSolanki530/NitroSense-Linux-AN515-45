/**
 * Parsing for daemon setting values.
 *
 * The daemon reads these straight out of sysfs and returns them as strings,
 * so "0"/"1" is the normal shape. A missing or unparseable value must read as
 * "unknown" rather than silently defaulting to off — a toggle that shows
 * "off" for a feature it cannot read is lying about hardware state.
 */
import type { Settings } from './damx';

export type Tri = true | false | null;

export function toBool(raw: unknown): Tri {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'on' || v === 'enabled') return true;
    if (v === '0' || v === 'false' || v === 'off' || v === 'disabled') return false;
  }
  return null;
}

export function settingBool(settings: Settings | null, key: string): Tri {
  if (!settings || !(key in settings)) return null;
  return toBool(settings[key]);
}

export const USB_LEVELS = [0, 10, 20, 30] as const;
export type UsbLevel = (typeof USB_LEVELS)[number];

/** USB charging is reported as a string percentage; only four are valid. */
export function usbLevel(settings: Settings | null): UsbLevel | null {
  const raw = settings?.usb_charging;
  if (raw === undefined || raw === null) return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return (USB_LEVELS as readonly number[]).includes(n) ? (n as UsbLevel) : null;
}

export function usbLabel(level: UsbLevel | null): string {
  if (level === null) return '--';
  return level === 0 ? 'Off' : `${level}%`;
}

/** Battery status text, kept out of JSX for testability. */
export function batterySummary(
  percent: number | null,
  status: string | null,
  acConnected: boolean | null,
): string {
  if (percent === null) return '--';
  const parts = [`${percent}%`];
  if (status) parts.push(status);
  else if (acConnected !== null) parts.push(acConnected ? 'AC' : 'Battery');
  return parts.join(' · ');
}
