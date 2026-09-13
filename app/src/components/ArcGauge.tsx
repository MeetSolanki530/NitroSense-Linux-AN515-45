/**
 * Temperature arc gauge — the three dials down the right of the Home screen.
 *
 * A 270-degree arc with a tick ring, gradient fill running amber to red, and
 * the value in large Oxanium numerals. A null reading renders "--" with the
 * arc empty, so an unavailable sensor never looks like a cold one.
 */
import type { JSX } from 'react';
import { arcPath, fraction, ticks } from './geometry';

type Props = {
  value: number | null;
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  size?: number;
};

const START = 135;
const END = 405;

export function ArcGauge({
  value,
  label,
  unit = '°C',
  min = 0,
  max = 100,
  size = 168,
}: Props): JSX.Element {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 18;
  const frac = value === null ? 0 : fraction(value, min, max);
  const gradId = `arc-${label.replace(/\s+/g, '-').toLowerCase()}`;

  const tickMarks = ticks(cx, cy, size / 2 - 2, size / 2 - 9, START, END, 44, frac);

  return (
    <div className="arc-gauge">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
           aria-label={`${label} ${value === null ? 'unavailable' : `${value}${unit}`}`}>
        <defs>
          {/* Deep red through to hot, so a full arc looks hotter than a
              quarter one without changing hue. The old amber-to-orange ramp
              referenced tokens that no longer exist. */}
          <linearGradient id={gradId} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--red-deep)" />
            <stop offset="55%" stopColor="var(--red)" />
            <stop offset="100%" stopColor="var(--red-hot)" />
          </linearGradient>
        </defs>

        {tickMarks.map((t, i) => (
          <line
            key={i}
            x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={t.lit ? 'var(--accent-bright)' : 'var(--border)'}
            strokeWidth={1.5}
            opacity={t.lit ? 0.85 : 0.5}
          />
        ))}

        {/* Track */}
        <path d={arcPath(cx, cy, r, START, END)} fill="none"
              stroke="rgba(255,255,255,0.07)" strokeWidth={9} strokeLinecap="round" />

        {/* Value */}
        {frac > 0 && (
          <path
            d={arcPath(cx, cy, r, START, START + (END - START) * frac)}
            fill="none"
            stroke={`url(#${gradId})`}
            strokeWidth={9}
            strokeLinecap="round"
            style={{ filter: 'drop-shadow(0 0 6px var(--accent-dim))' }}
          />
        )}

        <text x={cx} y={cy + 2} textAnchor="middle" className="gauge-value">
          {value === null ? '--' : Math.round(value)}
        </text>
        <text x={cx} y={cy + 20} textAnchor="middle" className="gauge-unit">
          {unit}
        </text>
      </svg>
      <span className="arc-gauge-label">{label}</span>
    </div>
  );
}
