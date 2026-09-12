/**
 * First-run setup for the NitroSense key.
 *
 * Asked once. The answer — a key, or an explicit "no" — is remembered in the
 * app's own config, so this never reappears on later launches.
 *
 * How detection works is unusual and worth knowing when reading this: the app
 * cannot listen for the key. /dev/input is root:input, and Electron's
 * globalShortcut has no XF86Launch* accelerators. So main binds every
 * candidate at once, each launching this same app with a marker; pressing the
 * key starts a second process, the single-instance lock forwards its argv, and
 * the marker names the key. See electron/nitro-key.ts.
 *
 * That means the window genuinely does relaunch-and-focus mid-setup, which is
 * why the listening state tells the user the window may flicker.
 */
import { useEffect, useState, type JSX } from 'react';
import type { NitroKeyState } from '../state/damx';
import './NitroKeySetup.css';

type Phase = 'intro' | 'listening' | 'done' | 'failed';

export function NitroKeySetup(): JSX.Element | null {
  const [state, setState] = useState<NitroKeyState | null>(null);
  const [phase, setPhase] = useState<Phase>('intro');
  const [bound, setBound] = useState<string | null>(null);

  useEffect(() => {
    void window.damx.nitroKeyState().then(setState).catch(() => undefined);
  }, []);

  // Listen for a candidate firing. Registered for the component's whole life
  // rather than only while listening, so a press that lands between state
  // transitions is not missed.
  useEffect(() => {
    return window.damx.onNitroKey(({ accelerator }) => {
      setPhase((p) => {
        if (p !== 'listening') return p;
        setBound(accelerator);
        void window.damx
          .nitroKeyConfirm(accelerator)
          .then(() => setPhase('done'))
          .catch(() => setPhase('failed'));
        return 'done';
      });
    });
  }, []);

  // Nothing to ask once the user has answered, and nothing to offer on a
  // desktop with no custom-shortcut store.
  if (!state || state.decided || !state.available) return null;

  const begin = (): void => {
    setPhase('listening');
    void window.damx.nitroKeyBegin().then(({ ok }) => {
      if (!ok) setPhase('failed');
    }).catch(() => setPhase('failed'));
  };

  const decline = (): void => {
    void window.damx.nitroKeyDecline().catch(() => undefined);
    setState({ ...state, decided: true });
  };

  const cancel = (): void => {
    void window.damx.nitroKeyCancel().catch(() => undefined);
    setPhase('intro');
  };

  const close = (): void => setState({ ...state, decided: true });

  return (
    <div className="nks-backdrop" role="dialog" aria-modal="true" aria-label="NitroSense key setup">
      <section className="nks-card">
        <svg viewBox="0 0 32 32" width="40" height="40" aria-hidden="true" className="nks-mark">
          <defs>
            <linearGradient id="nks-g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-bright)" />
              <stop offset="100%" stopColor="var(--accent)" />
            </linearGradient>
          </defs>
          <path d="M6 28 L6 4 L13 4 L13 17 L20 4 L26 4 L26 28 L19 28 L19 14 L12 28 Z" fill="url(#nks-g)" />
        </svg>

        {phase === 'intro' && (
          <>
            <h2>Use your NitroSense key?</h2>
            <p>
              The key above the keyboard can open this app. Which key your model
              sends varies, so you press it once and it is remembered.
            </p>
            <div className="nks-actions">
              <button type="button" className="nks-primary" onClick={begin}>Set it up</button>
              <button type="button" className="nks-ghost" onClick={decline}>Not now</button>
            </div>
          </>
        )}

        {phase === 'listening' && (
          <>
            <h2>Press your NitroSense key</h2>
            <p>Press it once now. The window may flash as it is detected.</p>
            <div className="nks-bar"><i /></div>
            <div className="nks-actions">
              <button type="button" className="nks-ghost" onClick={cancel}>Cancel</button>
            </div>
          </>
        )}

        {phase === 'done' && (
          <>
            <h2>Done</h2>
            <p>
              {bound
                ? <>Your key (<code>{bound}</code>) now opens this app, even when it is closed.</>
                : <>Your key now opens this app.</>}
            </p>
            <div className="nks-actions">
              <button type="button" className="nks-primary" onClick={close}>Close</button>
            </div>
          </>
        )}

        {phase === 'failed' && (
          <>
            <h2>Could not set it up</h2>
            <p>
              The shortcut could not be written. You can try again from a
              terminal with <code>./scripts/setup-nitro-key.sh</code>.
            </p>
            <div className="nks-actions">
              <button type="button" className="nks-primary" onClick={decline}>Close</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
