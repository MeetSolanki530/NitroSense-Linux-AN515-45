/**
 * Parsing for daemon setting values.
 *
 * The daemon reads these straight out of sysfs and returns them as strings,
 * so "0"/"1" is the normal shape. A missing or unparseable value must read as
 * "unknown" rather than silently defaulting to off — a toggle that shows
 * "off" for a feature it cannot read is lying about hardware state.
 */
import type { Settings } from './hardware';

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

/**
 * "-1" is the driver's convention for "I could not read this setting".
 *
 * It used to mean two quite different things, and untangling them mattered:
 *
 *  - backlight_timeout read -1 purely because the driver's decoder compared
 *    the whole WMI reply against constants taken from a Predator, so it only
 *    recognised a 30 second timeout. This Nitro shipped with 33 seconds and
 *    fell through to -1 while the feature worked fine. The driver now decodes
 *    the duration field, so this one reports a real on/off.
 *
 *  - boot_animation_sound reads -1 because the firmware returns an error
 *    status for the query, and the same error for writes, which leave the
 *    stored value unchanged. lcd_override reads -1 because the firmware
 *    reports the setting as not applicable, unchanged across five writes that
 *    each claimed success. Both are genuine absences, so both are disabled
 *    outright (Toggle's `broken` prop) rather than inviting a click that can
 *    never do anything.
 *
 * This detector only classifies the raw sysfs value; deciding
 * unknown-but-usable vs. confirmed-broken is the caller's job.
 */
export function isUnsupported(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim() === '-1';
}

export function settingUnsupported(settings: Settings | null, key: string): boolean {
  if (!settings || !(key in settings)) return false;
  return isUnsupported(settings[key]);
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
