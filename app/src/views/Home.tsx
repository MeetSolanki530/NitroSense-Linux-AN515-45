/**
 * Home — the composition from the NitroSense screenshots.
 *
 *   left    large GPU frequency dial + usage sparklines
 *   centre  wordmark, system mode, the N
 *   right   three temperature arc gauges
 *   aside   mode/fan summary + monitoring grid
 *
 * Everything here reads live state. Where a reading or a feature is missing
 * it shows "--" or an explicit unavailable note, never a placeholder number.
 */
import type { JSX } from 'react';
import { ArcGauge } from '../components/ArcGauge';
import { FrequencyDial } from '../components/FrequencyDial';
import { Sparkline } from '../components/Sparkline';
import { NitroMark } from '../components/NitroMark';
import { useHistory } from '../state/history';
import { usePowerState } from '../state/hardware';
import type { Settings, Telemetry } from '../state/hardware';
import { FanSpinner } from '../components/FanSpinner';
import { fanLabel } from './homeFormat';
import './Home.css';

type Props = {
  telemetry: Telemetry | null;
  settings: Settings | null;
  has: (feature: string) => boolean;
};

export function Home({ telemetry, settings, has }: Props): JSX.Element {
  const gpu = telemetry?.gpu;
  const gpuUsage = gpu && !gpu.idle ? gpu.usagePct : null;
  const cpuUsage = telemetry?.cpu.usagePct ?? null;

  const igpuUsage = telemetry?.igpu.usagePct ?? null;

  const gpuHistory = useHistory(gpuUsage);
  const igpuHistory = useHistory(igpuUsage);
  const cpuHistory = useHistory(cpuUsage);

  /**
   * Say which GPU this is.
   *
   * A bare "GPU Usage" sitting at 0% invites the conclusion that the reading
   * is broken. On a laptop with switchable graphics it is usually correct and
   * uninteresting: the desktop renders on the integrated chip and the discrete
   * card idles until something is explicitly placed on it. Naming the part
   * makes a zero read as "the discrete card is asleep" rather than "this
   * number is stuck".
   *
   * Usage only ever comes from nvidia-smi, so this figure is always the
   * discrete GPU when one is present.
   */
  const gpuUsageLabel = gpu?.present ? 'dGPU Usage' : 'GPU Usage';

  // The daemon's own thermal_profile is confirmed non-functional on this
  // hardware (see electron/cpupower.ts for the full trace); the real,
  // working mode comes from CPU governor+EPP instead, shared with
  // Performance so both stay consistent with each other.
  const { state: powerState } = usePowerState();
  const modeLabel: Record<string, string> = { quiet: 'Quiet', balanced: 'Balanced', performance: 'Performance' };
  const mode = powerState?.currentMode ? modeLabel[powerState.currentMode] : null;
  const modeUnavailable = powerState !== null && !powerState.available;

  return (
    <div className="home">
      <div className="home-main">
        {/* ---- left: frequency + usage ---- */}
        <section className="panel home-left">
          <FrequencyDial
            value={gpu && !gpu.idle ? gpu.clockMhz : null}
            idle={Boolean(gpu?.idle)}
          />
          <div className="home-sparks">
            {/* Both GPUs, because on a switchable-graphics laptop the one
                doing the work is usually the integrated chip. Showing only the
                discrete card leaves a permanent 0% that looks broken. */}
            <Sparkline history={gpuHistory} label={gpuUsageLabel} value={gpuUsage} />
            <Sparkline history={igpuHistory} label="iGPU Usage" value={igpuUsage} />
            <Sparkline history={cpuHistory} label="CPU Usage" value={cpuUsage} />
          </div>
          {/* Real telemetry already fetched for the aside/Monitoring views,
              surfaced here too rather than left blank — neither model name
              has anywhere else to live on this screen. */}
          <div className="home-left-foot">
            {telemetry?.cpu.model && (
              <span className="left-foot-item" title={telemetry.cpu.model}>
                {telemetry.cpu.model}
              </span>
            )}
            {gpu?.name && (
              <span className="left-foot-item" title={gpu.name}>{gpu.name}</span>
            )}
            <span className="left-foot-item mono-num left-foot-fan">
              <FanSpinner rpm={telemetry?.fans.cpuRpm} size={28} label="CPU fan" />
              Fan{' '}
              {telemetry?.fans.cpuRpm === null || telemetry === null ? (
                <span className="dim">--</span>
              ) : (
                `${telemetry.fans.cpuRpm} RPM`
              )}
            </span>
          </div>
        </section>

        {/* ---- centre: identity + mode ---- */}
        <section className="home-centre">
          <div className="wordmark">
            <span className="wordmark-nitro">NITRO</span>
            <span className="wordmark-sense">SENSE</span>
          </div>
          <div className="mode-block">
            <span className="mode-caption">System Mode</span>
            <span className="mode-name">{mode ?? (modeUnavailable ? 'Unavailable' : '—')}</span>
            <div className="mode-rule" />
          </div>
          <NitroMark />
        </section>

        {/* ---- right: temperatures ---- */}
        <section className="panel home-right">
          <span className="temp-rail">TEMPERATURE</span>
          <div className="temp-stack">
            <ArcGauge value={gpu?.idle ? null : (gpu?.tempC ?? null)} label="GPU" max={100} />
            <ArcGauge value={telemetry?.cpu.tempC ?? null} label="CPU" max={100} />
            <ArcGauge value={telemetry?.system.tempC ?? null} label="System" max={100} />
          </div>
        </section>
      </div>

      {/* ---- aside: widgets ---- */}
      <aside className="home-aside">
        <section className="panel widget">
          <h2 className="panel-title">System</h2>
          <dl className="widget-rows">
            <div className="widget-row">
              <dt>Mode</dt>
              <dd>
                {mode ?? <span className="dim">{modeUnavailable ? 'unavailable' : '—'}</span>}
              </dd>
            </div>
            <div className="widget-row">
              <dt>Fan</dt>
              <dd>{has('fan_speed') ? fanLabel(settings) : <span className="dim">unavailable</span>}</dd>
            </div>
            <div className="widget-row">
              <dt>Battery</dt>
              <dd>
                {telemetry?.battery.percent === null || telemetry === null ? (
                  <span className="dim">--</span>
                ) : (
                  `${telemetry.battery.percent}% · ${telemetry.battery.acConnected ? 'AC' : 'Battery'}`
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section className="panel widget">
          <h2 className="panel-title">Monitoring</h2>
          <div className="monitor-grid">
            {/* Both of these were labelled "GPU", which left two cells in the
                same grid claiming to be the same thing. They are the discrete
                card; the integrated one has its own temperature on the
                Monitoring tab. */}
            <Cell label={gpu?.present ? 'dGPU' : 'GPU'} value={gpuUsage} unit="%" />
            <Cell
              label={gpu?.present ? 'dGPU' : 'GPU'}
              value={gpu?.idle ? null : (gpu?.tempC ?? null)}
              unit="°C"
            />
            <Cell label="CPU" value={cpuUsage} unit="%" />
            <Cell label="CPU" value={telemetry?.cpu.tempC ?? null} unit="°C" />
            <Cell label="System" value={telemetry?.system.tempC ?? null} unit="°C" />
            <Cell label="RAM" value={telemetry?.ram.usedPct ?? null} unit="%" />
          </div>
          <div className="hatch" style={{ marginTop: 14 }} />
          <div className="fan-readout">
            <span className="fan-readout-label">
              <FanSpinner rpm={telemetry?.fans.cpuRpm} size={34} label="CPU fan" />
              Fan
            </span>
            <span className="mono-num">
              {telemetry?.fans.cpuRpm === null || !telemetry ? (
                <span className="dim">-- RPM</span>
              ) : (
                `${telemetry.fans.cpuRpm} RPM`
              )}
            </span>
          </div>
          {telemetry?.fans.cpuRpm === null && (
            <p className="fan-note dim">No fan sensor until linuwu_sense is loaded.</p>
          )}
        </section>
      </aside>
    </div>
  );
}

function Cell({ label, value, unit }: { label: string; value: number | null; unit: string }): JSX.Element {
  return (
    <div className="monitor-cell">
      <span className="monitor-label">{label}</span>
      <span className="monitor-value mono-num">
        {value === null ? <span className="dim">--</span> : Math.round(value)}
      </span>
      <span className="monitor-unit">{unit}</span>
    </div>
  );
}
