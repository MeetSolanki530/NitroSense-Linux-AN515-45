/**
 * Usage sparkline — the small history graphs under the frequency dial.
 * Gaps (null readings) break the line rather than being drawn as zero.
 */
import type { JSX } from 'react';

type Props = {
  history: (number | null)[];
  label: string;
  value: number | null;
  width?: number;
  height?: number;
  max?: number;
};

export function Sparkline({
  history, label, value, width = 132, height = 46, max = 100,
}: Props): JSX.Element {
  const pts = history.length > 1 ? history : [];
  const step = pts.length > 1 ? width / (pts.length - 1) : width;

  // Split into runs of consecutive real readings so gaps stay gaps.
  const segments: string[] = [];
  let current: string[] = [];
  pts.forEach((v, i) => {
    if (v === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    const x = i * step;
    const y = height - (Math.min(max, Math.max(0, v)) / max) * height;
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));

  const areaPath =
    segments.length === 1
      ? `M ${segments[0]?.split(' ')[0]} L ${segments[0]} L ${width},${height} L 0,${height} Z`
      : '';

  return (
    <div className="sparkline">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
           role="img" aria-label={`${label} history`}>
        <defs>
          <linearGradient id={`spark-${label.replace(/\s+/g, '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.38" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {areaPath && <path d={areaPath} fill={`url(#spark-${label.replace(/\s+/g, '')})`} />}
        {segments.map((s, i) => (
          <polyline key={i} points={s} fill="none" stroke="var(--accent-bright)"
                    strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
        ))}
      </svg>
      <span className="sparkline-label">{label}</span>
      <span className="sparkline-value mono-num">
        {value === null ? <span className="dim">--</span> : `${Math.round(value)}%`}
      </span>
    </div>
  );
}
