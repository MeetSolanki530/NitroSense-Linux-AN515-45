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
npm test          # validation, telemetry, formatting  (149 assertions)
npm run test:e2e  # real writes through the full chain (36 assertions)
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

## Step 8 — keyboard RGB (done)

Per-zone colours and four-zone effects. The two are independent driver
features, so each is gated on its own entry in `available_features` rather
than a shared "has RGB" assumption — a machine may report one, both, or
neither.

Effect names come from the daemon's own table (`DAMX-Daemon.py:652`):
Static, Breathing, Neon, Wave, Shifting, Zoom, Meteor, Twinkling. Two details
are surfaced honestly rather than hidden:

- **Static** goes through a different daemon code path that ignores speed and
  direction, so both controls are disabled for it.
- **Wave and Shifting map to the same native effect** on this hardware
  (`0x07`), which the UI says rather than implying they differ.
- **Direction** only applies to Wave and Shifting.

Writes are explicit (Apply) rather than live-on-drag: each is a sysfs write to
the keyboard controller, and streaming them while a colour picker is dragged
would hammer the device through a single-in-flight transport. Edits in
progress are never overwritten by a background poll.

## Step 9 — packaging + Nitro key (done)

```bash
npm run package:dir              # build release/linux-unpacked
sudo ./scripts/install-frontend.sh
```

### Why the install path is load-bearing

`nitro-key-detection.service` guards every key press with

```bash
pgrep -f "/opt/damx/gui/DivAcerManagerMax" || <launch>
```

and `/usr/local/bin/DAMX` (a bash wrapper, no `exec`) invokes that absolute
path. Naming the Electron binary `DivAcerManagerMax` and installing it there
keeps the existing key handling working with **no change to the daemon, the
driver, the key script, or its service**.

Two rules follow, both verified in `scripts/test-nitro-guard.sh`:

- **The binary must be a real file at that path, never a symlink.** Electron
  re-execs itself via `/proc/self/exe`, so a symlinked install makes every
  process report the *resolved* path and the guard silently never matches —
  every key press would then spawn another instance. This was observed
  directly, not assumed.
- **Not AppImage.** An AppImage self-mounts under `/tmp/.mount_XXXXXX` and its
  processes report paths into that mount, which breaks the guard the same way.

Electron's `chrome-sandbox` is set `root:root` mode `4755` by the installer,
which it needs to start from `/opt`.

### Window behaviour

Closing the window quits the app — there is no tray. The key guard only
launches when no process matches, so a tray-resident app would make the Nitro
key appear broken.

### Rollback

The installer copies the existing GUI to `/opt/damx/gui.backup-<timestamp>`
before writing. Restore with:

```bash
sudo ./scripts/install-frontend.sh --uninstall
```

## Internals Manager and Monitoring views

The Internals screen binds to the same `electron/internals.ts` module the CLI
uses, so the two cannot drift. It shows driver status, the active modprobe
parameter and the live feature list, and separates the three command classes
(Force / Persist / Recovery) because they differ in persistence and risk.
Every operation is confirmed first, shows progress while the daemon restarts
itself, and then reports the **before/after feature diff** — the only reliable
signal that a `modprobe` reload succeeded, since a failed one returns no error
and simply drops features.

When features look incomplete and no parameter is set, it says so and points
at `nitro_v4`.

Monitoring charts everything the telemetry poller reads. Two rules in
`src/components/series.ts` keep the charts honest: nulls **break the line**
rather than plotting as zero (a suspended GPU has not cooled to 0 °C), and all
series are **anchored at the right edge** so readings from different moments
never share a column — series start at different times, since the GPU line
only begins when the card wakes.

## Testing against a real daemon without installing anything

The upstream daemon is pure Python stdlib and runs straight from the source
tree. This installs nothing — no systemd unit, no files under /opt, no driver
change — and Ctrl-C removes the socket again.

```bash
sudo ./scripts/run-daemon-dev.sh   # terminal 1, leave running
npm start                          # terminal 2
```

Without the `linuwu_sense` kernel driver loaded the daemon starts but reports
few or no features, because it has nothing to control. That is itself a useful
test: the app should connect and show each control as unavailable with a
reason, rather than pretending it works.

## Trying the driver without changing anything

Preferred for a first test. Loads the driver into memory only — no persistent
system settings are modified.

```bash
sudo ./scripts/try-driver.sh                   # terminal 1
sudo ./scripts/run-daemon-dev.sh               # terminal 2
node scripts/probe.ts && npm start             # terminal 3
sudo ./scripts/try-driver.sh --undo            # when finished
```

It writes nothing under `/etc`, `/opt` or `/lib/modules`, installs no systemd
unit, runs no `depmod`, creates no group, and never touches Secure Boot. A
reboot clears it regardless. `acer_wmi` is unloaded while it runs, since
`linuwu_sense` replaces it; `--undo` restores it.

## Installing the backend permanently

Full hardware control needs the Linuwu-Sense kernel driver and the DAMX
daemon. Neither ships in this repository as a build.

Only once the temporary load above is confirmed working. This one does change
persistent settings — module in `/lib/modules`, `acer_wmi` blacklisted,
`nitro_v4` in `/etc/modprobe.d`, a systemd unit, and a group.

```bash
sudo ./scripts/setup-backend.sh          # driver + nitro_v4 + daemon service
sudo ./scripts/setup-backend.sh --uninstall
```

Neither script touches Secure Boot: they read its state and warn, and never
sign a module or enrol a key.

It uses **PXDiv/Div-Linuwu-Sense**, which the project README credits. The
original `0x7375646F/Linuwu-Sense` lacks the `enable_all` module parameter the
Internals Manager uses; the Div fork has `enable_all`, `nitro_v4` and
`predator_v4`. `scripts/remote-setup.sh` upstream clones the original, so it
would leave `enable_all` broken.

The script blacklists `acer_wmi` (the driver's own Makefile does this), sets
`nitro_v4` in `/etc/modprobe.d/linuwu-sense.conf` because AN515-series
hardware needs it, and installs the unmodified daemon source as
`damx-daemon.service`. It stops if kernel headers are missing and warns before
continuing when Secure Boot is enabled, since an unsigned module will be
refused.

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
