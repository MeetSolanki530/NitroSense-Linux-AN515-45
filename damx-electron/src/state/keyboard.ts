/**
 * Keyboard lighting value parsing.
 *
 * Two independent sysfs formats, both returned by the daemon as raw strings:
 *
 *   per_zone_mode   "zone1,zone2,zone3,zone4,brightness"
 *                   zones are 6-digit hex without a leading #
 *   four_zone_mode  "mode,speed,brightness,direction,red,green,blue"
 *
 * Effect names are taken from the daemon's own table (DAMX-Daemon.py:652):
 *   0 Static, 1 Breathing, 2 Neon, 3 Wave, 4 Shifting, 5 Zoom, 6 Meteor,
 *   7 Twinkling.
 */

export type PerZone = { zones: [string, string, string, string]; brightness: number };

export type FourZone = {
  mode: number;
  speed: number;
  brightness: number;
  direction: number;
  red: number;
  green: number;
  blue: number;
};

export const EFFECTS: { mode: number; name: string; note?: string }[] = [
  { mode: 0, name: 'Static', note: 'A fixed colour. Speed and direction do not apply.' },
  { mode: 1, name: 'Breathing' },
  { mode: 2, name: 'Neon' },
  { mode: 3, name: 'Wave', note: 'Wave and Shifting drive the same native effect on this hardware.' },
  { mode: 4, name: 'Shifting', note: 'Wave and Shifting drive the same native effect on this hardware.' },
  { mode: 5, name: 'Zoom' },
  { mode: 6, name: 'Meteor' },
  { mode: 7, name: 'Twinkling' },
];

export const DIRECTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'Right to left' },
  { value: 2, label: 'Left to right' },
];

/** Static goes through a different daemon code path that ignores animation. */
export function usesAnimation(mode: number): boolean {
  return mode !== 0;
}

export function usesDirection(mode: number): boolean {
  return mode === 3 || mode === 4;
}

const HEX6 = /^[0-9a-fA-F]{6}$/;

export function normaliseHex(raw: string): string | null {
  const v = raw.trim().replace(/^#/, '');
  return HEX6.test(v) ? v.toLowerCase() : null;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

export function parsePerZone(raw: unknown): PerZone | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split(',').map((p) => p.trim());
  if (parts.length < 5) return null;

  const zones = parts.slice(0, 4).map(normaliseHex);
  if (zones.some((z) => z === null)) return null;

  const brightness = Number(parts[4]);
  if (!Number.isFinite(brightness)) return null;

  return {
    zones: zones as [string, string, string, string],
    brightness: clampInt(brightness, 0, 100),
  };
}

export function parseFourZone(raw: unknown): FourZone | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split(',').map((p) => Number(p.trim()));
  if (parts.length < 7 || parts.some((n) => !Number.isFinite(n))) return null;

  const [mode, speed, brightness, direction, red, green, blue] = parts as number[];
  return {
    mode: clampInt(mode as number, 0, 7),
    speed: clampInt(speed as number, 0, 9),
    brightness: clampInt(brightness as number, 0, 100),
    // Anything outside 1-2 is meaningless; fall back to the daemon's default.
    direction: direction === 2 ? 2 : 1,
    red: clampInt(red as number, 0, 255),
    green: clampInt(green as number, 0, 255),
    blue: clampInt(blue as number, 0, 255),
  };
}

export function hexToRgb(hex: string): { red: number; green: number; blue: number } | null {
  const v = normaliseHex(hex);
  if (!v) return null;
  return {
    red: parseInt(v.slice(0, 2), 16),
    green: parseInt(v.slice(2, 4), 16),
    blue: parseInt(v.slice(4, 6), 16),
  };
}

export function rgbToHex(red: number, green: number, blue: number): string {
  const part = (n: number): string =>
    clampInt(n, 0, 255).toString(16).padStart(2, '0');
  return `${part(red)}${part(green)}${part(blue)}`;
}

export const DEFAULT_PER_ZONE: PerZone = {
  zones: ['ff6a00', 'ff6a00', 'ff6a00', 'ff6a00'],
  brightness: 100,
};

export const DEFAULT_FOUR_ZONE: FourZone = {
  mode: 0, speed: 5, brightness: 100, direction: 1, red: 255, green: 106, blue: 0,
};
