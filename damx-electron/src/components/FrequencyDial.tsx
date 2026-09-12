/**
 * The large GPU frequency dial on the left of the Home screen.
 *
 * Full-circle tick ring with an inner readout. When the discrete GPU is
 * runtime-suspended the dial empties and says so, rather than showing a
 * misleading 0 MHz — the poller deliberately does not wake the card to get a
 * number.
 */
import type { JSX } from 'react';
import { arcPath, fraction, ticks } from './geometry';

type Props = {
  value: number | null;
  idle: boolean;
  label?: string;
  caption?: string;
  unit?: string;
  max?: number;
  size?: number;
};

const START = 0;
const END = 360;

export function FrequencyDial({
  value,
  idle,
  label = 'GPU',
  caption = 'Frequency',
  unit = 'MHz',
  max = 2600,
  size = 254,
}: Props): JSX.Element {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 26;
  const frac = value === null ? 0 : fraction(value, 0, max);
  const tickMarks = ticks(cx, cy, size / 2 - 3, size / 2 - 14, START, END, 72, frac);

  return (
    <div className="freq-dial">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
           aria-label={`${label} ${caption} ${value === null ? 'unavailable' : `${value} ${unit}`}`}>
        <defs>
          <linearGradient id="dial-grad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--amber)" />
            <stop offset="100%" stopColor="var(--accent-bright)" />
          </linearGradient>
        </defs>

        {tickMarks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
                stroke={t.lit ? 'var(--accent-bright)' : 'var(--border)'}
                strokeWidth={1.5} opacity={t.lit ? 0.9 : 0.45} />
        ))}

        <circle cx={cx} cy={cy} r={r} fill="none"
                stroke="rgba(255,255,255,0.06)" strokeWidth={7} />

        {frac > 0 && (
          <path d={arcPath(cx, cy, r, START, END * frac)} fill="none"
                stroke="url(#dial-grad)" strokeWidth={7} strokeLinecap="round"
                style={{ filter: 'drop-shadow(0 0 8px var(--accent-dim))' }} />
        )}

        <circle cx={cx} cy={cy} r={r - 16} fill="rgba(10,6,4,0.55)" stroke="var(--border)" />

        <text x={cx} y={cy - 26} textAnchor="middle" className="dial-label">{label}</text>
        <text x={cx} y={cy - 8} textAnchor="middle" className="dial-caption">{caption}</text>
        <text x={cx} y={cy + 26} textAnchor="middle" className="dial-value">
          {idle || value === null ? '--' : value}
        </text>
        <text x={cx} y={cy + 44} textAnchor="middle" className="dial-unit">{unit}</text>
      </svg>
      {idle && <span className="dial-idle">Discrete GPU is idle</span>}
    </div>
  );
}
