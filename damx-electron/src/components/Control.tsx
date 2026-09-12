/**
 * Shared control chrome.
 *
 * A control whose feature the daemon does not report is rendered DISABLED
 * WITH A REASON rather than hidden — per the plan, that is how a driver
 * problem stays distinguishable from a UI bug.
 */
import type { JSX, ReactNode } from 'react';

export type Gate = { ok: true } | { ok: false; reason: string };

export function gateFor(
  feature: string,
  has: (f: string) => boolean,
  connected: boolean,
): Gate {
  if (!connected) return { ok: false, reason: 'Daemon offline' };
  if (!has(feature)) {
    return { ok: false, reason: `Not reported by the driver (${feature})` };
  }
  return { ok: true };
}

export function ControlBlock({
  title, gate, children, hint,
}: {
  title: string;
  gate: Gate;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`panel control-block${gate.ok ? '' : ' is-disabled'}`}>
      <div className="control-head">
        <h2 className="panel-title">{title}</h2>
        {!gate.ok && <span className="control-reason">{gate.reason}</span>}
      </div>
      <div className="control-body" aria-disabled={!gate.ok}>
        {children}
      </div>
      {hint && <p className="control-hint dim">{hint}</p>}
    </section>
  );
}

export function Slider({
  label, value, onChange, disabled, min = 0, max = 100, unit = '%',
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  unit?: string;
}): JSX.Element {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className={`slider${disabled ? ' is-disabled' : ''}`}>
      <div className="slider-head">
        <span className="slider-label">{label}</span>
        <span className="slider-value mono-num">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--fill' as string]: `${pct}%` }}
        aria-label={label}
      />
    </div>
  );
}
