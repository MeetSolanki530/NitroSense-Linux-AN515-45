/**
 * Multi-series trend chart for the Monitoring view.
 *
 * Gaps matter here: a suspended GPU or an absent fan sensor produces nulls,
 * and those must break the line rather than plunge it to zero, which would
 * read as "the GPU cooled to 0 degrees".
 */
import type { JSX } from 'react';
import { buildSegments, latestReading } from './series';

export type Series = {
  label: string;
  colour: string;
  points: (number | null)[];
};

type Props = {
  series: Series[];
  max: number;
  unit: string;
  height?: number;
};

export function TrendChart({ series, max, unit, height = 150 }: Props): JSX.Element {
  const width = 600; // viewBox units; the SVG scales to its container
  // All series share one time axis anchored at the right edge.
  const longest = Math.max(1, ...series.map((s) => s.points.length));

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="trend">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="trend-svg"
        role="img"
        aria-label={series.map((s) => s.label).join(', ')}
      >
        {gridLines.map((g) => (
          <line
            key={g}
            x1={0} x2={width}
            y1={height * g} y2={height * g}
            stroke="rgba(255,255,255,0.07)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {series.map((s) =>
          buildSegments(s.points, { width, height, max, capacity: longest }).map((pts, i) => (
            <polyline
              key={`${s.label}-${i}`}
              points={pts}
              fill="none"
              stroke={s.colour}
              strokeWidth={1.8}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )),
        )}

      </svg>

      <div className="trend-axis">
        <span>{max}{unit}</span>
        <span>0{unit}</span>
      </div>

      <div className="trend-legend">
        {series.map((s) => {
          const last = latestReading(s.points);
          return (
            <span className="legend-item" key={s.label}>
              <i style={{ background: s.colour }} />
              {s.label}
              <b className="mono-num">
                {last === null ? '--' : `${Math.round(last)}${unit}`}
              </b>
            </span>
          );
        })}
      </div>
    </div>
  );
}
