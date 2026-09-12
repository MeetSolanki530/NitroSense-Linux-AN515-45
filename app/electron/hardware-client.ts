/**
 * HardwareClient — transport for the hardware service's Unix domain socket.
 *
 * Protocol notes (derived from service/nitrosense-daemon.py):
 *
 *  - Socket is AF_UNIX / SOCK_STREAM at /var/run/nitrosense.sock, chmod 0o666
 *    by the service itself, so an unprivileged client connects fine. The
 *    service performs all privileged sysfs writes on our behalf. Both sides
 *    must agree on this path; it is set in service/nitrosense-daemon.py.
 *
 *  - There is NO message framing. The daemon does a bare recv(4096) per
 *    request and a single sendall() for the reply, with no delimiter and no
 *    length prefix. We therefore accumulate bytes and retry JSON.parse until
 *    it succeeds, and we allow only ONE in-flight request at a time — the
 *    daemon's per-connection loop is strictly request->response, so
 *    pipelining would desynchronise it.
 *
 *  - Requests must stay under 4096 bytes or the daemon will truncate them.
 *
 *  - The socket file is unlinked and recreated on every service restart
 *    (nitrosense-daemon.py:1031-1039), so reconnect must tolerate ENOENT.
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';

export const DEFAULT_SOCKET_PATH =
  process.env.NITROSENSE_SOCKET ?? '/var/run/nitrosense.sock';

/** The daemon's reply envelope. `data` is command-specific. */
export type HardwareResponse = {
  success: boolean;
  data?: unknown;
  error?: string | null;
  message?: string;
};

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reinitializing';

/**
 * Commands that make the daemon restart itself (and in most cases rmmod +
 * modprobe the driver first). The daemon calls
 * `systemctl restart nitrosense-daemon.service` while still handling our request,
 * so the reply usually never arrives and the socket dies mid-flight.
 *
 * For these we treat a dropped connection as an EXPECTED success signal
 * rather than an error, then reconnect and re-read state to find out what
 * actually happened.
 */
export const DISRUPTIVE_COMMANDS: ReadonlySet<string> = new Set([
  'force_nitro_model',
  'force_predator_model',
  'force_enable_all',
  'set_modprobe_parameter_nitro',
  'set_modprobe_parameter_predator',
  'set_modprobe_parameter_enable_all',
  'remove_modprobe_parameter',
  'restart_daemon',
  'restart_drivers_and_daemon',
]);

const MAX_REQUEST_BYTES = 4096;      // daemon's recv() ceiling
const MAX_RESPONSE_BYTES = 1 << 20;  // guard against unbounded buffer growth
const DEFAULT_TIMEOUT_MS = 5_000;
/** force_* and restart_drivers_and_daemon sleep 2s + 3s internally before systemctl runs. */
const DISRUPTIVE_TIMEOUT_MS = 20_000;

type Pending = {
  command: string;
  payload: Buffer;
  disruptive: boolean;
  timeoutMs: number;
  resolve: (r: HardwareResponse) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
};

export class HardwareError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'HardwareError';
    this.code = code;
  }
}

export class HardwareClient extends EventEmitter {
  #socketPath: string;
  #socket: net.Socket | null = null;
  #buffer: Buffer = Buffer.alloc(0);
  #queue: Pending[] = [];
  #current: Pending | null = null;
  #state: ConnectionState = 'disconnected';
  #connecting: Promise<void> | null = null;
  #closed = false;

