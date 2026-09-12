/**
 * Turns a sampled series into SVG polyline segments.
 *
 * Two rules that matter for correctness:
 *
 *  1. Nulls BREAK the line rather than plotting as zero. A suspended GPU or
 *     an absent fan sensor reads as "no data", and drawing it at zero would
 *     claim the GPU cooled to 0 degrees.
 *
 *  2. Series are anchored at the RIGHT edge, so the newest sample is always
 *     rightmost. Series start at different times (the GPU line only begins
 *     when the card wakes), and plotting each from the left would put
 *     readings from different moments in the same column.
 */

export type SegmentOptions = {
  width: number;
  height: number;
  max: number;
  /** Bottom of the plotted range. Defaults to 0 for backward compatibility;
   *  a caller doing auto-scaling passes the data's own floor instead. */
  min?: number;
  /** Total sample slots; usually the longest series across the chart. */
  capacity: number;
};

export function buildSegments(
  points: (number | null)[],
  { width, height, max, min = 0, capacity }: SegmentOptions,
): string[] {
  if (capacity <= 1 || points.length === 0) return [];

  const span = max - min;
  const step = width / (capacity - 1);
  const offset = capacity - points.length; // right-align
  const segments: string[] = [];
  let run: string[] = [];

  points.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length > 1) segments.push(run.join(' '));
      run = [];
      return;
    }
    const x = (offset + i) * step;
    const clamped = Math.min(max, Math.max(min, v));
    const y = span > 0 ? height - ((clamped - min) / span) * height : height;
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });

  if (run.length > 1) segments.push(run.join(' '));
  return segments;
}

/**
 * A "nice" [min, max] range that contains every finite value across all
 * series, with padding so lines never touch the top/bottom edge and a
 * minimum span so a near-flat set of readings does not blow up into an
 * exaggerated zig-zag. Rounds to the nearest `step` for readable axis labels
 * (e.g. 40/60 rather than 43.2/58.7).
 *
 * Falls back to [0, fallbackMax] when there is no real data yet, so the
 * chart still renders sensibly on the very first samples.
 */
export function autoRange(
  seriesPoints: (number | null)[][],
  fallbackMax: number,
  { minSpan = 20, paddingFraction = 0.15, step = 5 } = {},
): { min: number; max: number } {
  const values = seriesPoints
    .flat()
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));

  if (values.length === 0) return { min: 0, max: fallbackMax };

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const pad = Math.max(minSpan * paddingFraction, (dataMax - dataMin) * paddingFraction);

  let lo = Math.floor((dataMin - pad) / step) * step;
  let hi = Math.ceil((dataMax + pad) / step) * step;

  // Enforce a minimum span so near-identical readings do not turn a flat
  // line into a chart that looks like it is swinging wildly.
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = Math.floor((mid - minSpan / 2) / step) * step;
    hi = Math.ceil((mid + minSpan / 2) / step) * step;
  }

  lo = Math.max(0, lo);
  hi = Math.min(fallbackMax, Math.max(hi, lo + step));
  // hi may have been pulled back down by the fallbackMax clamp to the point
  // it no longer clears lo (e.g. readings already sitting near fallbackMax).
  if (hi - lo < step) lo = Math.max(0, hi - step);

  return { min: lo, max: hi };
}

/** Most recent non-null reading, or null when the series has no data. */
export function latestReading(points: (number | null)[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}
