/**
 * Renderer-side view of hardware state.
 *
 * Two independent cadences, per the plan: telemetry is pushed ~1s from main,
 * daemon settings are polled ~5s and re-read immediately after every write so
 * the UI reflects what the hardware ACCEPTED, not what we asked for.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reinitializing';

export type Telemetry = {
  timestamp: number;
  cpu: { usagePct: number | null; tempC: number | null; model: string | null };
  gpu: {
    present: boolean; idle: boolean; name: string | null;
    tempC: number | null; usagePct: number | null; clockMhz: number | null;
  };
  igpu: { tempC: number | null };
  system: { tempC: number | null };
  ram: { usedPct: number | null; totalKb: number | null; availableKb: number | null };
  fans: { cpuRpm: number | null; gpuRpm: number | null };
  battery: { percent: number | null; status: string | null; acConnected: boolean | null };
};

export type Settings = {
  laptop_type?: string;
  driver_version?: string;
  modprobe_parameter?: string;
  version?: string;
  has_four_zone_kb?: boolean;
  available_features?: string[];
  thermal_profile?: { current?: string; available?: string[] };
  fan_speed?: { cpu?: string; gpu?: string };
  [k: string]: unknown;
};

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
  daemonReturned: boolean;
  before: InternalsState;
  after: InternalsState | null;
  diff: FeatureDiff | null;
  warning?: string;
  error?: string;
};

/** Real thermal/performance mode — see electron/cpupower.ts. The daemon's
 *  own thermal_profile is confirmed non-functional on this hardware. */
export type PowerMode = 'quiet' | 'balanced' | 'performance';

export type PowerState = {
  available: boolean;
  backend: 'power-profiles-daemon' | 'sysfs-pkexec' | 'unavailable';
  driver: string | null;
  governor: string | null;
  epp: string | null;
  availableGovernors: string[];
  availableEpp: string[];
  currentMode: PowerMode | null;
};

export type PowerModeResult = {
  mode: PowerMode;
  cpu: { ok: boolean; backend: PowerState['backend']; error?: string };
  fan: { ok: boolean; error?: string };
};

/** Whether the NitroSense key has been set up, and whether it even can be. */
export type NitroKeyState = {
  decided: boolean;
  accelerator: string | null;
  /** False outside GNOME-family sessions, where there is no shortcut store. */
  available: boolean;
  candidates: string[];
  /** Offered when the key turns out to be invisible to the desktop. */
  fallback: string;
  fallbackLabel: string;
};

declare global {
  interface Window {
    nitrosense: {
      getSettings(): Promise<Settings>;
      getTelemetry(): Promise<Telemetry>;
      getConnectionState(): Promise<ConnectionState>;
      setThermalProfile(profile: string): Promise<unknown>;
      setFanSpeed(cpu: number, gpu: number): Promise<unknown>;
      getPowerState(): Promise<PowerState>;
      setPowerMode(mode: PowerMode): Promise<PowerModeResult>;
      setBacklightTimeout(enabled: boolean): Promise<unknown>;
      setBatteryLimiter(enabled: boolean): Promise<unknown>;
      setBatteryCalibration(enabled: boolean): Promise<unknown>;
      setBootAnimationSound(enabled: boolean): Promise<unknown>;
      setLcdOverride(enabled: boolean): Promise<unknown>;
      setUsbCharging(level: number): Promise<unknown>;
      setPerZoneMode(zones: string[], brightness: number): Promise<unknown>;
      setFourZoneMode(cfg: Record<string, number>): Promise<unknown>;
      internalsState(): Promise<InternalsState>;
      forceModel(parameter: string): Promise<OperationResult>;
      persistParameter(parameter: string): Promise<OperationResult>;
      removeParameter(): Promise<OperationResult>;
      restartDaemon(): Promise<OperationResult>;
      restartDriversAndDaemon(): Promise<OperationResult>;
      nitroKeyState(): Promise<NitroKeyState>;
      nitroKeyBegin(): Promise<{ ok: boolean }>;
      nitroKeyConfirm(accelerator: string): Promise<{ ok: boolean }>;
      nitroKeyDecline(): Promise<{ ok: boolean }>;
      nitroKeyCancel(): Promise<{ ok: boolean }>;
      onTelemetry(cb: (t: Telemetry) => void): () => void;
      onNitroKey(cb: (e: { accelerator: string }) => void): () => void;
      onConnection(cb: (s: ConnectionState) => void): () => void;
      window: { minimize(): void; maximize(): void; close(): void };
    };
  }
}

export function useTelemetry(): Telemetry | null {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  useEffect(() => {
    void window.nitrosense.getTelemetry().then(setTelemetry).catch(() => undefined);
    return window.nitrosense.onTelemetry(setTelemetry);
  }, []);
  return telemetry;
}

export function useConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');
  useEffect(() => {
    void window.nitrosense.getConnectionState().then(setState).catch(() => undefined);
    return window.nitrosense.onConnection(setState);
  }, []);
  return state;
}

export type PowerStateHook = { state: PowerState | null; refresh: () => Promise<void> };

/**
 * Real system mode (governor + EPP) — independent of the daemon entirely, so
 * it gets its own poll rather than riding the daemon's settings refresh; it
 * must keep working, and keep updating, even while the daemon is
 * disconnected. Shared between Home (mode summary) and Performance (mode
 * switching) so both stay consistent with each other.
 */
export function usePowerState(pollMs = 2_000): PowerStateHook {
  const [state, setState] = useState<PowerState | null>(null);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    // Governor/EPP are plain sysfs reads, but a pkexec prompt can hold one
    // open for as long as the password dialog is up. Skipping a tick while
    // that is pending is correct here: unlike settings, this hook is not the
    // reconciliation path for a write (Performance re-reads explicitly).
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setState(await window.nitrosense.getPowerState());
    } catch {
      // Leave the last-known state rather than blank it on a transient error.
    } finally {
      inFlight.current = false;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);
  return { state, refresh };
}

export type SettingsHook = {
  settings: Settings | null;
  error: string | null;
  /** Re-read after a write, so the UI shows what the hardware accepted. */
  refresh: () => Promise<void>;
  has: (feature: string) => boolean;
};

export function useSettings(pollMs = 2_000): SettingsHook {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Promise<void> | null>(null);
  const queued = useRef<Promise<void> | null>(null);

  const readOnce = useCallback(async () => {
    try {
      setSettings(await window.nitrosense.getSettings());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  /**
   * Coalescing read.
   *
   * This used to drop the request outright when one was already in flight,
   * which quietly broke the thing that makes writes feel immediate: run()
   * calls refresh() right after a write, and if a background poll happened to
   * be running at that moment the reconciliation never happened and the UI sat
   * on stale values until the next poll.
   *
   * Callers arriving during a read now share ONE follow-up read instead, so a
   * write is always reconciled while a burst still cannot queue a read each.
   */
  const refresh = useCallback((): Promise<void> => {
    if (!current.current) {
      const p = readOnce().finally(() => {
        if (current.current === p) current.current = null;
      });
      current.current = p;
      return p;
    }
    if (!queued.current) {
      const q = current.current
        .catch(() => undefined)
        .then(() => readOnce())
        .finally(() => {
          if (queued.current === q) queued.current = null;
        });
      queued.current = q;
    }
    return queued.current;
  }, [readOnce]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  const has = useCallback(
    (feature: string) => Boolean(settings?.available_features?.includes(feature)),
    [settings],
  );

  return { settings, error, refresh, has };
}
