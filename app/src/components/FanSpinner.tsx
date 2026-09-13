/**
 * A fan that turns at a rate reflecting its real RPM.
 *
 * Purely a readout. It never writes anything, and it takes its speed from
 * telemetry, so it follows the hardware whether the fan was set by this app,
 * by a power mode, or by the firmware deciding on its own. That also means it
 * is correct straight after a restart with no state to restore: the RPM read
 * is the source of truth, not anything the app remembered.
 */
import { useId, type JSX } from 'react';
import { fanSpinSeconds } from '../state/fan';
import './FanSpinner.css';

export function FanSpinner({
  rpm, size = 34, label,
}: {
  rpm: number | null | undefined;
  size?: number;
  /** Announced to screen readers, which cannot see the thing turning. */
  label: string;
}): JSX.Element {
  const seconds = fanSpinSeconds(rpm);
  const stopped = seconds === null;
  // Masks are referenced by id, so two spinners on one page would otherwise
  // share, and the second would be cut by the first's geometry.
  const maskId = `fan-blades-${useId()}`;

  return (
    <span
      className={`fan-spinner${stopped ? ' is-stopped' : ''}`}
      style={{ width: size, height: size, ['--spin' as string]: `${seconds ?? 0}s` }}
      role="img"
      aria-label={
        rpm === null || rpm === undefined
          ? `${label}: no reading`
          : `${label}: ${rpm} RPM`
      }
      title={rpm === null || rpm === undefined ? `${label}: no reading` : `${rpm} RPM`}
    >
      <svg viewBox="0 0 40 40" aria-hidden="true">
        {/*
          A real impeller is very nearly a solid disc: wide blades that overlap,
          separated by thin slots. Drawing narrow blades with wide gaps between
          them, which is the obvious way to do it, produces a pinwheel.

          So this is built the other way round. The impeller is one filled disc,
          and the slots between the blades are cut out of it with a mask. At
          20 to 34 pixels that reads as a fan; individually stroked blades do
          not survive at this size.
        */}
        <defs>
          <mask id={maskId}>
            <circle cx="20" cy="20" r="16" fill="#fff" />
            {/* Nine slots, swept back from the hub so the blade pitch is
                visible and the direction of rotation reads. */}
            {[0, 40, 80, 120, 160, 200, 240, 280, 320].map((angle) => (
              <path
                key={angle}
                d="M20 14.6 Q 24.4 10.4 28.6 7.4"
                fill="none"
                stroke="#000"
                strokeWidth="2.6"
                strokeLinecap="round"
                transform={`rotate(${angle} 20 20)`}
              />
            ))}
            {/* Bore, so the hub below shows through rather than sitting on a
                filled centre. */}
            <circle cx="20" cy="20" r="4.6" fill="#000" />
          </mask>
        </defs>

        {/* Static housing, outside the rotating group so it does not spin. */}
        <circle cx="20" cy="20" r="18.6" className="fan-ring" />

        <g className="fan-spinner-blades">
          <circle cx="20" cy="20" r="16" className="fan-impeller" mask={`url(#${maskId})`} />
        </g>

        {/* Hub and spindle stay still: on a real fan the centre boss barely
            appears to move, and a spinning dot in the middle looks like a toy. */}
        <circle cx="20" cy="20" r="4.8" className="fan-hub" />
        <circle cx="20" cy="20" r="1.6" className="fan-bore" />
      </svg>
    </span>
  );
}
