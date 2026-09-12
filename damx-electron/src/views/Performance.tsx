/**
 * Performance — real system-mode switching, plus fan control.
 *
 * The daemon's own thermal_profile is confirmed non-functional on this
 * hardware: every restriction in both the third-party driver and (checked
 * directly against its source) the mainline kernel driver was bypassed, two
 * different target profiles were tested with full call-path logging, and the
 * firmware never applied either — a documented, unresolved class of
 * firmware/ACPI-exposure gap on this laptop family (see electron/cpupower.ts
 * for the full trace), not a decode bug fixable in software.
 *
 * "System Mode" here is the real replacement: CPU governor +
 * energy_performance_preference via this machine's own amd-pstate-epp
 * driver, combined with the daemon's set_fan_speed (which DOES work) for the
 * fan tier of each mode. It is independent of the daemon connection
 * entirely — it still works with the daemon offline, since it never touches
 * the socket for the CPU side.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { ControlBlock, Slider, gateFor, type Gate } from '../components/Control';
import { ModeTile } from '../components/ModeTile';
import { useCommand, useDebounced, useOptimistic } from '../state/useCommand';
import { usePowerState } from '../state/damx';
import type { ConnectionState, PowerMode, PowerState, Settings, Telemetry } from '../state/damx';
import './Performance.css';

type Props = {
  settings: Settings | null;
  telemetry: Telemetry | null;
  has: (feature: string) => boolean;
  connection: ConnectionState;
  refresh: () => Promise<void>;
};

/** The daemon treats 0/0 as automatic. */
function isAuto(settings: Settings | null): boolean {
  const fan = settings?.fan_speed;
  if (!fan) return true;
  return Number(fan.cpu ?? 0) === 0 && Number(fan.gpu ?? 0) === 0;
}

function fanValue(settings: Settings | null, key: 'cpu' | 'gpu'): number {
  const raw = Number(settings?.fan_speed?.[key] ?? 0);
  return Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
}

const POWER_MODES: PowerMode[] = ['quiet', 'balanced', 'performance'];
const POWER_MODE_LABEL: Record<PowerMode, string> = {
  quiet: 'Quiet',
  balanced: 'Balanced',
  performance: 'Performance',
};

function powerModeGate(state: PowerState | null): Gate {
  if (state === null) return { ok: false, reason: 'Checking…' };
  if (!state.available) {
    return {
      ok: false,
      reason: state.driver
        ? 'No supported backend (power-profiles-daemon or pkexec)'
        : 'This CPU has no energy_performance_preference to control',
    };
  }
  return { ok: true };
}

