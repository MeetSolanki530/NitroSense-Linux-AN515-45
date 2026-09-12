# damx-electron

React/Electron frontend for the DAMX daemon. Replaces the Avalonia GUI only —
the Python daemon, its systemd unit, and the `linuwu_sense` driver are never
modified.

Requires Node 24+ (TypeScript runs natively via type stripping; step 1 has
**no dependencies** and needs no `npm install`).

## Step 1 — socket transport (done)

- `electron/damx-client.ts` — the daemon transport.
- `scripts/probe.ts` — reports what this machine actually supports.
- `scripts/mock-daemon.py` / `scripts/test-client.ts` — test rig.

### Probe the real daemon

Run from a **normal terminal**. A Flatpak/snap shell (including VS Code's
integrated terminal when VS Code is a Flatpak) cannot see the host's `/run`
and will always report the socket as missing.

```bash
node scripts/probe.ts
```

### Run the tests

```bash
python3 scripts/mock-daemon.py /tmp/damx-mock.sock &
DAMX_SOCKET=/tmp/damx-mock.sock node scripts/test-client.ts
```

## Protocol notes

The daemon has **no message framing**: a bare `recv(4096)` per request and a
single `sendall()` reply, with no delimiter or length prefix. The client
therefore accumulates bytes and retries `JSON.parse` until it succeeds, and
allows only one in-flight request at a time — the daemon's per-connection loop
is strictly request/response, so pipelining would desynchronise it. Requests
above 4096 bytes are rejected client-side.

`DISRUPTIVE_COMMANDS` (the nine `force_*` / `set_modprobe_parameter_*` /
`restart_*` commands) make the daemon `systemctl restart` itself while still
handling the request, so the reply usually never arrives. For these, a dropped
connection is treated as an expected success signal; callers then use
`waitUntilReady()` and re-read `get_all_settings` to confirm the real outcome.
