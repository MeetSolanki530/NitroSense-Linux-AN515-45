# app

The NitroSense desktop app. Electron main process plus a React renderer.

See the root `README.md` for install and usage. This file is about the code.

## Layout

```
electron/     main process. Owns all I/O and privilege.
  main.ts            window, splash, single-instance lock
  hardware-client.ts Unix socket transport to the service
  ipc.ts             the named-method IPC boundary
  telemetry.ts       sysfs and nvidia-smi polling
  cpupower.ts        CPU governor and EPP, the real power modes
  internals.ts       driver and service management
  nitro-key.ts       NitroSense key detection and binding
  validate.ts        argument validation, mirrors the service's ranges

src/          renderer. Pure presentation, no fs, no net, no child_process.
  state/hardware.ts  settings and telemetry hooks
  views/             one file per tab
  components/        shared widgets

scripts/      dev and install helpers
build/        icons and the deb packaging hooks
```

## Running it

```bash
./scripts/start-all.sh     # driver, service and app together
npm run dev                # app only, hot reload, no hardware
```

## Checks

```bash
npm run typecheck
npm test                   # 208 assertions, no hardware needed
npm run test:e2e           # drives real writes through the whole chain
```

## Design rules

**The renderer gets named methods, never a generic passthrough.** A
`send(command, params)` bridge would hand a sandboxed web context an arbitrary
write primitive backed by a root service. Every capability is a named method in
`ipc.ts`, validated in main before it reaches the socket.

**Writes are optimistic, then reconciled.** Apply locally so the UI feels
instant, then re-read and let the hardware's answer win, on success *and*
failure. The service silently clamps values the driver rejects, so what you
asked for and what happened are not the same thing.

**Unknown is not off.** A control that cannot read its state shows "unknown",
never a confident "off". Several settings on this hardware accept writes and
ignore them; the UI says so rather than pretending.

**One in-flight request.** The service does a bare `recv()` per request with no
message framing, so pipelining would desynchronise it.

## The socket

`/var/run/nitrosense.sock`, created by the service with mode 0666, so the app
runs unprivileged. Override with `NITROSENSE_SOCKET` for testing against a
mock.

Both sides must agree on the path. It is set in
`service/nitrosense-daemon.py`.