  constructor(socketPath: string = DEFAULT_SOCKET_PATH) {
    super();
    this.#socketPath = socketPath;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  #setState(next: ConnectionState): void {
    if (this.#state === next) return;
    this.#state = next;
    this.emit('state', next);
  }

  /** Connect, or resolve immediately if already connected. Safe to call concurrently. */
  connect(): Promise<void> {
    if (this.#socket && !this.#socket.destroyed) return Promise.resolve();
    if (this.#connecting) return this.#connecting;

    this.#closed = false;
    if (this.#state !== 'reinitializing') this.#setState('connecting');

    this.#connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ path: this.#socketPath });

      const onConnect = (): void => {
        socket.removeListener('error', onError);
        this.#socket = socket;
        this.#buffer = Buffer.alloc(0);
        this.#setState('connected');

        socket.on('data', (chunk: Buffer) => this.#onData(chunk));
        socket.on('error', (err: NodeJS.ErrnoException) => this.#onDisconnect(err));
        socket.on('close', () => this.#onDisconnect(null));

        this.#connecting = null;
        resolve();
        this.#pump();
      };

      const onError = (err: NodeJS.ErrnoException): void => {
        socket.removeListener('connect', onConnect);
        socket.destroy();
        this.#connecting = null;
        if (this.#state !== 'reinitializing') this.#setState('disconnected');
        reject(this.#describeConnectError(err));
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
    });

    return this.#connecting;
  }

  /** Turn a raw errno into something a human can act on. */
  #describeConnectError(err: NodeJS.ErrnoException): HardwareError {
    const code = err.code ?? 'EUNKNOWN';
    if (code === 'ENOENT') {
      return new HardwareError(
        `No socket at ${this.#socketPath}. The hardware service is not running, ` +
          `or you are inside a sandbox (e.g. a Flatpak) that cannot see the host's /run.`,
        code,
      );
    }
    if (code === 'ECONNREFUSED') {
      return new HardwareError(
        `Socket at ${this.#socketPath} exists but refused the connection — ` +
          `likely a stale socket file from a daemon that exited uncleanly.`,
        code,
      );
    }
    if (code === 'EACCES') {
      return new HardwareError(
        `Permission denied on ${this.#socketPath}. The daemon normally chmods it 0666; ` +
          `check the socket's mode and any AppArmor/SELinux confinement.`,
        code,
      );
    }
    return new HardwareError(`Failed to connect to ${this.#socketPath}: ${err.message}`, code);
  }

  /** Accumulate bytes and settle the in-flight request once a whole JSON value has arrived. */
  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    if (this.#buffer.length > MAX_RESPONSE_BYTES) {
      const pending = this.#current;
      this.#buffer = Buffer.alloc(0);
      this.#current = null;
      pending?.timer && clearTimeout(pending.timer);
      pending?.reject(new HardwareError('Response exceeded maximum size', 'EOVERFLOW'));
      this.#pump();
      return;
    }

    // No framing in the protocol: the only reliable terminator is "it parses".
    let parsed: HardwareResponse;
    try {
      parsed = JSON.parse(this.#buffer.toString('utf8')) as HardwareResponse;
    } catch {
      return; // partial payload — wait for more bytes
    }

    this.#buffer = Buffer.alloc(0);
    const pending = this.#current;
    this.#current = null;
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(parsed);
    }
    this.#pump();
  }

  /**
   * Socket died. For a disruptive command this is the expected outcome, not a
   * failure — the daemon killed itself while servicing us.
   */
  #onDisconnect(err: NodeJS.ErrnoException | null): void {
    const socket = this.#socket;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    this.#socket = null;
    this.#buffer = Buffer.alloc(0);

    const pending = this.#current;
    this.#current = null;

    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.disruptive) {
        this.#setState('reinitializing');
        pending.resolve({
          success: true,
          message:
            'Daemon restarted before replying (expected for this command). ' +
            'Reconnect and re-read state to confirm the result.',
        });
      } else {
        pending.reject(
          new HardwareError(
            `Connection lost while awaiting "${pending.command}"` +
              (err ? `: ${err.message}` : ''),
            err?.code ?? 'ECONNCLOSED',
          ),
        );
      }
    }

    // Anything still queued cannot be trusted to have run.
    const queued = this.#queue.splice(0);
    for (const q of queued) {
      if (q.timer) clearTimeout(q.timer);
      q.reject(new HardwareError('Connection lost before request was sent', 'ECONNCLOSED'));
    }

    if (this.#state !== 'reinitializing' && !this.#closed) this.#setState('disconnected');
    this.emit('disconnect', err ?? undefined);
  }

  /** Send the next queued request, if the line is free. */
  #pump(): void {
    if (this.#current || this.#queue.length === 0) return;
    const socket = this.#socket;
    if (!socket || socket.destroyed) return;

    const next = this.#queue.shift();
    if (!next) return;
    this.#current = next;

    next.timer = setTimeout(() => {
      if (this.#current !== next) return;
      this.#current = null;
      next.reject(
        new HardwareError(`Timed out after ${next.timeoutMs}ms awaiting "${next.command}"`, 'ETIMEDOUT'),
      );
      // The stream is now of unknown alignment; drop it and start clean.
      this.#resetSocket();
    }, next.timeoutMs);

    socket.write(next.payload, (err) => {
      if (err && this.#current === next) {
        if (next.timer) clearTimeout(next.timer);
        this.#current = null;
        next.reject(new HardwareError(`Write failed: ${err.message}`, 'EWRITE'));
      }
    });
  }

  #resetSocket(): void {
    const socket = this.#socket;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
      this.#socket = null;
    }
    this.#buffer = Buffer.alloc(0);
    if (!this.#closed && this.#state !== 'reinitializing') this.#setState('disconnected');
  }

  /**
   * Send one command and await its reply.
   *
   * Disruptive commands resolve with a synthetic success when the daemon drops
   * the connection instead of replying; callers should follow with
   * waitUntilReady() and a fresh get_all_settings.
   */
  async send(
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<HardwareResponse> {
    if (this.#closed) throw new HardwareError('Client has been closed', 'ECLOSED');

    const disruptive = DISRUPTIVE_COMMANDS.has(command);
    const payload = Buffer.from(JSON.stringify({ command, params }), 'utf8');

    if (payload.length > MAX_REQUEST_BYTES) {
      throw new HardwareError(
        `Request for "${command}" is ${payload.length} bytes; the daemon reads at most ${MAX_REQUEST_BYTES}.`,
        'E2BIG',
      );
    }

    await this.connect();

    return new Promise<HardwareResponse>((resolve, reject) => {
      this.#queue.push({
        command,
        payload,
        disruptive,
        timeoutMs: disruptive ? DISRUPTIVE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
        resolve,
        reject,
      });
      this.#pump();
    });
  }

  /**
   * Poll until the daemon answers again after a restart.
   * Used after any DISRUPTIVE_COMMANDS call.
   */
  async waitUntilReady(timeoutMs = 45_000, probeIntervalMs = 1_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    this.#setState('reinitializing');

    while (Date.now() < deadline) {
      this.#resetSocket();
      try {
        await this.connect();
        const res = await this.send('get_version');
        if (res.success) {
          this.#setState('connected');
          this.emit('ready');
          return true;
        }
      } catch {
        // daemon still down — keep polling
      }
      await new Promise((r) => setTimeout(r, probeIntervalMs));
    }

    this.#setState('disconnected');
    return false;
  }

  close(): void {
    this.#closed = true;
    const queued = this.#queue.splice(0);
    for (const q of queued) {
      if (q.timer) clearTimeout(q.timer);
      q.reject(new HardwareError('Client closed', 'ECLOSED'));
    }
    if (this.#current?.timer) clearTimeout(this.#current.timer);
    this.#current = null;
    this.#resetSocket();
    this.#setState('disconnected');
  }
}
