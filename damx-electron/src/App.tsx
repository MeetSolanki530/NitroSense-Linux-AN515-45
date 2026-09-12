import { useEffect, useMemo, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import type { Tab } from './components/TitleBar';
import { Placeholder } from './views/Placeholder';
import { useConnection, useSettings, useTelemetry } from './state/damx';
import './components/TitleBar.css';
import './App.css';
import type { JSX } from 'react';

const TABS: Tab[] = [
  { id: 'home', label: 'Home' },
  { id: 'performance', label: 'Performance' },
  { id: 'battery', label: 'Battery' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'internals', label: 'Internals' },
];

export function App(): JSX.Element {
  const [active, setActive] = useState('home');
  const connection = useConnection();
  const telemetry = useTelemetry();
  const { settings, error, has } = useSettings();

  // Mode drives the accent colour app-wide (red at Performance, amber at
  // Balanced), matching the screenshots.
  const mode = settings?.thermal_profile?.current ?? 'balanced';
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);

  const banner = useMemo(() => {
    if (connection === 'reinitializing') {
      return { kind: 'warn', text: 'Driver and daemon are restarting. This takes around 10 seconds.' };
    }
    if (connection === 'disconnected') {
      return {
        kind: 'danger',
        text:
          error ??
          'Cannot reach the DAMX daemon. Telemetry still works; hardware controls are unavailable.',
      };
    }
    return null;
  }, [connection, error]);

  return (
    <div className="app-shell">
      <TitleBar tabs={TABS} active={active} onSelect={setActive} connection={connection} />

      {banner && <div className={`banner banner-${banner.kind}`}>{banner.text}</div>}

      <main className="app-body">
        {active === 'home' && (
          <Placeholder title="Home" step="step 5" has={has}
            requires={['thermal_profile', 'fan_speed']} />
        )}
        {active === 'performance' && (
          <Placeholder title="Performance" step="step 6" has={has}
            requires={['thermal_profile', 'fan_speed']} />
        )}
        {active === 'battery' && (
          <Placeholder title="Battery & Power" step="step 7" has={has}
            requires={['battery_limiter', 'battery_calibration', 'usb_charging', 'lcd_override',
              'boot_animation_sound', 'backlight_timeout']} />
        )}
        {active === 'keyboard' && (
          <Placeholder title="Keyboard Lighting" step="step 8" has={has}
            requires={['per_zone_mode', 'four_zone_mode']} />
        )}
        {active === 'monitoring' && (
          <Placeholder title="Monitoring" step="step 5" has={has} requires={[]} />
        )}
        {active === 'internals' && (
          <Placeholder title="Internals Manager" step="a later step (logic is done)" has={has}
            requires={[]} />
        )}

        {/* Shell smoke test: proves the whole chain — sysfs -> main ->
            preload -> renderer — is live. Replaced by the real gauges. */}
        <section className="panel shell-probe">
          <h2 className="panel-title">Live telemetry</h2>
          {telemetry ? (
            <div className="probe-grid">
              <Stat label="CPU" value={telemetry.cpu.usagePct} unit="%" />
              <Stat label="CPU temp" value={telemetry.cpu.tempC} unit="°C" />
              <Stat
                label="GPU"
                value={telemetry.gpu.idle ? null : telemetry.gpu.usagePct}
                unit="%"
                note={telemetry.gpu.idle ? 'Discrete GPU is idle' : undefined}
              />
              <Stat label="GPU clock" value={telemetry.gpu.idle ? null : telemetry.gpu.clockMhz} unit=" MHz" />
              <Stat label="System" value={telemetry.system.tempC} unit="°C" />
              <Stat label="RAM" value={telemetry.ram.usedPct} unit="%" />
              <Stat label="Fan CPU" value={telemetry.fans.cpuRpm} unit=" RPM" />
              <Stat label="Battery" value={telemetry.battery.percent} unit="%" />
            </div>
          ) : (
            <p className="dim">Waiting for the first sample…</p>
          )}
          <div className="hatch" style={{ marginTop: 16 }} />
          <p className="dim probe-foot">
            {settings
              ? `${settings.laptop_type ?? 'UNKNOWN'} · driver ${settings.driver_version || '—'} · ` +
                `parameter ${settings.modprobe_parameter || 'none'} · ` +
                `${settings.available_features?.length ?? 0} features`
              : 'Daemon settings unavailable — telemetry above is independent of the daemon.'}
          </p>
        </section>
      </main>
    </div>
  );
}

function Stat({ label, value, unit, note }: {
  label: string; value: number | null; unit: string; note?: string;
}): JSX.Element {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value mono-num">
        {value === null ? <span className="dim">--</span> : `${value}${unit}`}
      </span>
      {note && <span className="stat-note dim">{note}</span>}
    </div>
  );
}
