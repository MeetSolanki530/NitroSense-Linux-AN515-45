/**
 * Battery & Power — the remaining daemon toggles.
 *
 * Battery calibration is treated differently from the others: it runs a full
 * discharge/recharge cycle that takes hours and cannot be usefully
 * interrupted, so it asks for confirmation rather than firing on a single
 * click like the cosmetic toggles.
 */
import { useState, type JSX } from 'react';
import { ControlBlock, connectionGate, gateFor } from '../components/Control';
import { Toggle } from '../components/Toggle';
import { useCommand } from '../state/useCommand';
import {
  USB_LEVELS, batterySummary, settingBool, settingUnsupported, usbLabel, usbLevel,
} from '../state/format';
import type { UsbLevel } from '../state/format';
import type { ConnectionState, Settings, Telemetry } from '../state/damx';
import './Battery.css';

type Props = {
  settings: Settings | null;
  telemetry: Telemetry | null;
  has: (feature: string) => boolean;
  connection: ConnectionState;
  refresh: () => Promise<void>;
};

export function Battery({ settings, telemetry, has, connection, refresh }: Props): JSX.Element {
  const connected = connection === 'connected';
  const { run, busy, error, clearError } = useCommand(refresh);
  const [confirmCalibration, setConfirmCalibration] = useState(false);

  const limiter = settingBool(settings, 'battery_limiter');
  const calibration = settingBool(settings, 'battery_calibration');
  const lcd = settingBool(settings, 'lcd_override');
  const boot = settingBool(settings, 'boot_animation_sound');
  const backlight = settingBool(settings, 'backlight_timeout');
  const usb = usbLevel(settings);

  // "-1" from the driver means it could not read the setting at all.
  //
  // These two are not the same case. backlight_timeout can read unknown while
  // its writes still land, so it stays usable and only gets an explanatory
  // hint. boot_animation_sound reads unknown because the firmware returns an
  // error status for the query, and returns the same error for writes, which
  // leave the stored value unchanged — so it is disabled outright rather than
  // inviting a click that errors.
  const bootUnreadable = settingUnsupported(settings, 'boot_animation_sound');
  const backlightUnreadable = settingUnsupported(settings, 'backlight_timeout');

  const pct = telemetry?.battery.percent ?? null;

  return (
    <div className="battery-view">
      {error && (
        <div className="write-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={clearError} aria-label="Dismiss">×</button>
        </div>
      )}

      <section className="panel battery-status">
        <h2 className="panel-title">Battery</h2>
        <div className="battery-meter">
          <div className="battery-bar">
            <div
              className="battery-fill"
              style={{ width: pct === null ? '0%' : `${pct}%` }}
            />
          </div>
          <span className="battery-pct mono-num">
            {pct === null ? <span className="dim">--</span> : `${pct}%`}
          </span>
        </div>
        <p className="battery-sub muted">
          {batterySummary(
            pct,
            telemetry?.battery.status ?? null,
            telemetry?.battery.acConnected ?? null,
          )}
        </p>
      </section>

      <ControlBlock
        title="Charging"
        gate={gateFor('battery_limiter', has, connected)}
        hint="The limiter caps charging around 80% to reduce long-term wear."
      >
        <Toggle
          label="Battery limiter"
          description="Stop charging near 80% instead of 100%."
          value={limiter}
          busy={busy}
          disabled={!connected || !has('battery_limiter')}
          onChange={(next) => void run(() => window.damx.setBatteryLimiter(next))}
        />
      </ControlBlock>

      <ControlBlock
        title="Battery Calibration"
        gate={gateFor('battery_calibration', has, connected)}
        hint="Recalibrates the charge gauge by fully discharging then recharging."
      >
        <Toggle
          label="Calibration"
          description={
            calibration === true
              ? 'Calibration is running. Leave the charger connected until it completes.'
              : 'Runs a full discharge and recharge cycle. This takes several hours.'
          }
          value={calibration}
          busy={busy}
          disabled={!connected || !has('battery_calibration') || (calibration !== true && !confirmCalibration)}
          onChange={(next) => {
            void run(() => window.damx.setBatteryCalibration(next));
            setConfirmCalibration(false);
          }}
        />
        {calibration !== true && (
          <div className="confirm-row">
            <label className="confirm-check">
              <input
                type="checkbox"
                checked={confirmCalibration}
                disabled={!connected || !has('battery_calibration')}
                onChange={(e) => setConfirmCalibration(e.target.checked)}
              />
              <span>
                I understand this runs for hours and cannot be usefully interrupted.
              </span>
            </label>
          </div>
        )}
      </ControlBlock>

      <ControlBlock
        title="USB Charging"
        gate={gateFor('usb_charging', has, connected)}
        hint="Keeps the USB ports powered while the laptop is off, down to the selected battery level."
      >
        <div className="usb-levels">
          {USB_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`usb-level${usb === level ? ' is-selected' : ''}`}
              disabled={!connected || !has('usb_charging') || busy}
              aria-pressed={usb === level}
              onClick={() => void run(() => window.damx.setUsbCharging(level as UsbLevel))}
            >
              {usbLabel(level)}
            </button>
          ))}
        </div>
        {usb === null && has('usb_charging') && (
          <p className="control-hint dim">
            Current level could not be read from the driver.
          </p>
        )}
      </ControlBlock>

      <ControlBlock title="Display & Boot" gate={connectionGate(connected)}>
        <Toggle
          label="LCD override"
          description="Allows the panel to run outside its default timing profile."
          value={lcd}
          busy={busy}
          disabled={!connected || !has('lcd_override')}
          broken={
            connected && has('lcd_override')
              ? 'Confirmed non-functional on this hardware: 5 direct writes each reported success, ' +
                'and the driver’s own readback never changed even once. Same class of firmware ' +
                'gap as thermal-mode switching.'
              : undefined
          }
          onChange={(next) => void run(() => window.damx.setLcdOverride(next))}
        />
        <Toggle
          label="Boot animation and sound"
          description="The Acer splash animation and chime at power-on."
          value={boot}
          busy={busy}
          disabled={!connected || !has('boot_animation_sound')}
          broken={
            bootUnreadable
              ? 'This firmware refuses the setting: both reading and writing it come ' +
                'back with an error status, and a write leaves the stored value ' +
                'unchanged. Nothing to apply on this machine.'
              : undefined
          }
          onChange={(next) => void run(() => window.damx.setBootAnimationSound(next))}
        />
        <Toggle
          label="Keyboard backlight timeout"
          description="Dim the keyboard backlight after 30 seconds idle."
          value={backlight}
          busy={busy}
          disabled={!connected || !has('backlight_timeout')}
          onChange={(next) => void run(() => window.damx.setBacklightTimeout(next))}
        />
        <MissingNote has={has} features={['lcd_override', 'boot_animation_sound', 'backlight_timeout']} />
        {backlightUnreadable && (
          <p className="control-hint dim">
            Controls marked “unknown” can&rsquo;t have their current state confirmed on
            this model, since the driver&rsquo;s decoder doesn&rsquo;t recognise the value it
            gets back. Setting them still works; the switch just can&rsquo;t show whether
            it&rsquo;s currently on or off.
          </p>
        )}
      </ControlBlock>
    </div>
  );
}

/** Names any feature in this group the driver is not reporting. */
function MissingNote({ has, features }: { has: (f: string) => boolean; features: string[] }): JSX.Element | null {
  const missing = features.filter((f) => !has(f));
  if (missing.length === 0) return null;
  return (
    <p className="control-hint dim">
      Not reported by the driver: {missing.join(', ')}.
    </p>
  );
}
