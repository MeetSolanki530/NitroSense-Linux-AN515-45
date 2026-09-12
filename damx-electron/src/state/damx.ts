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

declare global {
  interface Window {
    damx: {
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
      onTelemetry(cb: (t: Telemetry) => void): () => void;
      onConnection(cb: (s: ConnectionState) => void): () => void;
      window: { minimize(): void; maximize(): void; close(): void };
    };
  }
}

export function useTelemetry(): Telemetry | null {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  useEffect(() => {
    void window.damx.getTelemetry().then(setTelemetry).catch(() => undefined);
    return window.damx.onTelemetry(setTelemetry);
  }, []);
  return telemetry;
}

export function useConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');
  useEffect(() => {
    void window.damx.getConnectionState().then(setState).catch(() => undefined);
    return window.damx.onConnection(setState);
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
export function usePowerState(pollMs = 5_000): PowerStateHook {
  const [state, setState] = useState<PowerState | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await window.damx.getPowerState());
    } catch {
      // Leave the last-known state rather than blank it on a transient error.
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

export function useSettings(pollMs = 5_000): SettingsHook {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setSettings(await window.damx.getSettings());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
  }, []);

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
