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
  DEFAULT_FOUR_ZONE, DEFAULT_PER_ZONE, DIRECTIONS, EFFECTS, effectFor,
  hexToRgb, normaliseHex, parseFourZone, parsePerZone, rgbToHex,
  usesAnimation, usesColour, usesDirection,
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

const PRESETS: { name: string; hex: string }[] = [
  { name: 'Red', hex: 'ff0000' },
  { name: 'Orange', hex: 'ff6a00' },
  { name: 'Yellow', hex: 'ffd000' },
  { name: 'Green', hex: '00ff2f' },
  { name: 'Cyan', hex: '00e5ff' },
  { name: 'Blue', hex: '0033ff' },
  { name: 'Magenta', hex: 'ff00d0' },
  { name: 'White', hex: 'ffffff' },
];

/**
 * Colour swatch plus a typed hex value.
 *
 * The swatch alone was not enough: it opens the desktop's picker but shows no
 * readable value, so a colour that came back from the driver as 0,0,0 just
 * looked like an empty black box. The hex field makes the current value
 * visible and lets it be entered directly.
 */
function ColourField({
  label, hex, disabled, hint, onChange,
}: {
  label: string;
  hex: string;
  disabled?: boolean;
  hint?: string;
  onChange: (hex: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(hex);
  // Follow the hardware value unless the field is being typed into.
  const [typing, setTyping] = useState(false);
  useEffect(() => { if (!typing) setDraft(hex); }, [hex, typing]);

  const valid = normaliseHex(draft) !== null;

  return (
    <div className="colour-field">
      <span className="zone-label">{label}</span>
      <div className="colour-row">
        <input
          type="color"
          value={`#${hex}`}
          disabled={disabled}
          onChange={(e) => {
            const v = normaliseHex(e.target.value);
            if (v) onChange(v);
          }}
          aria-label={`${label} colour`}
        />
        <input
          type="text"
          className={`hex-input${valid ? '' : ' is-invalid'}`}
          value={draft}
          disabled={disabled}
          spellCheck={false}
          maxLength={7}
          inputMode="text"
          aria-label={`${label} hex value`}
          aria-invalid={!valid}
          onFocus={() => setTyping(true)}
          onChange={(e) => {
            setDraft(e.target.value);
            const v = normaliseHex(e.target.value);
            if (v) onChange(v);
          }}
          onBlur={() => { setTyping(false); setDraft(hex); }}
        />
      </div>
      {hint && <span className="colour-hint dim">{hint}</span>}
    </div>
  );
}

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

  // The firmware reports 0,0,0 for effects that generate their own colours,
  // and after any per-zone write. Adopting that verbatim blanks the picker to
  // black, which reads as "no colour set" when the keyboard is in fact lit.
  // Fall back to the colour actually on the keyboard: zone 1.
  const zone1 = perZone.zones[0];
  useEffect(() => {
    if (dirty.fourZone) return;
    const parsed = parseFourZone(settings?.four_zone_mode);
    if (!parsed) return;
    const blank = parsed.red === 0 && parsed.green === 0 && parsed.blue === 0;
    const fallback = blank ? hexToRgb(zone1) : null;
    setFourZone(fallback ? { ...parsed, ...fallback } : parsed);
  }, [settings?.four_zone_mode, dirty.fourZone, zone1]);

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

  const effect = effectFor(fourZone.mode);
  const fourZoneHex = rgbToHex(fourZone.red, fourZone.green, fourZone.blue);
  const animated = usesAnimation(fourZone.mode);
  const directional = usesDirection(fourZone.mode);
  const coloured = usesColour(fourZone.mode);

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
          Indicative only: it shows the per-zone colours, not a live capture of the keyboard.
        </p>
      </section>

      <ControlBlock
        title="Per-Zone Colour"
        gate={perZoneGate}
        hint="Sets a fixed colour for each of the four keyboard zones."
      >
        <div className="zone-grid">
          {perZone.zones.map((hex, i) => (
            <ColourField
              key={i}
              label={ZONE_NAMES[i] as string}
              hex={hex}
              disabled={!perZoneGate.ok || busy}
              onChange={(v) => editZone(i, v)}
            />
          ))}
        </div>

        <div className="kb-actions kb-swatches">
          <span className="zone-label">Quick set</span>
          {PRESETS.map((p) => (
            <button
              key={p.hex}
              type="button"
              className="swatch"
              style={{ background: `#${p.hex}` }}
              title={p.name}
              aria-label={`Set every zone to ${p.name}`}
              disabled={!perZoneGate.ok || busy}
              onClick={() => {
                setDirty((d) => ({ ...d, perZone: true }));
                setPerZone((z) => ({ ...z, zones: [p.hex, p.hex, p.hex, p.hex] }));
              }}
            />
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
          <ColourField
            label="Colour"
            hex={fourZoneHex}
            disabled={!fourZoneGate.ok || busy || !coloured}
            hint={coloured ? undefined : 'This effect picks its own colours.'}
            onChange={(v) => {
              const rgb = hexToRgb(v);
              if (!rgb) return;
              setDirty((d) => ({ ...d, fourZone: true }));
              setFourZone((f) => ({ ...f, ...rgb }));
            }}
          />

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
        <NoLightingNote
          hasFourZoneKb={Boolean(settings?.has_four_zone_kb)}
          parameter={String(settings?.modprobe_parameter ?? '')}
        />
      )}
    </div>
  );
}

/**
 * Why no lighting controls are available.
 *
 * The driver only creates its four_zoned_kb sysfs group when
 *     quirks->four_zone_kb || enable_all
 * (linuwu_sense.c:4535). This model's quirk entry sets four_zone_kb = 0, so
 * nitro_v4 never creates the node. enable_all forces it on and the node does
 * appear — but confirmed with two direct writes (a static colour, a breathing
 * effect), the ACPI calls report success and the keyboard never visibly
 * changes. Same signature as lcd_override: reports success, no hardware
 * effect. enable_all also stacks predator_v4 quirks on top of nitro_v4, which
 * changes how the RGB-brightness hotkeys (Fn+F9/F10) are decoded — not worth
 * that cost for a control that does nothing, so this is treated as confirmed
 * non-functional rather than "try enable_all".
 */
function NoLightingNote({
  hasFourZoneKb, parameter,
}: { hasFourZoneKb: boolean; parameter: string }): JSX.Element {
  const triedEnableAll = parameter === 'enable_all';

  return (
    <section className="panel no-lighting">
      <h2 className="panel-title">Keyboard lighting unavailable</h2>
      {triedEnableAll ? (
        <>
          <p>
            The driver is loaded with <code>enable_all</code>, which forces the
            zoned-keyboard node on regardless of the model quirk, and the node still
            did not appear. That points at the controller genuinely being absent on
            this machine.
          </p>
          <p className="dim">
            Backlight brightness, if the keyboard has it, stays on the Fn keys.
          </p>
        </>
      ) : (
        <>
          <p>
            Confirmed non-functional on this hardware, not just unreported. Loading the
            driver with <code>enable_all</code> does create the per-zone and four-zone
            controls, but two direct writes (a static colour, a breathing effect) both
            reported success while the keyboard never visibly changed. Same class of
            firmware gap as LCD override and thermal-mode switching.
          </p>
          <p className="dim">
            <code>enable_all</code> also changes how the RGB-brightness hotkeys
            (Fn+F9/F10) are decoded, so it is not worth loading just to re-confirm this.
            Stay on plain <code>nitro_v4</code> for the features that do work.
          </p>
        </>
      )}
    </section>
  );
}
