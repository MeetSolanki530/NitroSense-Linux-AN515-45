/**
 * Switch control.
 *
 * Tri-state: a null value means the daemon could not report the current
 * state, which renders as "unknown" rather than off. Showing off for an
 * unreadable feature would misrepresent the hardware.
 *
 * "Unknown" never disables the switch on its own — a control whose GET is
 * merely unreliable stays usable, since SET does not depend on the same
 * decoder (confirmed for backlight_timeout: it now reads a real value after
 * being written once). `broken` is a separate, stronger claim: this specific
 * control was tested with repeated real writes and the hardware never
 * responded even once, so it is disabled outright rather than left inviting
 * a click that can never do anything (confirmed for lcd_override: 5 writes,
 * each logging success, the read-back value never changed even by one bit).
 */
import type { JSX, ReactNode } from 'react';
import type { Tri } from '../state/format';

type Props = {
  label: string;
  description?: ReactNode;
  value: Tri;
  disabled?: boolean;
  busy?: boolean;
  /** Set when writes have been directly confirmed to have no hardware
   *  effect (not merely an unreadable state) — disables the switch with a
   *  distinct badge, rather than the usual "unknown". */
  broken?: string;
  onChange: (next: boolean) => void;
};

export function Toggle({
  label, description, value, disabled, busy, broken, onChange,
}: Props): JSX.Element {
  const unknown = value === null && !broken;
  return (
    <div className={`toggle-row${disabled || broken ? ' is-disabled' : ''}`}>
      <div className="toggle-text">
        <span className="toggle-label">{label}</span>
        {description && <span className="toggle-desc dim">{description}</span>}
        {broken && <span className="toggle-broken dim">{broken}</span>}
      </div>
      <div className="toggle-side">
        {broken && <span className="toggle-unknown">not applied</span>}
        {unknown && <span className="toggle-unknown">unknown</span>}
        <button
          type="button"
          role="switch"
          aria-checked={value === true}
          aria-label={label}
          disabled={disabled || busy || Boolean(broken)}
          className={`switch${value === true ? ' is-on' : ''}${unknown ? ' is-unknown' : ''}`}
          onClick={() => onChange(!(value === true))}
        >
          <span className="switch-knob" />
        </button>
      </div>
    </div>
  );
}
