/**
 * Monitoring — history for everything the telemetry poller reads.
 *
 * Independent of the daemon: these come from sysfs and nvidia-smi, so the
 * charts keep working when the daemon is down. Fan RPM is the exception,
 * since its hwmon only appears once linuwu_sense is loaded.
 */
import type { JSX } from 'react';
import { TrendChart } from '../components/TrendChart';
import { useHistory } from '../state/history';
import type { Telemetry } from '../state/hardware';
import './Monitoring.css';

type Props = { telemetry: Telemetry | null };

export function Monitoring({ telemetry }: Props): JSX.Element {
  const gpuIdle = Boolean(telemetry?.gpu.idle);

  const cpuTemp = useHistory(telemetry?.cpu.tempC ?? null, 120);
  const gpuTemp = useHistory(gpuIdle ? null : (telemetry?.gpu.tempC ?? null), 120);
  const sysTemp = useHistory(telemetry?.system.tempC ?? null, 120);
  const igpuTemp = useHistory(telemetry?.igpu.tempC ?? null, 120);

  const cpuUse = useHistory(telemetry?.cpu.usagePct ?? null, 120);
  const gpuUse = useHistory(gpuIdle ? null : (telemetry?.gpu.usagePct ?? null), 120);
  const igpuUse = useHistory(telemetry?.igpu.usagePct ?? null, 120);
  const ramUse = useHistory(telemetry?.ram.usedPct ?? null, 120);

  const ram = telemetry?.ram;
  const gib = (kb: number | null): string =>
    kb === null ? '--' : `${(kb / 1024 / 1024).toFixed(1)} GiB`;

  return (
    <div className="monitoring">
      <section className="panel">
        <h2 className="panel-title">Temperature</h2>
        <TrendChart
          max={100}
          unit="°C"
          // Idle-machine temperatures cluster in a narrow band (e.g. 45-55°C)
          // near the top of a fixed 0-100 scale, making four lines nearly
          // indistinguishable. Utilisation stays fixed: 0-100% is itself the
          // meaningful range there.
          autoScale
          series={[
            // dGPU, not GPU: the integrated chip is on the next line down, and
            // two series called GPU and iGPU invites reading the first as the
            // pair of them.
            { label: 'CPU', colour: 'var(--red-bright)', points: cpuTemp },
            { label: 'dGPU', colour: 'var(--accent-bright)', points: gpuTemp },
            { label: 'iGPU', colour: '#f0a04b', points: igpuTemp },
            { label: 'System', colour: '#7aa2ff', points: sysTemp },
          ]}
        />
        {gpuIdle && (
          <p className="control-hint dim">
            The discrete GPU is suspended, so its line is paused rather than drawn at zero.
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Utilisation</h2>
        <TrendChart
          max={100}
          unit="%"
          series={[
            { label: 'CPU', colour: 'var(--red-bright)', points: cpuUse },
            { label: 'dGPU', colour: 'var(--accent-bright)', points: gpuUse },
            { label: 'iGPU', colour: '#f0a04b', points: igpuUse },
            { label: 'RAM', colour: '#7aa2ff', points: ramUse },
          ]}
        />
      </section>

      <section className="panel">
        <h2 className="panel-title">Sensors</h2>
        <div className="sensor-grid">
          <Sensor label="CPU temperature" value={telemetry?.cpu.tempC ?? null} unit="°C" />
          <Sensor label="CPU utilisation" value={telemetry?.cpu.usagePct ?? null} unit="%" />
          <Sensor
            label="dGPU temperature"
            value={gpuIdle ? null : (telemetry?.gpu.tempC ?? null)}
            unit="°C"
            note={gpuIdle ? 'suspended' : undefined}
          />
          <Sensor
            label="dGPU clock"
            value={gpuIdle ? null : (telemetry?.gpu.clockMhz ?? null)}
            unit=" MHz"
            note={gpuIdle ? 'suspended' : undefined}
          />
          <Sensor label="iGPU temperature" value={telemetry?.igpu.tempC ?? null} unit="°C" />
          <Sensor label="iGPU utilisation" value={telemetry?.igpu.usagePct ?? null} unit="%" />
          <Sensor label="System temperature" value={telemetry?.system.tempC ?? null} unit="°C" />
          <Sensor
            label="CPU fan"
            value={telemetry?.fans.cpuRpm ?? null}
            unit=" RPM"
            note={telemetry?.fans.cpuRpm === null ? 'needs linuwu_sense' : undefined}
          />
          <Sensor
            label="GPU fan"
            value={telemetry?.fans.gpuRpm ?? null}
            unit=" RPM"
            note={telemetry?.fans.gpuRpm === null ? 'needs linuwu_sense' : undefined}
          />
          <Sensor label="Memory used" value={telemetry?.ram.usedPct ?? null} unit="%" />
          <Sensor label="Battery" value={telemetry?.battery.percent ?? null} unit="%"
                  note={telemetry?.battery.status ?? undefined} />
        </div>
        {/* Facts about the machine rather than live readings, so they get their
            own strip below the sensor grid instead of being tiles in it. It
            was a plain sentence, which read as a caption that had wandered in
            from another document. */}
        <div className="sensor-facts">
          <div className="sensor-fact">
            <span className="sensor-fact-label">Memory installed</span>
            <span className="sensor-fact-value">{gib(ram?.totalKb ?? null)}</span>
          </div>
          <div className="sensor-fact">
            <span className="sensor-fact-label">Memory available</span>
            <span className="sensor-fact-value">{gib(ram?.availableKb ?? null)}</span>
          </div>
          {telemetry?.igpu.name && (
            <div className="sensor-fact sensor-fact-wide">
              <span className="sensor-fact-label">Integrated GPU</span>
              <span className="sensor-fact-value">{telemetry.igpu.name}</span>
            </div>
          )}
          {telemetry?.gpu.name && (
            <div className="sensor-fact sensor-fact-wide">
              <span className="sensor-fact-label">Discrete GPU</span>
              <span className="sensor-fact-value">{telemetry.gpu.name}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Sensor({ label, value, unit, note }: {
  label: string; value: number | null; unit: string; note?: string;
}): JSX.Element {
  return (
    <div className="sensor">
      <span className="sensor-label">{label}</span>
      <span className="sensor-value mono-num">
        {value === null ? <span className="dim">--</span> : `${Math.round(value)}${unit}`}
      </span>
      {note && <span className="sensor-note dim">{note}</span>}
    </div>
  );
}
