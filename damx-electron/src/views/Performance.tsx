/**
 * Performance — thermal profile and fan control. The first view that writes.
 *
 * Mode tiles are built from the kernel's platform_profile_choices rather than
 * a fixed Quiet/Balanced/Performance/Turbo set: the daemon only accepts values
 * the kernel reports, so hardcoding four tiles would offer modes this machine
 * cannot take.
 */
import { useState, type JSX } from 'react';
import { ControlBlock, Slider, gateFor } from '../components/Control';
import { ModeTile } from '../components/ModeTile';
import { useCommand, useDebounced, useOptimistic } from '../state/useCommand';
import { prettyMode, profileUnreadable } from './homeFormat';
import type { ConnectionState, Settings, Telemetry } from '../state/damx';
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

export function Performance({
  settings, telemetry, has, connection, refresh,
}: Props): JSX.Element {
  const connected = connection === 'connected';
  const { run, busy, error, clearError } = useCommand(refresh);

  const profileGate = gateFor('thermal_profile', has, connected);
  const fanGate = gateFor('fan_speed', has, connected);

  const choices = settings?.thermal_profile?.available ?? [];
  const currentProfile = settings?.thermal_profile?.current ?? '';
  const profile = useOptimistic(currentProfile);
  const unreadable = profileUnreadable(currentProfile, choices);

  const auto = isAuto(settings);
  const [manual, setManual] = useState(!auto);
  const cpuFan = useOptimistic(fanValue(settings, 'cpu'));
  const gpuFan = useOptimistic(fanValue(settings, 'gpu'));

  const pushFan = useDebounced((cpu: number, gpu: number) => {
    void run(() => window.damx.setFanSpeed(cpu, gpu)).then((ok) => {
      if (!ok) {
        cpuFan.reset();
        gpuFan.reset();
      }
    });
  }, 150);

  const selectProfile = (name: string): void => {
    profile.setPending(name);
    void run(() => window.damx.setThermalProfile(name)).then((ok) => {
      if (!ok) profile.reset();
    });
  };

  const setAuto = (): void => {
    setManual(false);
    cpuFan.setPending(0);
    gpuFan.setPending(0);
    void run(() => window.damx.setFanSpeed(0, 0)).then((ok) => {
      if (!ok) { cpuFan.reset(); gpuFan.reset(); }
    });
  };

  const enterManual = (): void => {
    setManual(true);
    // Do not write yet: switching to Manual should not change fan behaviour
    // until the user actually moves a slider.
  };

  return (
    <div className="performance">
      {error && (
        <div className="write-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={clearError} aria-label="Dismiss">×</button>
        </div>
      )}

      <ControlBlock
        title="System Mode"
        gate={profileGate}
        hint={
          profileGate.ok
            ? 'Modes come from the kernel’s platform_profile_choices, so only what this machine supports is offered.'
            : undefined
        }
      >
        {unreadable && (
          <p className="profile-warning">
            The driver reports the available profiles but cannot read the current one
            (<code>platform_profile</code> returns an I/O error). Selecting a mode may
            also fail. Acer firmware commonly restricts thermal profiles while on
            battery — try again with the charger connected.
          </p>
        )}
        {choices.length === 0 ? (
          <p className="dim">No thermal profiles reported.</p>
        ) : (
          <div className="mode-tiles">
            {choices.map((name) => (
              <ModeTile
                key={name}
                name={name}
                label={prettyMode(name)}
                selected={profile.value === name}
                disabled={!profileGate.ok || busy}
                onSelect={() => selectProfile(name)}
              />
            ))}
          </div>
        )}
      </ControlBlock>

      <ControlBlock
        title="Fan Control"
        gate={fanGate}
        hint="Automatic lets the firmware manage the fans. Manual holds a fixed duty cycle."
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
