/**
 * Keyboard Lighting — per-zone colours and four-zone effects.
 *
 * The two modes are independent driver features. Either can be absent, so
 * each is gated on its own entry in available_features rather than on a
 * shared "has RGB" assumption.
 *
 * Writes are explicit (Apply) rather than live-on-drag: each one is a sysfs
 * write to the keyboard controller, and streaming them while a colour picker
 * is dragged would hammer the device through a single-in-flight transport.
 */
import { useEffect, useState, type JSX } from 'react';
import { ControlBlock, Slider, gateFor } from '../components/Control';
import { useCommand } from '../state/useCommand';
import {
  DEFAULT_FOUR_ZONE, DEFAULT_PER_ZONE, DIRECTIONS, EFFECTS,
  hexToRgb, parseFourZone, parsePerZone, rgbToHex, usesAnimation, usesDirection,
} from '../state/keyboard';
import type { FourZone, PerZone } from '../state/keyboard';
import type { ConnectionState, Settings } from '../state/damx';
import './Keyboard.css';

type Props = {
  settings: Settings | null;
  has: (feature: string) => boolean;
  connection: ConnectionState;
  refresh: () => Promise<void>;
};

const ZONE_NAMES = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4'];

export function Keyboard({ settings, has, connection, refresh }: Props): JSX.Element {
  const connected = connection === 'connected';
  const { run, busy, error, clearError } = useCommand(refresh);

  const perZoneGate = gateFor('per_zone_mode', has, connected);
  const fourZoneGate = gateFor('four_zone_mode', has, connected);

  const [perZone, setPerZone] = useState<PerZone>(DEFAULT_PER_ZONE);
  const [fourZone, setFourZone] = useState<FourZone>(DEFAULT_FOUR_ZONE);
  const [dirty, setDirty] = useState({ perZone: false, fourZone: false });

  // Adopt hardware state, but never overwrite edits in progress.
  useEffect(() => {
    if (dirty.perZone) return;
    const parsed = parsePerZone(settings?.per_zone_mode);
    if (parsed) setPerZone(parsed);
  }, [settings?.per_zone_mode, dirty.perZone]);

  useEffect(() => {
    if (dirty.fourZone) return;
    const parsed = parseFourZone(settings?.four_zone_mode);
    if (parsed) setFourZone(parsed);
  }, [settings?.four_zone_mode, dirty.fourZone]);

  const editZone = (index: number, hex: string): void => {
    setDirty((d) => ({ ...d, perZone: true }));
    setPerZone((p) => {
      const zones = [...p.zones] as PerZone['zones'];
      zones[index] = hex.replace(/^#/, '').toLowerCase();
      return { ...p, zones };
    });
  };

  const applyPerZone = (): void => {
    void run(() => window.damx.setPerZoneMode([...perZone.zones], perZone.brightness))
      .then((ok) => { if (ok) setDirty((d) => ({ ...d, perZone: false })); });
  };

  const applyFourZone = (): void => {
    void run(() => window.damx.setFourZoneMode({ ...fourZone }))
      .then((ok) => { if (ok) setDirty((d) => ({ ...d, fourZone: false })); });
  };

  const effect = EFFECTS.find((e) => e.mode === fourZone.mode) ?? EFFECTS[0];
  const fourZoneHex = rgbToHex(fourZone.red, fourZone.green, fourZone.blue);
  const animated = usesAnimation(fourZone.mode);
  const directional = usesDirection(fourZone.mode);

  return (
    <div className="keyboard-view">
      {error && (
        <div className="write-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={clearError} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Preview reflects whichever mode was applied most recently; the
          hardware has one lighting state, not two. */}
      <section className="panel kb-preview-panel">
        <h2 className="panel-title">Preview</h2>
        <div className="kb-preview" aria-hidden="true">
          {perZone.zones.map((hex, i) => (
            <div
              key={i}
              className="kb-zone"
              style={{
                background: `#${hex}`,
                opacity: Math.max(0.15, perZone.brightness / 100),
              }}
            >
              <span className="kb-zone-name">{ZONE_NAMES[i]}</span>
            </div>
          ))}
        </div>
        <p className="control-hint dim">
          Indicative only — it shows the per-zone colours, not a live capture of the keyboard.
        </p>
      </section>

      <ControlBlock
        title="Per-Zone Colour"
        gate={perZoneGate}
        hint="Sets a fixed colour for each of the four keyboard zones."
      >
        <div className="zone-grid">
          {perZone.zones.map((hex, i) => (
            <div className="zone-picker" key={i}>
              <span className="zone-label">{ZONE_NAMES[i]}</span>
              <input
                type="color"
                value={`#${hex}`}
                disabled={!perZoneGate.ok || busy}
                onChange={(e) => editZone(i, e.target.value)}
                aria-label={`${ZONE_NAMES[i]} colour`}
              />
              <code className="zone-hex">#{hex}</code>
            </div>
          ))}
        </div>

        <div className="kb-row">
          <Slider
            label="Brightness"
            value={perZone.brightness}
            disabled={!perZoneGate.ok}
            onChange={(v) => {
              setDirty((d) => ({ ...d, perZone: true }));
              setPerZone((p) => ({ ...p, brightness: v }));
            }}
          />
        </div>

        <div className="kb-actions">
          <button
            type="button"
            className="apply"
            disabled={!perZoneGate.ok || busy}
            onClick={applyPerZone}
          >
            {busy ? 'Applying…' : 'Apply colours'}
          </button>
          {dirty.perZone && <span className="dirty-note dim">Unapplied changes</span>}
        </div>
      </ControlBlock>

      <ControlBlock
        title="Four-Zone Effect"
        gate={fourZoneGate}
        hint="Animated lighting effects driven by the keyboard controller."
      >
        <div className="effect-grid">
          {EFFECTS.map((e) => (
            <button
              key={e.mode}
              type="button"
              className={`effect-tile${fourZone.mode === e.mode ? ' is-selected' : ''}`}
              disabled={!fourZoneGate.ok || busy}
              aria-pressed={fourZone.mode === e.mode}
              onClick={() => {
                setDirty((d) => ({ ...d, fourZone: true }));
                setFourZone((f) => ({ ...f, mode: e.mode }));
              }}
            >
              {e.name}
            </button>
          ))}
        </div>

        {effect?.note && <p className="effect-note dim">{effect.note}</p>}

        <div className="kb-row kb-row-split">
          <div className="zone-picker">
            <span className="zone-label">Colour</span>
            <input
              type="color"
              value={`#${fourZoneHex}`}
              disabled={!fourZoneGate.ok || busy}
              onChange={(e) => {
                const rgb = hexToRgb(e.target.value);
                if (!rgb) return;
                setDirty((d) => ({ ...d, fourZone: true }));
                setFourZone((f) => ({ ...f, ...rgb }));
              }}
              aria-label="Effect colour"
            />
            <code className="zone-hex">#{fourZoneHex}</code>
          </div>

          <Slider
            label="Brightness"
            value={fourZone.brightness}
            disabled={!fourZoneGate.ok}
            onChange={(v) => {
              setDirty((d) => ({ ...d, fourZone: true }));
              setFourZone((f) => ({ ...f, brightness: v }));
            }}
          />

          <Slider
            label="Speed"
            value={fourZone.speed}
            min={0}
            max={9}
            unit=""
            disabled={!fourZoneGate.ok || !animated}
            onChange={(v) => {
              setDirty((d) => ({ ...d, fourZone: true }));
              setFourZone((f) => ({ ...f, speed: v }));
            }}
          />
        </div>

        <div className="kb-row">
          <span className="zone-label">Direction</span>
          <div className="direction-seg">
            {DIRECTIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                className={`seg${fourZone.direction === d.value ? ' seg-active' : ''}`}
                disabled={!fourZoneGate.ok || !directional || busy}
                onClick={() => {
                  setDirty((x) => ({ ...x, fourZone: true }));
                  setFourZone((f) => ({ ...f, direction: d.value }));
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
          {!directional && (
            <span className="dim direction-note">Direction applies to Wave and Shifting.</span>
          )}
        </div>

        <div className="kb-actions">
          <button
            type="button"
            className="apply"
            disabled={!fourZoneGate.ok || busy}
            onClick={applyFourZone}
          >
            {busy ? 'Applying…' : 'Apply effect'}
          </button>
          {dirty.fourZone && <span className="dirty-note dim">Unapplied changes</span>}
        </div>
      </ControlBlock>

      {!has('per_zone_mode') && !has('four_zone_mode') && connected && (
        <p className="control-hint dim">
          Neither keyboard lighting mode is reported by the driver. On AN515-series
          hardware this is often resolved by forcing <code>nitro_v4</code> from the
          Internals tab.
        </p>
      )}
    </div>
  );
}
