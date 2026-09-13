/**
 * Keyboard lighting value parsing.
 *
 * Two independent sysfs formats, both returned by the daemon as raw strings:
 *
 *   per_zone_mode   "zone1,zone2,zone3,zone4,brightness"
 *                   zones are 6-digit hex without a leading #
 *   four_zone_mode  "mode,speed,brightness,direction,red,green,blue"
 *
 * Acer's WMI interface implements six effects:
 *   0 Static, 1 Breathing, 2 Neon, 3 Wave, 4 Shifting, 5 Zoom.
 *
 * The driver's switch also has cases for 6 (Meteor) and 7 (Twinkling), and
 * the daemon's table repeats them, but the firmware never implemented those
 * two: writing either is accepted and leaves the keyboard dark. Confirmed on
 * AN515-45, and every independent reverse-engineering of this interface
 * (facer, Acer-SenSe) stops at 5.
 */

/** Mid-range, matching what the effect tiles start on. */
export const DEFAULT_EFFECT_SPEED = 5;

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

/**
 * Which inputs each effect actually uses.
 *
 * The driver used to zero the fields it believed an effect ignored, which on
 * AN515-45 switched several effects off outright (a breath at speed 0 sits at
 * the dark end of its cycle). It now passes everything through except for
 * static, so these flags describe what the firmware itself honours.
 */
export type Effect = {
  mode: number;
  name: string;
  usesColour: boolean;
  usesSpeed: boolean;
  usesDirection: boolean;
  note?: string;
};

export const EFFECTS: Effect[] = [
  { mode: 0, name: 'Static', usesColour: true, usesSpeed: false, usesDirection: false,
    note: 'A fixed colour. Speed and direction do not apply.' },
  { mode: 1, name: 'Breathing', usesColour: true, usesSpeed: true, usesDirection: false,
    note: 'Pulses the colour on and off. Speed sets the rate.' },
  { mode: 2, name: 'Neon', usesColour: false, usesSpeed: true, usesDirection: false,
    note: 'Cycles through its own colours, so the colour picker does not apply.' },
  { mode: 3, name: 'Wave', usesColour: false, usesSpeed: true, usesDirection: true,
    note: 'Sweeps its own colours across the zones in the chosen direction.' },
  { mode: 4, name: 'Shifting', usesColour: true, usesSpeed: true, usesDirection: true,
    note: 'The only effect that uses every input.' },
  { mode: 5, name: 'Zoom', usesColour: true, usesSpeed: true, usesDirection: false,
    note: 'Pulses out from the centre of the keyboard.' },
];

export function effectFor(mode: number): Effect {
  return EFFECTS.find((e) => e.mode === mode) ?? (EFFECTS[0] as Effect);
}

/**
 * Keep an animated effect from being applied at speed 0.
 *
 * Static is stored with speed 0 — correctly, it has no animation — and the
 * driver writes that 0 back, so it is what the next read returns. Carrying it
 * into Breathing or Wave asks the firmware to animate at zero speed, which
 * parks the keyboard at the dark end of the cycle and is indistinguishable
 * from the effect not working.
 */
export function withUsableSpeed(fz: FourZone): FourZone {
  if (!usesAnimation(fz.mode) || fz.speed > 0) return fz;
  return { ...fz, speed: DEFAULT_EFFECT_SPEED };
}

/** Used when a colour is needed and the one we have is unusable. */
export const DEFAULT_COLOUR = { red: 255, green: 106, blue: 0 };

/**
 * Keep a colour-using effect from being applied as black.
 *
 * The firmware reports 0,0,0 in the colour fields after a per-zone write and
 * for effects that generate their own colours. Adopting that verbatim and then
 * applying it writes black, and black is indistinguishable from the keyboard
 * being off. Worse, it looks like broken hardware: the Fn brightness keys
 * appear dead too, because scaling black gives black at every level.
 *
 * A zero here therefore means "the firmware had nothing to tell us", not "the
 * user picked black". Effects that generate their own colours are left alone,
 * since the field is ignored for those anyway.
 */
