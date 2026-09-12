/**
 * Internals Manager — driver/model management on top of DamxClient.
 *
 * Why this exists, and why it is built early: AN515-45 is absent from
 * Compatibility.md, and every nearby sibling (AN515-44, AN515-47, AN517-54)
 * is documented as "Need to force parameters using Internals Manager
 * (nitro_v4)". On this class of hardware the modprobe parameter is what
 * decides whether the rest of the app has anything to control.
 *
 * Three command classes, which the UI must keep visually distinct
 * (all verified against DAMM-Daemon/DAMX-Daemon.py):
 *
 *   FORCE     force_nitro_model / force_predator_model / force_enable_all
 *             rmmod -> sleep 2 -> modprobe <param> -> sleep 3 -> systemctl
 *             restart. Takes effect now, LOST ON REBOOT.
 *
 *   PERSIST   set_modprobe_parameter_{nitro,predator,enable_all},
 *             remove_modprobe_parameter
 *             Writes /etc/modprobe.d/linuwu-sense.conf, reads it back to
 *             verify, then runs the same driver+daemon restart. SURVIVES
 *             REBOOT, because that path is what the kernel's module loader
 *             reads on every boot.
 *
 *   RECOVERY  restart_daemon          service only, driver untouched
 *             restart_drivers_and_daemon  rmmod first — if the reload fails,
 *             features VANISH rather than erroring loudly, which is exactly
 *             why every operation here reports a before/after diff.
 *
 * All of them make the daemon restart itself mid-request, so each goes
 * through DamxClient's disruptive path: send, tolerate the dropped
 * connection, reconnect, then re-read state to find out what really happened.
 */

import { DamxClient, DISRUPTIVE_COMMANDS } from './damx-client.ts';

export type InternalsState = {
  laptopType: string;
  driverVersion: string;
  modprobeParameter: string;
  hasFourZoneKb: boolean;
  daemonVersion: string;
  features: string[];
};

export type FeatureDiff = {
  before: string[];
  after: string[];
  gained: string[];
  lost: string[];
};

export type OperationResult = {
  command: string;
  ok: boolean;
  /** Did the daemon come back at all? */
  daemonReturned: boolean;
  before: InternalsState;
  after: InternalsState | null;
  diff: FeatureDiff | null;
  /** Set when the outcome needs a human decision. */
  warning?: string;
  error?: string;
};

export type ModprobeParam = 'nitro_v4' | 'predator_v4' | 'enable_all';

const FORCE_COMMAND: Record<ModprobeParam, string> = {
  nitro_v4: 'force_nitro_model',
  predator_v4: 'force_predator_model',
  enable_all: 'force_enable_all',
};

const PERSIST_COMMAND: Record<ModprobeParam, string> = {
  nitro_v4: 'set_modprobe_parameter_nitro',
  predator_v4: 'set_modprobe_parameter_predator',
  enable_all: 'set_modprobe_parameter_enable_all',
};

const EMPTY_STATE: InternalsState = {
  laptopType: 'UNKNOWN',
  driverVersion: '',
  modprobeParameter: '',
  hasFourZoneKb: false,
  daemonVersion: '',
  features: [],
};

export class InternalsManager {
  #client: DamxClient;

  constructor(client: DamxClient) {
    this.#client = client;
  }

  /**
   * Read current driver/model state. laptop_type, driver_version and
   * modprobe_parameter are returned unconditionally at the top level of
   * get_all_settings, so this needs no extra round trip.
   */
  async readState(): Promise<InternalsState> {
    const res = await this.#client.send('get_all_settings');
    if (!res.success) {
      throw new Error(res.error ?? 'get_all_settings failed');
    }
    const d = res.data as Record<string, any>;
    return {
      laptopType: d.laptop_type ?? 'UNKNOWN',
      driverVersion: d.driver_version ?? '',
      modprobeParameter: d.modprobe_parameter ?? '',
      hasFourZoneKb: Boolean(d.has_four_zone_kb),
      daemonVersion: d.version ?? '',
      features: Array.isArray(d.available_features) ? [...d.available_features].sort() : [],
    };
  }

