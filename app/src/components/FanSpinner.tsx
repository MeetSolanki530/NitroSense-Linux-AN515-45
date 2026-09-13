/**
 * A fan that turns at a rate reflecting its real RPM.
 *
 * Purely a readout. It never writes anything, and it takes its speed from
 * telemetry, so it follows the hardware whether the fan was set by this app,
 * by a power mode, or by the firmware deciding on its own. That also means it
 * is correct straight after a restart with no state to restore: the RPM read
 * is the source of truth, not anything the app remembered.
 */
import type { JSX } from 'react';
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
      <svg viewBox="0 0 40 40" className="fan-spinner-blades" aria-hidden="true">
        {/* Five blades, each the same shape rotated about the hub. Drawn as
            curves rather than straight spokes so the direction of rotation
            reads at a glance. */}
        {[0, 72, 144, 216, 288].map((angle) => (
          <path
            key={angle}
            d="M20 20 C 20 11, 25 5, 31 5 C 31 12, 26 18, 20 20 Z"
            transform={`rotate(${angle} 20 20)`}
          />
        ))}
        <circle cx="20" cy="20" r="4.2" className="fan-spinner-hub" />
      </svg>
    </span>
  );
}
