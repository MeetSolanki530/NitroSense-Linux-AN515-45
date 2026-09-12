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
node scripts/test-telemetry.ts                                  # 16 assertions
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

## Step 3 — telemetry (done)

- `electron/telemetry.ts` — sensor discovery and polling.
- `scripts/monitor.ts` — live readout of everything the Home screen binds to.

```bash
node scripts/monitor.ts     # no daemon or root needed
```

The daemon provides **no telemetry** — `get_all_settings` returns settings
only. Every number on the dashboard is gathered here. Three deliberate
differences from the Avalonia app:

1. **Sensors are found by name**, never by hwmon index. Indices are not stable
   across reboots.
2. **Discovery is re-runnable.** Loading `linuwu_sense` adds hwmon devices —
   that is where fan RPM comes from — so a cache built once at startup goes
   stale the moment the Internals Manager reloads the driver. Call
   `rediscover()` after any driver operation; the poller also re-scans
   periodically.
3. **`nvidia-smi` is gated on the dGPU's `power/runtime_status`.** Polling it
   unconditionally keeps the discrete GPU awake, costing battery and idle
   heat. When suspended, the poller reports `idle` and shows `--`, reproducing
   the "Discrete GPU is idle" state without resuming the card.

Missing readings are reported as `null` and render as `--`. Nothing fabricates
a zero.

On this machine: `k10temp` → CPU, `acpitz` → System, `amdgpu` → iGPU,
`nvidia-smi` → RTX 3050 Ti. Fan RPM is unavailable until `linuwu_sense` loads.

## Step 5 — Home view (done)

Reproduces the NitroSense composition: GPU frequency dial and usage
sparklines on the left, wordmark/mode/mark in the centre, three temperature
arc gauges on the right, and a system + monitoring aside.

All gauges are hand-authored SVG (`src/components/`) — arc paths, tick rings
and gradients — with no charting library. The accent is mode-reactive, so the
whole screen shifts red at Performance and amber at Balanced.

Deliberate deviations from the original, and why:

- The centre **"N"** is layered SVG with a shear and a bevel highlight, not
  the original's rendered 3D asset. It recolours with the mode for free.
- **No promo card** in the lower left; that slot advertises Windows-only
  software.

A `null` reading renders `--` everywhere — an unavailable sensor must never
look like a cold one, and a suspended dGPU must never look like 0 MHz.

```bash
./scripts/smoke.sh out.png   # render the UI headlessly and capture it
node scripts/test-home.ts    # gauge geometry + label formatting
```

## Step 6 — thermal + fan control (done)

The first view that writes to hardware.

Mode tiles are built from the kernel's `platform_profile_choices`, not a fixed
Quiet/Balanced/Performance/Turbo set — the daemon only accepts values the
kernel reports, so hardcoding four tiles would offer modes the machine cannot
take. On a host reporting three profiles, three tiles appear.

Every write is **optimistic with reconciliation**: apply locally at once, then
re-read `get_all_settings` and let the daemon's answer win — on failure too,
so a control snaps back rather than sitting on a value the hardware refused.
Sliders debounce 150ms, because the transport allows one in-flight request.

Controls whose feature the daemon does not report are **disabled with a
reason**, never hidden, so a driver problem stays distinguishable from a UI
bug. Fan `0/0` means automatic; switching to Manual does not write until a
slider actually moves.

```bash
npm test          # validation, telemetry, formatting  (94 assertions)
npm run test:e2e  # real writes through the full chain (19 assertions)
```

The e2e suite launches the actual Electron app against the mock daemon and
drives writes from the renderer, asserting against the daemon's state rather
than the UI's optimism. It also asserts the renderer has no `require`, no
`process`, and no generic `send()`.

## Step 7 — battery, USB charging, display & boot (done)

The remaining daemon toggles: battery limiter, battery calibration, USB
charging level, LCD override, boot animation/sound, keyboard backlight
timeout.

The governing rule is in `src/state/format.ts`: the daemon returns these as
sysfs strings, and a value that cannot be read renders **"unknown", never
"off"**. A toggle showing off for a feature it cannot read misrepresents the
hardware.

**Battery calibration is treated differently** from the cosmetic toggles. It
runs a full discharge/recharge cycle lasting hours that cannot usefully be
interrupted, so it requires an explicit acknowledgement before the switch
becomes operable — the others fire on a single click.

USB charging offers exactly the four levels the daemon accepts (Off/10/20/30);
an off-grid value read back from the driver shows as unreadable rather than
being silently rounded.

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
