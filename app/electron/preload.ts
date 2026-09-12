/**
 * Preload bridge.
 *
 * Exposes one named function per capability. There is no generic
 * send(command, params) — the renderer cannot name a daemon command, only
 * call a method that main validates and maps.
 *
 * Built to CommonJS (preload.cjs) because a sandboxed preload cannot be ESM.
 */

import { contextBridge, ipcRenderer } from 'electron';

const CH = {
  invoke: 'nitrosense:invoke',
  telemetry: 'nitrosense:telemetry',
  state: 'nitrosense:state',
  connection: 'nitrosense:connection',
  nitroKey: 'nitrosense:nitro-key',
};

type InvokeResult = { ok: boolean; data?: unknown; error?: string };

async function call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = (await ipcRenderer.invoke(CH.invoke, method, args)) as InvokeResult;
  if (!res.ok) throw new Error(res.error ?? `${method} failed`);
  return res.data as T;
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void =>
    cb(args[0] as T);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  // read
  getSettings: () => call<Record<string, unknown>>('getSettings'),
  getSupportedFeatures: () => call<Record<string, unknown>>('getSupportedFeatures'),
  getVersion: () => call<Record<string, unknown>>('getVersion'),
  getModprobeParameter: () => call<Record<string, unknown>>('getModprobeParameter'),
  getTelemetry: () => call<unknown>('getTelemetry'),
  getConnectionState: () => call<string>('getConnectionState'),

  // thermal / fan
  setThermalProfile: (profile: string) => call<unknown>('setThermalProfile', { profile }),
  setFanSpeed: (cpu: number, gpu: number) => call<unknown>('setFanSpeed', { cpu, gpu }),

  // real mode switching (governor + EPP + fan) — see electron/cpupower.ts
  getPowerState: () => call<unknown>('getPowerState'),
  setPowerMode: (mode: string) => call<unknown>('setPowerMode', { mode }),

  // toggles
  setBacklightTimeout: (enabled: boolean) => call<unknown>('setBacklightTimeout', { enabled }),
  setBatteryLimiter: (enabled: boolean) => call<unknown>('setBatteryLimiter', { enabled }),
  setBatteryCalibration: (enabled: boolean) => call<unknown>('setBatteryCalibration', { enabled }),
  setBootAnimationSound: (enabled: boolean) => call<unknown>('setBootAnimationSound', { enabled }),
  setLcdOverride: (enabled: boolean) => call<unknown>('setLcdOverride', { enabled }),

  // usb charging (0 / 10 / 20 / 30 only)
  setUsbCharging: (level: number) => call<unknown>('setUsbCharging', { level }),

  // keyboard rgb
  setPerZoneMode: (zones: string[], brightness: number) =>
    call<unknown>('setPerZoneMode', { zones, brightness }),
  setFourZoneMode: (cfg: Record<string, number>) => call<unknown>('setFourZoneMode', cfg),

  // internals (each restarts the daemon and returns a before/after diff)
  internalsState: () => call<unknown>('internalsState'),
  forceModel: (parameter: string) => call<unknown>('forceModel', { parameter }),
  persistParameter: (parameter: string) => call<unknown>('persistParameter', { parameter }),
  removeParameter: () => call<unknown>('removeParameter'),
  restartDaemon: () => call<unknown>('restartDaemon'),
  restartDriversAndDaemon: () => call<unknown>('restartDriversAndDaemon'),

  // nitrosense key setup
  nitroKeyState: () => call<unknown>('nitroKeyState'),
  nitroKeyBegin: () => call<unknown>('nitroKeyBegin'),
  nitroKeyConfirm: (accelerator: string) => call<unknown>('nitroKeyConfirm', { accelerator }),
  nitroKeyDecline: () => call<unknown>('nitroKeyDecline'),
  nitroKeyCancel: () => call<unknown>('nitroKeyCancel'),

  // push streams
  onTelemetry: (cb: (t: unknown) => void) => subscribe(CH.telemetry, cb),
  onNitroKey: (cb: (e: unknown) => void) => subscribe(CH.nitroKey, cb),
  onState: (cb: (s: unknown) => void) => subscribe(CH.state, cb),
  onConnection: (cb: (s: unknown) => void) => subscribe(CH.connection, cb),

  // window controls (frameless chrome is drawn by the renderer)
  window: {
    minimize: () => ipcRenderer.send('nitrosense:window', 'minimize'),
    maximize: () => ipcRenderer.send('nitrosense:window', 'maximize'),
    close: () => ipcRenderer.send('nitrosense:window', 'close'),
  },
};

contextBridge.exposeInMainWorld('nitrosense', api);

export type NitroSenseApi = typeof api;
