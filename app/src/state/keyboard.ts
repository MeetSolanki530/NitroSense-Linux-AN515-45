/**
 * Keyboard lighting value parsing.
 *
 * Two independent sysfs formats, both returned by the daemon as raw strings:
 *
 *   per_zone_mode   "zone1,zone2,zone3,zone4,brightness"
 *                   zones are 6-digit hex without a leading #
 *   four_zone_mode  "mode,speed,brightness,direction,red,green,blue"
 *
 * The mode numbers were established by sweeping all 256 values on AN515-45
 * hardware, not taken from another implementation:
 *
 *   0        off
 *   1 to 6   Breathing, Neon, Wave, Shifting, Zoom, Meteor
 *   7 to 255 nothing, the keyboard stays dark
 *
 * Mode 0 is off, not static. The firmware writes byte 0 of the payload
 * straight into the EC's KBLE register with no validation, and KBLE 0
 * switches the backlight off. Calling it Static, which every other
 * implementation does, produced an app that turned the keyboard off when the
 * user asked for a fixed colour.
 *
 * Mode 6 does work. It was previously written off as dead because it was
 * being sent with speed 0, which parks any animated effect at the dark end of
 * its cycle.
 *
 * per_zone_mode writes land correctly in the EC's KB1R..KB4B registers, but
 * no mode displays them: every effect reads KBCR/KBCG/KBCB instead. So there
 * is no per-zone colour on this model through this interface. See
 * docs-rgb-findings.md.
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

/**
 * Mode 0 is Off, not Static.
 *
 * Read out of this machine's own firmware. The WMI handler writes byte 0 of
 * the payload straight into the EC's KBLE register with no validation, and
 * KBLE 0 switches the backlight off. 1 to 5 are the real effects.
 *
 * It was labelled Static because every other implementation labels it that,
 * and the result was an app that turned your keyboard off when you asked for
 * a fixed colour. The write succeeded, the colours were provably correct in
 * the EC's KB1R..KB4B registers, and nothing lit, which is why it looked like
 * broken hardware rather than a wrong mode number.
 *
 * There is no known way to display a fixed colour on AN515-45. The zone
 * colours reach the hardware but no KBLE value has been found that shows
 * them; the effects use KBCR/KBCG/KBCB instead. See docs-rgb-findings.md.
 */
export const EFFECTS: Effect[] = [
  { mode: 0, name: 'Off', usesColour: false, usesSpeed: false, usesDirection: false,
    note: 'Switches the keyboard lighting off.' },
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
  { mode: 6, name: 'Meteor', usesColour: true, usesSpeed: true, usesDirection: false,
    note: 'Drops the colour down the keyboard. Needs a speed above zero.' },
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
    mode: clampInt(mode as number, 0, 6),
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

  // Mode 0 is off, so the preview shows unlit keys rather than a colour.
  if (fourZone.mode === 0) {
    const dark = '#15100c';
    return {
      swatches: [dark, dark, dark, dark],
      glows: ['transparent', 'transparent', 'transparent', 'transparent'],
      brightness: 100,
      caption: 'Lighting is off.',
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
