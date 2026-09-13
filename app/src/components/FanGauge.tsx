/**
 * A large fan, turning at its real rate, with the RPM read out in the hub.
 *
 * The small inline spinner beside a number works in a status line, but on the
 * Performance screen the fans are the subject, not an annotation. At this size
 * the reading belongs in the middle of the thing it describes, the way the
 * temperature dials carry theirs.
 *
 * Purely a readout. It never writes anything, and it takes its speed from
 * telemetry, so it follows the hardware whether the fan was set by this app, by
 * a power mode, or by the firmware deciding on its own.
 */
import { useId, type JSX } from 'react';
import { fanSpinSeconds } from '../state/fan';
import './FanGauge.css';

export function FanGauge({
  rpm, label, size = 132,
}: {
  rpm: number | null | undefined;
  label: string;
  size?: number;
}): JSX.Element {
  const seconds = fanSpinSeconds(rpm);
  const stopped = seconds === null;
  const maskId = `fan-gauge-${useId()}`;
  const known = rpm !== null && rpm !== undefined;

  return (
    <div
      className={`fan-gauge${stopped ? ' is-stopped' : ''}`}
      style={{ ['--spin' as string]: `${seconds ?? 0}s` }}
    >
      <div className="fan-gauge-disc" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" role="img"
             aria-label={known ? `${label}: ${rpm} RPM` : `${label}: no reading`}>
          {/*
            The impeller is one filled disc with the blade slots cut out of it
            by a mask. Drawing the blades individually leaves gaps between them
            and reads as a pinwheel; a real fan is very nearly solid.
          */}
          <defs>
            <mask id={maskId}>
              <circle cx="50" cy="50" r="38" fill="#fff" />
              {Array.from({ length: 11 }, (_, i) => i * (360 / 11)).map((angle) => (
                <path
                  key={angle}
                  d="M50 38 Q 60 28 70 20"
                  fill="none"
                  stroke="#000"
                  strokeWidth="5"
                  strokeLinecap="round"
                  transform={`rotate(${angle} 50 50)`}
                />
              ))}
              {/* Bore, so the hub reads as a separate machined part. */}
              <circle cx="50" cy="50" r="21" fill="#000" />
            </mask>
          </defs>

          {/* Housing and grille ring, static. */}
          <circle cx="50" cy="50" r="47" className="fan-gauge-housing" />
          <circle cx="50" cy="50" r="41.5" className="fan-gauge-grille" />

          <g className="fan-gauge-blades">
            <circle cx="50" cy="50" r="38" className="fan-gauge-impeller"
                    mask={`url(#${maskId})`} />
          </g>

          {/* Hub sits still. On a real fan the centre boss barely appears to
              move, and it has to be steady for the number to be readable. */}
          <circle cx="50" cy="50" r="21" className="fan-gauge-hub" />
        </svg>

        <div className="fan-gauge-readout">
          <span className="fan-gauge-rpm mono-num">{known ? rpm : '--'}</span>
          <span className="fan-gauge-unit">RPM</span>
        </div>
      </div>
      <span className="fan-gauge-label">{label}</span>
    </div>
  );
}
