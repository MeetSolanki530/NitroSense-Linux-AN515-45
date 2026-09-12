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
DAMX_SOCKET=/tmp/damx-mock.sock node scripts/test-client.ts     # 11 assertions
DAMX_SOCKET=/tmp/damx-mock.sock node scripts/test-internals.ts  # 17 assertions
```

The mock is stateful: it starts in the unforced AN515-45-like state (thin
feature set, no parameter), so forcing `nitro_v4` visibly expands what is
available. `--break-on-restart` simulates a failed reload where the driver
returns with no features.

## Step 2 — Internals Manager (done)

- `electron/internals.ts` — driver/model domain logic.
- `scripts/internals-cli.ts` — apply a modprobe parameter before any UI exists.

AN515-45 is absent from `Compatibility.md`, and its siblings (AN515-44/47,
AN517-54) all require forcing `nitro_v4`. On this hardware the modprobe
parameter decides whether the rest of the app has anything to control, which
is why this lands before the UI.

```bash
node scripts/internals-cli.ts status            # read-only, safe
node scripts/internals-cli.ts persist-nitro --yes
```

Three command classes, kept visually distinct because they differ in
persistence and risk:

| Class | Commands | Effect |
|---|---|---|
| Force | `force-nitro`, `force-predator`, `force-enable-all` | applies now, **lost on reboot** |
| Persist | `persist-*`, `remove-param` | writes `/etc/modprobe.d/linuwu-sense.conf`, **survives reboot** |
| Recovery | `restart-daemon`, `restart-drivers` | `restart-drivers` rmmods first and can drop features |

Every operation snapshots features before and after and reports the diff. A
failed `modprobe` reload does not return an error from the daemon — it shows
up as features silently disappearing — so the diff is the only reliable
signal. Mutating actions require `--yes`.

If the daemon never returns, recover with:

```bash
sudo modprobe linuwu_sense && sudo systemctl restart damx-daemon.service
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