export function withUsableColour(fz: FourZone): FourZone {
  if (!usesColour(fz.mode)) return fz;
  if (fz.red > 0 || fz.green > 0 || fz.blue > 0) return fz;
  return { ...fz, ...DEFAULT_COLOUR };
}

export const DIRECTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'Right to left' },
  { value: 2, label: 'Left to right' },
];

/** Speed is honoured by every effect except Static. */
export function usesAnimation(mode: number): boolean {
  return effectFor(mode).usesSpeed;
}

/** Only Wave and Shifting act on direction. */
export function usesDirection(mode: number): boolean {
  return effectFor(mode).usesDirection;
}

/** Neon and Wave generate their own colours, so a colour choice does nothing. */
export function usesColour(mode: number): boolean {
  return effectFor(mode).usesColour;
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
    mode: clampInt(mode as number, 0, 5),
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

export type LightingPreview = {
  /** CSS background for each zone, in order. */
  swatches: [string, string, string, string];
  /**
   * A plain colour per zone for the glow beneath it.
   *
   * Separate from `swatches` because a swatch may be a gradient, and a
   * gradient is not a colour: box-shadow and friends silently ignore one.
   */
  glows: [string, string, string, string];
  brightness: number;
  caption: string;
};

/** Shown for effects that generate their own colours, so no single swatch fits. */
const OWN_COLOURS =
  'linear-gradient(90deg,#ff0040,#ff8a00,#ffe400,#00d26a,#00b3ff,#7a5cff)';

/**
 * What the keyboard is actually doing, from the two reads.
 *
 * The keyboard has one lighting state but reports it through two files, and
 * only one of them is meaningful at a time. The mode says which: applying an
 * effect leaves four_zone_mode reporting that mode, while applying per-zone
 * colours leaves it reporting 0 (Static). So mode 0 means the per-zone
 * colours are what is lit, and anything else means the effect is.
 *
 * Deriving it from the firmware rather than remembering the last button
 * clicked means it is still right after a restart, and right when the colour
 * was changed by something other than this app.
 */
export function describeLighting(perZone: PerZone, fourZone: FourZone): LightingPreview {
  const effect = effectFor(fourZone.mode);

  if (fourZone.mode === 0) {
    const zones = perZone.zones.map((hex) => `#${hex}`) as LightingPreview['swatches'];
    return {
      swatches: zones,
      glows: [...zones] as LightingPreview['glows'],
      brightness: perZone.brightness,
      caption: 'Per-zone colours. Indicative only, not a live capture of the keyboard.',
    };
  }

  const detail = [`${effect.name} at speed ${fourZone.speed}`];
  if (effect.usesDirection) {
    detail.push(fourZone.direction === 2 ? 'left to right' : 'right to left');
  }

  if (!effect.usesColour) {
    // One representative colour from the sweep, since the glow needs a colour
    // and the effect has no single one.
    const glow = '#ff8a00';
    return {
      swatches: [OWN_COLOURS, OWN_COLOURS, OWN_COLOURS, OWN_COLOURS],
      glows: [glow, glow, glow, glow],
      brightness: fourZone.brightness,
      caption: `${detail.join(', ')}. It cycles its own colours, so this is indicative only.`,
    };
  }

  const hex = `#${rgbToHex(fourZone.red, fourZone.green, fourZone.blue)}`;
  return {
    swatches: [hex, hex, hex, hex],
    glows: [hex, hex, hex, hex],
    brightness: fourZone.brightness,
    caption: `${detail.join(', ')}. Animation is not shown, only the colour.`,
  };
}

export const DEFAULT_PER_ZONE: PerZone = {
  zones: ['ff6a00', 'ff6a00', 'ff6a00', 'ff6a00'],
  brightness: 100,
};

export const DEFAULT_FOUR_ZONE: FourZone = {
  mode: 0, speed: DEFAULT_EFFECT_SPEED, brightness: 100, direction: 1,
  red: 255, green: 106, blue: 0,
};