export function Performance({
  settings, telemetry, has, connection, refresh,
}: Props): JSX.Element {
  const connected = connection === 'connected';
  const { run, busy, error, clearError } = useCommand(refresh);

  const fanGate = gateFor('fan_speed', has, connected);

  // Shared with Home, so both stay consistent — it is independent of the
  // daemon entirely and must keep working (and updating) even while the
  // daemon is disconnected.
  const { state: powerState, refresh: reloadPowerState } = usePowerState();

  const {
    run: runMode, busy: modeBusy, error: modeError, clearError: clearModeError,
  } = useCommand(reloadPowerState);

  const gate = powerModeGate(powerState);
  const currentMode = useOptimistic(powerState?.currentMode ?? null);

  const auto = isAuto(settings);
  const [manual, setManual] = useState(!auto);
  // useState's initializer only runs at mount, when `settings` is still null
  // (the first get_all_settings hasn't resolved yet) — isAuto(null) is always
  // true, so this would otherwise show "Automatic" selected forever whenever
  // the daemon's real fan_speed was already in manual mode when the app
  // opened (e.g. left that way by a previous session), while the sliders
  // underneath still displayed the true non-zero duty values. Sync once,
  // the first time real settings arrive, so the toggle reflects hardware
  // truth on load; after that, only explicit clicks (setAuto/enterManual/a
  // System Mode selection) change it, preserving "entering Manual does not
  // write until a slider moves" against the 5s settings poll.
  const syncedInitialFanMode = useRef(false);
  useEffect(() => {
    if (!syncedInitialFanMode.current && settings) {
      setManual(!isAuto(settings));
      syncedInitialFanMode.current = true;
    }
  }, [settings]);
  const cpuFan = useOptimistic(fanValue(settings, 'cpu'));
  const gpuFan = useOptimistic(fanValue(settings, 'gpu'));

  const pushFan = useDebounced((cpu: number, gpu: number) => {
    // Reset unconditionally, not only on failure. useOptimistic clears
    // `pending` when it matches the refreshed `actual` exactly — but run()
    // has already awaited refresh() by the time this callback fires, so the
    // true value is available now. Relying on equality alone would leave
    // the requested number stuck on screen forever if the driver ever
    // rounds or clamps it to something else on success (harmless today,
    // since this daemon writes fan_speed verbatim, but the hook is shared
    // and should not silently hide a future mismatch).
    void run(() => window.damx.setFanSpeed(cpu, gpu)).then(() => {
      cpuFan.reset();
      gpuFan.reset();
    });
  }, 150);

  const setAuto = (): void => {
    setManual(false);
    cpuFan.setPending(0);
    gpuFan.setPending(0);
    void run(() => window.damx.setFanSpeed(0, 0)).then(() => {
      cpuFan.reset();
      gpuFan.reset();
    });
  };

  const enterManual = (): void => {
    setManual(true);
    // Do not write yet: switching to Manual should not change fan behaviour
    // until the user actually moves a slider.
  };

  const selectPowerMode = (mode: PowerMode): void => {
    currentMode.setPending(mode);
    // The mode drives fan speed too (Performance runs fans at maximum;
    // Quiet/Balanced return them to automatic) — reflect that in the Fan
    // Control section's own toggle immediately, otherwise it would keep
    // showing whatever it last showed while the sliders underneath quietly
    // display the new values. Optimistic here for the same reason the fan
    // sliders are: real feedback shouldn't wait on a possibly-slow pkexec
    // password prompt.
    const goingManual = mode === 'performance';
    setManual(goingManual);
    if (!goingManual) { cpuFan.setPending(0); gpuFan.setPending(0); }

    void runMode(() => window.damx.setPowerMode(mode)).then(() => {
      currentMode.reset();
      cpuFan.reset();
      gpuFan.reset();
    });
  };

  return (
    <div className="performance">
      {(error || modeError) && (
        <div className="write-error" role="alert">
          <span>{error ?? modeError}</span>
          <button
            type="button"
            onClick={() => { clearError(); clearModeError(); }}
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      <ControlBlock
        title="System Mode"
        gate={gate}
        hint={
          gate.ok
            ? `Switches CPU governor and power preference (${powerState?.driver ?? 'amd-pstate-epp'}) ` +
              'and adjusts fan speed to match. Independent of the daemon — this keeps working even ' +
              'if it is offline.'
            : undefined
        }
      >
        <div className="mode-tiles">
          {POWER_MODES.map((mode) => (
            <ModeTile
              key={mode}
              name={mode}
              label={POWER_MODE_LABEL[mode]}
              selected={currentMode.value === mode}
              disabled={!gate.ok || modeBusy}
              onSelect={() => selectPowerMode(mode)}
            />
          ))}
        </div>
        {gate.ok && powerState && (
          <p className="control-hint dim">
            {powerState.governor} · {powerState.epp}
            {powerState.backend === 'sysfs-pkexec' && ' · applied directly (no power-profiles-daemon found)'}
          </p>
        )}
      </ControlBlock>

      <ControlBlock
        title="Fan Control"
        gate={fanGate}
        hint="Automatic lets the firmware manage the fans. Manual holds a fixed duty cycle. A System Mode selection also sets this."
      >
        <div className="fan-mode">
          <button
            type="button"
            className={`seg${!manual ? ' seg-active' : ''}`}
            disabled={!fanGate.ok || busy}
            onClick={setAuto}
          >
            Automatic
          </button>
          <button
            type="button"
            className={`seg${manual ? ' seg-active' : ''}`}
            disabled={!fanGate.ok}
            onClick={enterManual}
          >
            Manual
          </button>
        </div>

        <div className={`fan-sliders${manual ? '' : ' is-muted'}`}>
          <Slider
            label="CPU fan"
            value={cpuFan.value}
            disabled={!fanGate.ok || !manual}
            onChange={(v) => { cpuFan.setPending(v); pushFan(v, gpuFan.value); }}
          />
          <Slider
            label="GPU fan"
            value={gpuFan.value}
            disabled={!fanGate.ok || !manual}
            onChange={(v) => { gpuFan.setPending(v); pushFan(cpuFan.value, v); }}
          />
        </div>

        <div className="fan-live">
          <Readout label="CPU fan" value={telemetry?.fans.cpuRpm ?? null} unit=" RPM" />
          <Readout label="GPU fan" value={telemetry?.fans.gpuRpm ?? null} unit=" RPM" />
          <Readout label="CPU temp" value={telemetry?.cpu.tempC ?? null} unit="°C" />
          <Readout
            label="GPU temp"
            value={telemetry?.gpu.idle ? null : (telemetry?.gpu.tempC ?? null)}
            unit="°C"
          />
        </div>
        {telemetry?.fans.cpuRpm === null && (
          <p className="control-hint dim">
            Fan RPM needs the linuwu_sense hwmon; it appears once the driver is loaded.
          </p>
        )}
      </ControlBlock>
    </div>
  );
}

function Readout({ label, value, unit }: {
  label: string; value: number | null; unit: string;
}): JSX.Element {
  return (
    <div className="readout">
      <span className="readout-label">{label}</span>
      <span className="readout-value mono-num">
        {value === null ? <span className="dim">--</span> : `${Math.round(value)}${unit}`}
      </span>
    </div>
  );
}
