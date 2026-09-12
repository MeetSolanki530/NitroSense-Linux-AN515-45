/**
 * Switch control.
 *
 * Tri-state: a null value means the daemon could not report the current
 * state, which renders as "unknown" rather than off. Showing off for an
 * unreadable feature would misrepresent the hardware.
 */
import type { JSX, ReactNode } from 'react';
import type { Tri } from '../state/format';

type Props = {
  label: string;
  description?: ReactNode;
  value: Tri;
  disabled?: boolean;
  busy?: boolean;
  onChange: (next: boolean) => void;
};

export function Toggle({ label, description, value, disabled, busy, onChange }: Props): JSX.Element {
  const unknown = value === null;
  return (
    <div className={`toggle-row${disabled ? ' is-disabled' : ''}`}>
      <div className="toggle-text">
        <span className="toggle-label">{label}</span>
        {description && <span className="toggle-desc dim">{description}</span>}
      </div>
      <div className="toggle-side">
        {unknown && <span className="toggle-unknown">unknown</span>}
        <button
          type="button"
          role="switch"
          aria-checked={value === true}
          aria-label={label}
          disabled={disabled || busy}
          className={`switch${value === true ? ' is-on' : ''}${unknown ? ' is-unknown' : ''}`}
          onClick={() => onChange(!(value === true))}
        >
          <span className="switch-knob" />
        </button>
      </div>
    </div>
  );
}
