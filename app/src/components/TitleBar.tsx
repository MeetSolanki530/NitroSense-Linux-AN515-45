/**
 * Frameless window chrome: logo mark, tab strip, connection pill, window
 * controls. The whole bar is a drag region except the interactive parts.
 */
import type { ConnectionState } from '../state/hardware';
import type { JSX } from 'react';

export type Tab = { id: string; label: string };

type Props = {
  tabs: Tab[];
  active: string;
  onSelect: (id: string) => void;
  connection: ConnectionState;
  /**
   * Hidden while the hardware service is unreachable. Every section behind
   * these needs it, so navigation would only lead to dead screens. Defaults to
   * shown so nothing else has to opt in.
   */
  showTabs?: boolean;
};

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: 'Daemon connected',
  connecting: 'Connecting…',
  disconnected: 'Daemon offline',
  reinitializing: 'Reinitializing…',
};

export function TitleBar({
  tabs, active, onSelect, connection, showTabs = true,
}: Props): JSX.Element {
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        {/* The NitroSense "N" mark, as layered SVG rather than a 3D asset. */}
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
          <defs>
            <linearGradient id="mark" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-bright)" />
              <stop offset="100%" stopColor="var(--accent)" />
            </linearGradient>
          </defs>
          <path d="M6 28 L6 4 L13 4 L13 17 L20 4 L26 4 L26 28 L19 28 L19 14 L12 28 Z" fill="url(#mark)" />
        </svg>
      </div>

      {/* The nav element stays in the layout even when empty, so the brand and
          the status pill keep their positions and the bar does not reflow when
          the service comes up. */}
      <nav className="titlebar-tabs">
        {showTabs && tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab${t.id === active ? ' tab-active' : ''}`}
            onClick={() => onSelect(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="titlebar-right">
        <span className={`conn conn-${connection}`} title={CONNECTION_LABEL[connection]}>
          <i className="conn-dot" />
          {CONNECTION_LABEL[connection]}
        </span>
        <div className="window-controls">
          <button type="button" aria-label="Minimize" onClick={() => window.nitrosense.window.minimize()}>
            <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1" y="5" width="9" height="1" fill="currentColor" /></svg>
          </button>
          <button type="button" aria-label="Maximize" onClick={() => window.nitrosense.window.maximize()}>
            <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1.5" y="1.5" width="8" height="8" fill="none" stroke="currentColor" /></svg>
          </button>
          <button type="button" aria-label="Close" className="close" onClick={() => window.nitrosense.window.close()}>
            <svg width="11" height="11" viewBox="0 0 11 11"><path d="M1 1 L10 10 M10 1 L1 10" stroke="currentColor" fill="none" /></svg>
          </button>
        </div>
      </div>
    </header>
  );
}
