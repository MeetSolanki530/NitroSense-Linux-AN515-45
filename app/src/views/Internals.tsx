/**
 * Internals Manager — driver and model management.
 *
 * This exists because AN515-45 is absent from Compatibility.md and its
 * siblings (AN515-44/47, AN517-54) all require forcing nitro_v4. On that
 * hardware the modprobe parameter decides whether the rest of the app has
 * anything to control.
 *
 * Three command classes, kept visually distinct because they differ in
 * persistence and risk:
 *
 *   Force     applies now, LOST ON REBOOT
 *   Persist   writes /etc/modprobe.d/linuwu-sense.conf, survives reboot
 *   Recovery  restart the service, or rmmod + modprobe + restart
 *
 * Every one of these makes the daemon restart itself mid-request, so each
 * reports a before/after feature diff. A failed modprobe reload returns no
 * error from the daemon — it shows up only as features silently
 * disappearing, so the diff is the sole reliable signal.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { connectionGate, ControlBlock } from '../components/Control';
import type { ConnectionState, InternalsState, OperationResult } from '../state/hardware';
import './Internals.css';

type Props = {
  connection: ConnectionState;
  refresh: () => Promise<void>;
};

type Action = {
  id: string;
  label: string;
  kind: 'force' | 'persist' | 'recovery';
  danger?: boolean;
  description: string;
  run: () => Promise<OperationResult>;
};

const ACTIONS: Action[] = [
  {
    id: 'force-nitro', label: 'Force nitro_v4', kind: 'force',
    description: 'Reload the driver with nitro_v4 now. Lost on reboot.',
    run: () => window.nitrosense.forceModel('nitro_v4'),
  },
  {
    id: 'force-predator', label: 'Force predator_v4', kind: 'force',
    description: 'Reload the driver with predator_v4 now. Lost on reboot.',
    run: () => window.nitrosense.forceModel('predator_v4'),
  },
  {
    id: 'force-all', label: 'Force enable_all', kind: 'force',
    description: 'Reload with every feature forced on. Lost on reboot.',
    run: () => window.nitrosense.forceModel('enable_all'),
  },
  {
    id: 'persist-nitro', label: 'Persist nitro_v4', kind: 'persist',
    description: 'Write nitro_v4 to /etc/modprobe.d and reload. Survives reboot.',
    run: () => window.nitrosense.persistParameter('nitro_v4'),
  },
  {
    id: 'persist-predator', label: 'Persist predator_v4', kind: 'persist',
    description: 'Write predator_v4 to /etc/modprobe.d and reload. Survives reboot.',
    run: () => window.nitrosense.persistParameter('predator_v4'),
  },
  {
    id: 'persist-all', label: 'Persist enable_all', kind: 'persist',
    description: 'Write enable_all to /etc/modprobe.d and reload. Survives reboot.',
    run: () => window.nitrosense.persistParameter('enable_all'),
  },
  {
    id: 'remove-param', label: 'Remove parameter', kind: 'persist',
    description: 'Clear the persistent parameter and fall back to autodetection.',
    run: () => window.nitrosense.removeParameter(),
  },
  {
    id: 'restart-daemon', label: 'Restart daemon', kind: 'recovery',
    description: 'Restart the service only. The driver is left loaded. Safest option.',
    run: () => window.nitrosense.restartDaemon(),
  },
  {
    id: 'restart-drivers', label: 'Reload driver + daemon', kind: 'recovery', danger: true,
    description: 'rmmod then modprobe, then restart the service. Can drop features if the reload fails.',
    run: () => window.nitrosense.restartDriversAndDaemon(),
  },
];

const KIND_LABEL: Record<Action['kind'], string> = {
  force: 'Temporary, lost on reboot',
  persist: 'Persistent, survives reboot',
  recovery: 'Recovery',
};

export function Internals({ connection, refresh }: Props): JSX.Element {
  const connected = connection === 'connected';
  const [state, setState] = useState<InternalsState | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<OperationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await window.nitrosense.internalsState());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const execute = async (action: Action): Promise<void> => {
    setPending(null);
    setRunning(action.id);
    setResult(null);
    setError(null);
    try {
      const r = await action.run();
      setResult(r);
      await load();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(null);
    }
  };

  // One feature (thermal_profile only) is the genuine "the driver could not
  // detect this model" case, and worth suggesting a parameter for.
  //
  // There used to be a second notice here, warning that features working
  // without a parameter meant one had been insmod'd temporarily and would be
  // lost on reboot. That inference is no longer true: the driver carries a DMI
  // entry for this model, so detecting it with no parameter at all is the
  // normal, correct state. The notice fired on every launch and told the user
  // to persist something that was never set.
  const genuinelyIncomplete = state !== null && state.features.length <= 1;

  return (
    <div className="internals-view">
      {error && (
        <div className="write-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <section className="panel">
        <h2 className="panel-title">Driver Status</h2>
        {state ? (
          <>
            <dl className="int-rows">
              <Row label="Laptop type" value={state.laptopType} />
              <Row label="Driver version" value={state.driverVersion || '—'} />
              <Row label="Modprobe parameter" value={state.modprobeParameter || 'none'} />
              <Row label="Daemon version" value={state.daemonVersion || '—'} />
              <Row label="Features" value={`${state.features.length} available`} />
            </dl>
            <div className="feature-chips">
              {state.features.length === 0 ? (
                <span className="dim">No features reported.</span>
              ) : (
                state.features.map((f) => <code key={f} className="chip">{f}</code>)
              )}
            </div>
          </>
        ) : (
          <p className="dim">
            {connected ? 'Reading driver state…' : 'Daemon offline.'}
          </p>
        )}

        {genuinelyIncomplete && (
          <div className="suggest">
            <strong>Features look incomplete and no parameter is set.</strong>
            <p>
              On AN515-series hardware this is usually resolved by forcing
              <code> nitro_v4</code>. Try it temporarily first; make it permanent once
              you have confirmed it helps.
            </p>
          </div>
        )}

      </section>

      {running && (
        <div className="running-banner" role="status">
          <span className="spinner" />
          <div>
            <strong>Working…</strong>
            <p>
              The daemon sleeps 2s + 3s before restarting, then the connection is
              re-established. This usually takes 10–15 seconds.
            </p>
          </div>
        </div>
      )}

      {result && <ResultPanel result={result} />}

      {(['force', 'persist', 'recovery'] as const).map((kind) => (
        <ControlBlock
          key={kind}
          title={
            kind === 'force' ? 'Force Model (temporary)'
              : kind === 'persist' ? 'Set Parameter (permanent)'
              : 'Recovery'
          }
          gate={connectionGate(connected)}
          hint={KIND_LABEL[kind]}
        >
          <div className="action-grid">
            {ACTIONS.filter((a) => a.kind === kind).map((a) => (
              <div className={`action${a.danger ? ' is-danger' : ''}`} key={a.id}>
                <div className="action-text">
                  <span className="action-label">{a.label}</span>
                  <span className="action-desc dim">{a.description}</span>
                </div>
                <button
                  type="button"
                  className={`action-btn${a.danger ? ' is-danger' : ''}`}
                  disabled={!connected || running !== null}
                  onClick={() => setPending(a)}
                >
                  {running === a.id ? 'Working…' : 'Run'}
                </button>
              </div>
            ))}
          </div>
        </ControlBlock>
      ))}

      {pending && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-box">
            <h3>{pending.label}</h3>
            <p>{pending.description}</p>
            <p className="confirm-warn">
              This unloads and reloads the kernel driver and restarts the daemon.
              Hardware controls are unavailable while it runs.
            </p>
            <div className="confirm-actions">
              <button type="button" className="ghost" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={`action-btn${pending.danger ? ' is-danger' : ''}`}
                onClick={() => void execute(pending)}
              >
                Run {pending.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="int-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** The diff is the point: a failed reload surfaces only as lost features. */
