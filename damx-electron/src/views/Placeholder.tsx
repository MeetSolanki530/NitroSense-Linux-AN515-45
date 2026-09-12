import type { JSX } from 'react';
/**
 * Step-4 stand-in. Each view lands in its own later step; this keeps the
 * shell navigable and shows which capabilities the daemon reports, so a
 * missing feature is visible as "unavailable" rather than silently absent.
 */
type Props = {
  title: string;
  step: string;
  requires?: string[];
  has: (feature: string) => boolean;
};

export function Placeholder({ title, step, requires = [], has }: Props): JSX.Element {
  return (
    <div className="panel placeholder">
      <h2 className="panel-title">{title}</h2>
      <p className="muted">Arrives in {step}.</p>
      {requires.length > 0 && (
        <ul className="req-list">
          {requires.map((f) => (
            <li key={f} className={has(f) ? 'req-ok' : 'req-missing'}>
              <span className="req-dot" />
              <code>{f}</code>
              <span className="req-state">{has(f) ? 'available' : 'unavailable'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
