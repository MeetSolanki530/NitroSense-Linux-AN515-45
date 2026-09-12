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
  /** Total sample slots; usually the longest series across the chart. */
  capacity: number;
};

export function buildSegments(
  points: (number | null)[],
  { width, height, max, capacity }: SegmentOptions,
): string[] {
  if (capacity <= 1 || points.length === 0) return [];

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
    const clamped = Math.min(max, Math.max(0, v));
    const y = height - (clamped / max) * height;
    run.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });

  if (run.length > 1) segments.push(run.join(' '));
  return segments;
}

/** Most recent non-null reading, or null when the series has no data. */
export function latestReading(points: (number | null)[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}