function ResultPanel({ result }: { result: OperationResult }): JSX.Element {
  const diff = result.diff;
  return (
    <section className={`panel result-panel${result.ok ? ' is-ok' : ' is-bad'}`}>
      <h2 className="panel-title">
        {result.ok ? 'Completed' : 'Completed with problems'}
      </h2>

      {!result.daemonReturned && (
        <p className="result-fatal">
          The hardware service did not come back. The driver may be unloaded. Recover with:
          <code>sudo modprobe linuwu_sense &amp;&amp; sudo systemctl restart nitrosense-daemon</code>
        </p>
      )}

      {diff && (
        <div className="diff">
          <div className="diff-side">
            <span className="diff-head">Before</span>
            <span className="diff-count">{diff.before.length} features</span>
          </div>
          <span className="diff-arrow">→</span>
          <div className="diff-side">
            <span className="diff-head">After</span>
            <span className="diff-count">{diff.after.length} features</span>
          </div>
        </div>
      )}

      {diff && diff.gained.length > 0 && (
        <p className="diff-gained">
          <strong>Gained</strong> {diff.gained.join(', ')}
        </p>
      )}
      {diff && diff.lost.length > 0 && (
        <p className="diff-lost">
          <strong>Lost</strong> {diff.lost.join(', ')}
        </p>
      )}
      {diff && diff.gained.length === 0 && diff.lost.length === 0 && (
        <p className="dim">No change in available features.</p>
      )}

      {result.warning && <p className="result-warn">{result.warning}</p>}
      {result.error && <p className="result-error">{result.error}</p>}
    </section>
  );
}
