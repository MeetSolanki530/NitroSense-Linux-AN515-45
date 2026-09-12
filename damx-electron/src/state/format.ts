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

/**
 * The driver writes -1 for backlight_timeout, boot_animation_sound and
 * lcd_override on this model — but that does NOT mean the feature is
 * unimplemented. Traced against the driver source (linuwu_sense.c): the WMI
 * GET call for all three succeeds every time; the show() function just
 * compares the raw result against hardcoded magic constants lifted from a
 * different Acer model, and anything that doesn't match falls into a "-1"
 * catch-all — even a clean value like `1` (confirmed via dmesg:
 * `boot_animation_sound get status: 1` still yields sysfs content "-1",
 * because 1 is neither of the two constants the driver recognises).
 *
 * Critically, SET does not depend on decoding GET at all — it writes fixed
 * constants of its own. Confirmed directly: writing 1 to backlight_timeout
 * logged `backlight_timeout set status: 0` with no ACPI failure, twice, on
 * real hardware. So "-1" means "this model's GET response isn't in the
 * driver's lookup table", not "not supported" — the toggle must stay
 * usable, only the displayed current-state must fall back to unknown
 * (toBool('-1') already returns null for exactly this reason).
 *
 * Kept for the explanatory hint in the UI, not to disable anything.
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
