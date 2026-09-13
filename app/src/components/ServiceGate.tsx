/**
 * Shown when the hardware service is not reachable.
 *
 * The app used to drop the user straight into the dashboard with a red banner
 * and every control dead, which is the worst of both: it looks broken and it
 * does not say what to do about it. This takes over the window instead and
 * offers the three things that are actually useful — start it, try again, or
 * leave — rather than leaving the user to find systemctl.
 *
 * Deliberately not a modal over the dashboard. Without the service there is no
 * dashboard worth seeing: fan, battery, keyboard and power controls all need
 * it. Temperatures survive, and they are offered as a way through for anyone
 * who only wants to watch those.
 */
import { useCallback, useState, type JSX } from 'react';
import type { ConnectionState } from '../state/hardware';
import './ServiceGate.css';

type Props = {
  connection: ConnectionState;
};

export function ServiceGate({ connection }: Props): JSX.Element {
  const [busy, setBusy] = useState<null | 'start' | 'retry'>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * One action rather than two.
   *
   * "Start it" and "try again" were separate buttons, which made the user
   * decide which of them applied — and they cannot know, because whether the
   * service is stopped or merely slow is exactly what they are trying to find
   * out. So this does both: reconnect first, in case it is already running and
   * just was not up when the window opened, and only ask for a password if
   * that fails.
   */
  const start = useCallback(async () => {
    setError(null);

    // Free, and avoids a password prompt when the service is already there.
    setBusy('retry');
    try {
      const { state } = await window.nitrosense.reconnect();
      if (state === 'connected') return;
    } catch {
      // Fall through and try starting it.
    }

    setBusy('start');
    try {
      const result = await window.nitrosense.startService();
      if (!result.ok) {
        setError(result.error ?? 'The service did not start.');
        return;
      }
      // systemd returns as soon as the unit is active, which is before the
      // daemon has bound its socket. Give it a moment rather than reporting a
      // failure the user would only have to retry past.
      await new Promise((r) => setTimeout(r, 1_200));
      const { state } = await window.nitrosense.reconnect();
      if (state !== 'connected') {
        setError('The service started but is not answering yet. Try again in a moment.');
      }
    } catch {
      setError('Could not start the service.');
    } finally {
      setBusy(null);
    }
  }, []);

  const quit = useCallback(() => {
    window.nitrosense.window.close();
  }, []);

  const connecting = connection === 'connecting' || connection === 'reinitializing';

  /*
   * While the first connection attempt is still in flight, say only that. The
   * service is usually there and answers in well under a second, and
   * announcing that it is missing before we know is both wrong and alarming.
   */
  if (connecting) {
    return (
      <div className="gate">
        <div className="gate-card gate-card-quiet">
          <div className="gate-mark is-waiting" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="56" height="56">
              <path d="M6 28 L6 4 L13 4 L13 17 L20 4 L26 4 L26 28 L19 28 L19 14 L12 28 Z" />
            </svg>
          </div>
          <p className="gate-body">Connecting to the hardware service…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="56" height="56">
            <path d="M6 28 L6 4 L13 4 L13 17 L20 4 L26 4 L26 28 L19 28 L19 14 L12 28 Z" />
          </svg>
        </div>

        <h1 className="gate-title">Hardware service not running</h1>

        <p className="gate-body">
          NitroSense talks to a small background service for fan, battery,
          keyboard and power control. It is not answering, so those controls
          are unavailable.
        </p>

        {error && <p className="gate-error" role="alert">{error}</p>}

        <div className="gate-actions">
          <button
            type="button"
            className="gate-primary"
            onClick={start}
            disabled={busy !== null}
          >
            {busy === 'retry' && 'Checking…'}
            {busy === 'start' && 'Starting…'}
            {busy === null && 'Start the service'}
          </button>
          <button
            type="button"
            className="gate-secondary"
            onClick={quit}
            disabled={busy !== null}
          >
            Quit
          </button>
        </div>

        <p className="gate-hint">
          Starting it asks for your password. To do it yourself:
          <code>sudo systemctl start nitrosense-daemon</code>
        </p>
      </div>
    </div>
  );
}
