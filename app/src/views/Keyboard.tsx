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
  DEFAULT_FOUR_ZONE, DEFAULT_PER_ZONE, DIRECTIONS, EFFECTS, describeLighting,
  effectFor, hexToRgb, normaliseHex, parseFourZone, parsePerZone, rgbToHex,
  usesAnimation, usesColour, usesDirection, withUsableSpeed,
} from '../state/keyboard';
import type { FourZone, PerZone } from '../state/keyboard';
import type { ConnectionState, Settings } from '../state/hardware';
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

  const preview = describeLighting(perZone, fourZone);

  const editZone = (index: number, hex: string): void => {
    setDirty((d) => ({ ...d, perZone: true }));
    setPerZone((p) => {
      const zones = [...p.zones] as PerZone['zones'];
      zones[index] = hex.replace(/^#/, '').toLowerCase();
      return { ...p, zones };
    });
  };

  const applyPerZone = (): void => {
    void run(() => window.nitrosense.setPerZoneMode([...perZone.zones], perZone.brightness))
      .then((ok) => { if (ok) setDirty((d) => ({ ...d, perZone: false })); });
  };

  const applyFourZone = (): void => {
    // Guard the write as well as the tile click, so a speed 0 that arrived
    // from the hardware read cannot be applied to an animated effect.
    const payload = withUsableSpeed(fourZone);
    void run(() => window.nitrosense.setFourZoneMode({ ...payload }))
      .then((ok) => {
        if (!ok) return;
        setFourZone(payload);
        setDirty((d) => ({ ...d, fourZone: false }));
      });
  };

  const effect = effectFor(fourZone.mode);
  const fourZoneHex = rgbToHex(fourZone.red, fourZone.green, fourZone.blue);
  const animated = usesAnimation(fourZone.mode);
  const directional = usesDirection(fourZone.mode);
  const coloured = usesColour(fourZone.mode);

  /**
   * Whether Static is being driven through the per-zone write.
   *
   * Static is the one effect where four separate colours are meaningful, so
   * it gets the zone pickers and writes per_zone_mode. That is also what the
   * firmware does: a per-zone write leaves four_zone_mode reporting 0, which
   * is Static, so the two agree rather than being two names for one state.
   *
   * A machine that exposes effects but not per_zone_mode falls back to the
   * single colour picker, which still gives it a working Static.
   */
  const perZoneColours = fourZone.mode === 0 && perZoneGate.ok;

  // The effect tiles need four_zone_mode, so that is what gates the block.
  // Where only per-zone exists there are no effects to offer, but its colours
  // still work, so fall back to its gate rather than disabling everything.
  const blockGate = fourZoneGate.ok ? fourZoneGate : perZoneGate;

  return (
    <div className="keyboard-view">
      {error && (
        <div className="write-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={clearError} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* The hardware has one lighting state, not two, so the preview has to
          pick which of the two reads describes it. The firmware answers that
          itself: applying an effect leaves four_zone_mode reporting that
          mode, and applying per-zone colours leaves it reporting 0. Reading
          the mode is therefore enough, and it survives a restart, where a
          remembered "last thing clicked" would not.

          This used to draw perZone.zones unconditionally, which meant a
          keyboard breathing green was previewed as four white blocks, since
          per_zone_mode reports ffffff after any effect write. */}
      <section className="panel kb-preview-panel">
        <h2 className="panel-title">Preview</h2>
        <div className="kb-preview" aria-hidden="true">
          {preview.swatches.map((background, i) => (
            <div
              key={i}
              className="kb-zone"
              style={{
                background,
                // Brightness dims the whole zone, floored so a zone at 0 is
                // still visible as a colour rather than vanishing into the
                // panel, which would read as "nothing is set".
                opacity: Math.max(0.18, preview.brightness / 100),
                ['--zone-glow' as string]: preview.glows[i],
              }}
            >
              <span className="kb-zone-name">{ZONE_NAMES[i]}</span>
            </div>
          ))}
        </div>
        <p className="control-hint dim">{preview.caption}</p>
      </section>

      <ControlBlock
        title="Lighting"
        gate={blockGate}
        hint="Pick an effect, set it up below, then apply."
      >
        <div className="effect-grid">
          {EFFECTS.map((e) => (
            <button
              key={e.mode}
              type="button"
              className={`effect-tile${fourZone.mode === e.mode ? ' is-selected' : ''}`}
              disabled={!blockGate.ok || busy}
              aria-pressed={fourZone.mode === e.mode}
              onClick={() => {
                setDirty((d) => ({ ...d, fourZone: true }));
                // Switching off Static must not carry its speed 0 along:
                // an animated effect at speed 0 does not animate at all.
                setFourZone((f) => withUsableSpeed({ ...f, mode: e.mode }));
              }}
            >
              {e.name}
            </button>
          ))}
        </div>

        {effect?.note && <p className="effect-note dim">{effect.note}</p>}

        {/* Per-zone colours belong to Static and nowhere else. Every other
            effect drives all four zones from one colour, or generates its
            own, so four pickers there would offer a choice the firmware
            discards. */}
        <div className="kb-group">
          <span className="kb-group-label">Colour</span>
          {perZoneColours ? (
            <div className="kb-colour-zones">
              <div className="zone-grid">
                {perZone.zones.map((hex, i) => (
                  <ColourField
                    key={i}
                    label={ZONE_NAMES[i] as string}
                    hex={hex}
                    disabled={busy}
                    onChange={(v) => editZone(i, v)}
                  />
                ))}
              </div>

              <div className="kb-swatches">
                <span className="zone-label">Set all</span>
                {PRESETS.map((p) => (
                  <button
                    key={p.hex}
                    type="button"
                    className="swatch"
                    style={{ background: `#${p.hex}` }}
                    title={p.name}
                    aria-label={`Set every zone to ${p.name}`}
                    disabled={busy}
                    onClick={() => {
                      setDirty((d) => ({ ...d, perZone: true }));
                      setPerZone((z) => ({ ...z, zones: [p.hex, p.hex, p.hex, p.hex] }));
                    }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="kb-colour-single">
              <ColourField
                label={effect.name}
                hex={fourZoneHex}
                disabled={!blockGate.ok || busy || !coloured}
                onChange={(v) => {
                  const rgb = hexToRgb(v);
                  if (!rgb) return;
                  setDirty((d) => ({ ...d, fourZone: true }));
                  setFourZone((f) => ({ ...f, ...rgb }));
                }}
              />
              {coloured ? (
                <div className="kb-swatches">
                  <span className="zone-label">Presets</span>
                  {PRESETS.map((p) => (
                    <button
                      key={p.hex}
                      type="button"
                      className="swatch"
                      style={{ background: `#${p.hex}` }}
                      title={p.name}
                      aria-label={`Use ${p.name}`}
                      disabled={busy}
                      onClick={() => {
                        const rgb = hexToRgb(p.hex);
                        if (!rgb) return;
                        setDirty((d) => ({ ...d, fourZone: true }));
                        setFourZone((f) => ({ ...f, ...rgb }));
                      }}
                    />
                  ))}
                </div>
              ) : (
                <p className="kb-note dim">
                  {effect.name} generates its own colours, so there is nothing to pick here.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="kb-group">
          <span className="kb-group-label">Levels</span>
          <div className="kb-levels">
            <Slider
              label="Brightness"
              value={perZoneColours ? perZone.brightness : fourZone.brightness}
              disabled={!blockGate.ok}
              onChange={(v) => {
                if (perZoneColours) {
                  setDirty((d) => ({ ...d, perZone: true }));
                  setPerZone((p) => ({ ...p, brightness: v }));
                } else {
                  setDirty((d) => ({ ...d, fourZone: true }));
                  setFourZone((f) => ({ ...f, brightness: v }));
                }
              }}
            />

            <Slider
              label="Speed"
              value={fourZone.speed}
              min={0}
              max={9}
              unit=""
              disabled={!blockGate.ok || !animated}
              onChange={(v) => {
                setDirty((d) => ({ ...d, fourZone: true }));
                setFourZone((f) => ({ ...f, speed: v }));
              }}
            />
          </div>
          {!animated && (
            <p className="kb-note dim">Speed applies to every effect except Static.</p>
          )}
        </div>

        <div className="kb-group">
          <span className="kb-group-label">Direction</span>
          <div className="direction-seg">
            {DIRECTIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                className={`seg${fourZone.direction === d.value ? ' seg-active' : ''}`}
                disabled={!blockGate.ok || !directional || busy}
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
            <p className="kb-note dim">Direction applies to Wave and Shifting only.</p>
          )}
        </div>

        <div className="kb-actions">
          <button
            type="button"
            className="apply"
            disabled={!blockGate.ok || busy}
            onClick={perZoneColours ? applyPerZone : applyFourZone}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
          {(perZoneColours ? dirty.perZone : dirty.fourZone) && (
            <span className="dirty-note dim">Unapplied changes</span>
          )}
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
 * The driver creates its four_zoned_kb sysfs group only when
 *     quirks->four_zone_kb || enable_all
 * and find_quirks() returns early for a forced nitro_v4/predator_v4 BEFORE
 * DMI matching runs. So a forced module parameter is the usual reason the
 * node is missing on a machine that does have the hardware: it discards the
 * DMI entry that would have set four_zone_kb.
 *
 * An earlier version of this note claimed the backlight was confirmed dead on
 * AN515-45. That was wrong. The writes were being accepted and ignored
 * because the payload shape was wrong (see patches/), not because the
 * hardware was absent.
 */
function NoLightingNote({
  hasFourZoneKb, parameter,
}: { hasFourZoneKb: boolean; parameter: string }): JSX.Element {
  const forced = parameter === 'nitro_v4' || parameter === 'predator_v4';

  return (
    <section className="panel no-lighting">
      <h2 className="panel-title">Keyboard lighting unavailable</h2>
      {forced ? (
        <p>
          The driver was loaded with <code>{parameter}</code>, which makes it skip
          DMI matching entirely — and DMI matching is where this model&rsquo;s
          four-zone keyboard is declared. Reload without a module parameter:
          {' '}<code>sudo ./scripts/try-driver.sh</code>
        </p>
      ) : (
        <>
          <p>
            The driver did not report a four-zone keyboard for this machine
            {parameter !== '' && <> with <code>{parameter}</code> applied</>}.
          </p>
          <p className="dim">
            If this model does have one, it needs a DMI quirk entry declaring
            <code> four_zone_kb</code>. Check the name the driver matches on with
            {' '}<code>cat /sys/class/dmi/id/product_name</code>, and see
            {' '}<code>patches/</code> for the AN515-45 entry as a worked example.
          </p>
        </>
      )}
      {hasFourZoneKb && (
        <p className="dim">
          The daemon does report four-zone keyboard hardware, so the controls
          should appear once the driver exposes the node.
        </p>
      )}
    </section>
  );
}
