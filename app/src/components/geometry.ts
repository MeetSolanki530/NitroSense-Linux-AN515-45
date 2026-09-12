/**
 * Polar helpers for the SVG gauges.
 *
 * Angles are degrees clockwise from 12 o'clock, which is how the gauges in
 * the NitroSense UI read (arc opens at the bottom, sweeping left to right).
 */

export type Point = { x: number; y: number };

export function polar(cx: number, cy: number, r: number, deg: number): Point {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** Arc as an SVG path, swept clockwise from startDeg to endDeg. */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  const sweep = endDeg - startDeg;
  // A full circle cannot be drawn as a single arc segment; nudge it closed.
  const end = Math.abs(sweep) >= 360 ? startDeg + 359.99 : endDeg;
  const a = polar(cx, cy, r, startDeg);
  const b = polar(cx, cy, r, end);
  const largeArc = Math.abs(end - startDeg) > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${largeArc} 1 ${b.x} ${b.y}`;
}

/** 0..1 position of `value` within [min,max], clamped. */
export function fraction(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

export type Tick = { x1: number; y1: number; x2: number; y2: number; lit: boolean };

/**
 * The tick ring around each gauge. Ticks up to the current value are "lit";
 * the rest stay dim, which is what gives the dials their machined look.
 */
export function ticks(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startDeg: number,
  endDeg: number,
  count: number,
  litFraction: number,
): Tick[] {
  const out: Tick[] = [];
  const span = endDeg - startDeg;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const deg = startDeg + span * t;
    const a = polar(cx, cy, rInner, deg);
    const b = polar(cx, cy, rOuter, deg);
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, lit: t <= litFraction });
  }
  return out;
}