  /** Temporary: applies now, lost on reboot. */
  forceModel(param: ModprobeParam): Promise<OperationResult> {
    return this.#runDisruptive(FORCE_COMMAND[param]);
  }

  /** Persistent: writes /etc/modprobe.d/linuwu-sense.conf, survives reboot. */
  persistParameter(param: ModprobeParam): Promise<OperationResult> {
    return this.#runDisruptive(PERSIST_COMMAND[param]);
  }

  /** Remove the persistent parameter and fall back to autodetection. */
  removeParameter(): Promise<OperationResult> {
    return this.#runDisruptive('remove_modprobe_parameter');
  }

  /** Service only — the driver is left loaded. The safe recovery step. */
  restartDaemon(): Promise<OperationResult> {
    return this.#runDisruptive('restart_daemon');
  }

  /** rmmod + modprobe + service restart. Heavier, and can drop features. */
  restartDriversAndDaemon(): Promise<OperationResult> {
    return this.#runDisruptive('restart_drivers_and_daemon');
  }

  /**
   * Snapshot -> disruptive command -> reconnect -> snapshot -> diff.
   *
   * The diff is the point. A failed modprobe reload does not surface as an
   * error from the daemon; it surfaces as features silently disappearing.
   */
  async #runDisruptive(command: string): Promise<OperationResult> {
    if (!DISRUPTIVE_COMMANDS.has(command)) {
      throw new Error(`${command} is not a disruptive command; use client.send() directly`);
    }

    let before: InternalsState;
    try {
      before = await this.readState();
    } catch (e) {
      before = { ...EMPTY_STATE };
      // Daemon may already be unhealthy — that is itself worth acting on,
      // so continue rather than bailing out.
      void e;
    }

    let sendError: string | undefined;
    try {
      const res = await this.#client.send(command);
      if (!res.success && res.error) sendError = res.error;
    } catch (e) {
      // A dropped connection is the expected outcome here; DamxClient already
      // resolves those. Anything reaching this point is a real failure.
      sendError = (e as Error).message;
    }

    // force_* and restart_drivers_and_daemon sleep 2s + 3s before systemctl
    // even runs, so allow a generous window before declaring the daemon dead.
    const daemonReturned = await this.#client.waitUntilReady(60_000, 1_000);

    if (!daemonReturned) {
      return {
        command,
        ok: false,
        daemonReturned: false,
        before,
        after: null,
        diff: null,
        error:
          sendError ??
          'The daemon did not come back within 60s. The driver may have been ' +
            'unloaded without a successful reload.',
        warning:
          'Recover with:  sudo modprobe linuwu_sense  &&  ' +
          'sudo systemctl restart damx-daemon.service',
      };
    }

    const after = await this.readState();
    const diff = diffFeatures(before.features, after.features);

    let warning: string | undefined;
    if (diff.lost.length > 0) {
      warning =
        `Lost ${diff.lost.length} feature(s): ${diff.lost.join(', ')}. ` +
        'The driver reloaded with fewer capabilities than before.';
    } else if (diff.gained.length === 0 && before.features.length === after.features.length) {
      warning = 'No change in available features.';
    }

    return {
      command,
      ok: sendError === undefined && diff.lost.length === 0,
      daemonReturned: true,
      before,
      after,
      diff,
      warning,
      error: sendError,
    };
  }
}

export function diffFeatures(before: string[], after: string[]): FeatureDiff {
  const b = new Set(before);
  const a = new Set(after);
  return {
    before: [...before],
    after: [...after],
    gained: after.filter((f) => !b.has(f)).sort(),
    lost: before.filter((f) => !a.has(f)).sort(),
  };
}
