#!/usr/bin/env python3
"""
Mock DAMX daemon. Mirrors the real daemon's socket behaviour exactly:
AF_UNIX/SOCK_STREAM, chmod 0666, bare recv(4096) per request, single
sendall() reply, NO framing.

Deliberately nastier than the real thing, to prove the client copes:
  - replies are written in three chunks with delays, so every reply is
    guaranteed to arrive split across multiple 'data' events
  - disruptive commands close the connection WITHOUT replying, the way the
    real daemon does when systemctl kills it mid-request

It is also STATEFUL, modelling the relationship this project actually cares
about: the modprobe parameter determines which features exist. It starts in
the unforced AN515-45-like state (thin feature set, no parameter), so
forcing/persisting nitro_v4 visibly expands what is available.

Usage:
    mock-daemon.py <socket> [--start-forced] [--break-on-restart]

    --break-on-restart   simulate a failed modprobe reload: the driver comes
                         back with NO features, to exercise the "features
                         vanish rather than erroring loudly" path.
"""
import json, os, socket, sys, threading, time

args = [a for a in sys.argv[1:] if not a.startswith("--")]
flags = {a for a in sys.argv[1:] if a.startswith("--")}
SOCK = args[0] if args else "/tmp/damx-mock.sock"

NO_RGB = "--no-rgb" in flags   # this AN515-45: nitro_v4 set, no RGB controller

BASE_FEATURES = ["thermal_profile"]
FORCED_FEATURES = [
    "thermal_profile", "backlight_timeout", "battery_calibration",
    "battery_limiter", "boot_animation_sound", "fan_speed",
    "lcd_override", "usb_charging", "four_zone_mode", "per_zone_mode",
]
if NO_RGB:
    FORCED_FEATURES = [f for f in FORCED_FEATURES
                       if f not in ("four_zone_mode", "per_zone_mode")]

DISRUPTIVE = {
    "force_nitro_model", "force_predator_model", "force_enable_all",
    "set_modprobe_parameter_nitro", "set_modprobe_parameter_predator",
    "set_modprobe_parameter_enable_all", "remove_modprobe_parameter",
    "restart_daemon", "restart_drivers_and_daemon",
}

PARAM_FOR = {
    "force_nitro_model": "nitro_v4",
    "force_predator_model": "predator_v4",
    "force_enable_all": "enable_all",
    "set_modprobe_parameter_nitro": "nitro_v4",
    "set_modprobe_parameter_predator": "predator_v4",
    "set_modprobe_parameter_enable_all": "enable_all",
}
PERSISTENT = {
    "set_modprobe_parameter_nitro", "set_modprobe_parameter_predator",
    "set_modprobe_parameter_enable_all", "remove_modprobe_parameter",
}

state = {
    "param": "nitro_v4" if "--start-forced" in flags else "",
    "persistent": False,
    "broken": False,
    "profile": "" if "--eio-profile" in flags else "balanced",
    # --start-manual-fan seeds a non-zero duty cycle from the very first
    # get_all_settings, reproducing "manual mode was already active when the
    # app opened" — a case the UI's initial-render guess must sync to.
    "fan_cpu": 45 if "--start-manual-fan" in flags else 0,
    "fan_gpu": 50 if "--start-manual-fan" in flags else 0,
    "toggles": {
        "backlight_timeout": "-1" if "--eio-profile" in flags else "0", "battery_calibration": "0",
        "battery_limiter": "1",
        "boot_animation_sound": "-1" if "--eio-profile" in flags else "1",
        "lcd_override": "-1" if "--eio-profile" in flags else "0",
    },
    "usb_charging": "10",
    "per_zone": "ff0000,00ff00,0000ff,ffffff,100",
    "four_zone": "0,0,100,1,255,106,0",
}

PROFILES = ["low-power", "quiet", "balanced", "balanced-performance", "performance"]
lock = threading.Lock()


def features():
    if state["broken"]:
        return []
    return list(FORCED_FEATURES) if state["param"] else list(BASE_FEATURES)


def settings():
    f = features()
    s = {
        "laptop_type": "NITRO" if state["param"] else "UNKNOWN",
        "has_four_zone_kb": (not NO_RGB) and "four_zone_mode" in f,
        "available_features": f,
        "version": "1.0.0-mock",
        "driver_version": "0.0.9",
        "modprobe_parameter": state["param"] if (state["persistent"] or NO_RGB) else "",
        "thermal_profile": {"current": state["profile"], "available": PROFILES},
    }
    if "fan_speed" in f:
        s["fan_speed"] = {"cpu": str(state["fan_cpu"]), "gpu": str(state["fan_gpu"])}
    for k, v in state["toggles"].items():
        if k in f:
            s[k] = v
    if "usb_charging" in f:
        s["usb_charging"] = state["usb_charging"]
    if "four_zone_mode" in f:
        s["four_zone_mode"] = state["four_zone"]
    if "per_zone_mode" in f:
        s["per_zone_mode"] = state["per_zone"]
    return s


def apply_disruptive(cmd):
    with lock:
        if cmd == "remove_modprobe_parameter":
            state["param"] = ""
            state["persistent"] = False
        elif cmd in PARAM_FOR:
            state["param"] = PARAM_FOR[cmd]
            state["persistent"] = cmd in PERSISTENT
        elif cmd == "restart_drivers_and_daemon" and "--break-on-restart" in flags:
            state["broken"] = True
        # restart_daemon: service only, no state change


def handle(conn):
    try:
        while True:
            data = conn.recv(4096)
            if not data:
                break
            req = json.loads(data.decode())
            cmd, params = req.get("command", ""), req.get("params", {})

            if cmd in DISRUPTIVE:
                apply_disruptive(cmd)
                # Real daemon: systemctl restart kills it mid-request. No reply.
                time.sleep(0.2)
                conn.close()
                return

            if cmd == "get_all_settings":
                resp = {"success": True, "data": settings()}
            elif cmd == "get_version":
                resp = {"success": True, "data": {"version": "1.0.0-mock"}}
            elif cmd == "get_modprobe_parameter":
                resp = {"success": True,
                        "data": {"parameter": state["param"] if state["persistent"] else ""}}
            elif cmd == "set_thermal_profile":
                prof = params.get("profile", "")
                ok = prof in PROFILES and "thermal_profile" in features()
                if ok:
                    state["profile"] = prof
                resp = {"success": ok, "data": {"profile": prof} if ok else None,
                        "error": None if ok else "Failed to set thermal profile"}

            elif cmd == "set_fan_speed":
                cpu, gpu = params.get("cpu", 0), params.get("gpu", 0)
                ok = (isinstance(cpu, int) and isinstance(gpu, int)
                      and 0 <= cpu <= 100 and 0 <= gpu <= 100
                      and "fan_speed" in features())
                if ok:
                    state["fan_cpu"], state["fan_gpu"] = cpu, gpu
                resp = {"success": ok, "data": {"cpu": cpu, "gpu": gpu} if ok else None,
                        "error": None if ok else "Failed to set fan speed"}

            elif cmd in ("set_backlight_timeout", "set_battery_calibration",
                         "set_battery_limiter", "set_boot_animation_sound",
                         "set_lcd_override"):
                key = cmd[len("set_"):]
                enabled = params.get("enabled", False)
                ok = isinstance(enabled, bool) and key in features()
                if ok:
                    state["toggles"][key] = "1" if enabled else "0"
                resp = {"success": ok, "data": {"enabled": enabled} if ok else None,
                        "error": None if ok else f"Failed to set {key}"}

            elif cmd == "set_per_zone_mode":
                zones = [params.get(f"zone{i}", "") for i in range(1, 5)]
                bright = params.get("brightness", 100)
                ok = ("per_zone_mode" in features()
                      and all(isinstance(z, str) and len(z) == 6 for z in zones)
                      and isinstance(bright, int) and 0 <= bright <= 100)
                try:
                    for z in zones:
                        int(z, 16)
                except (ValueError, TypeError):
                    ok = False
                if ok:
                    state["per_zone"] = ",".join(zones) + f",{bright}"
                resp = {"success": ok, "data": {"brightness": bright} if ok else None,
                        "error": None if ok else "Failed to set per-zone mode"}

            elif cmd == "set_four_zone_mode":
                m = params.get("mode", 0); sp = params.get("speed", 0)
                br = params.get("brightness", 100); d = params.get("direction", 1)
                r = params.get("red", 0); g = params.get("green", 0); b = params.get("blue", 0)
                ok = ("four_zone_mode" in features()
                      and all(isinstance(v, int) for v in (m, sp, br, d, r, g, b))
                      and 0 <= m <= 7 and 0 <= sp <= 9 and 0 <= br <= 100
                      and d in (1, 2) and all(0 <= v <= 255 for v in (r, g, b)))
                if ok:
                    state["four_zone"] = f"{m},{sp},{br},{d},{r},{g},{b}"
                resp = {"success": ok, "data": {"mode": m} if ok else None,
                        "error": None if ok else "Failed to set four-zone mode"}

            elif cmd == "get_thermal_profile":
                resp = {"success": True,
                        "data": {"current": state["profile"], "available": PROFILES}}

            elif cmd == "set_usb_charging":
                lvl = params.get("level", 0)
                ok = lvl in (0, 10, 20, 30) and "usb_charging" in features()
                if ok:
                    state["usb_charging"] = str(lvl)
                resp = {"success": ok, "data": {"level": lvl} if ok else None,
                        "error": None if ok else "Failed to set USB charging"}
            else:
                resp = {"success": False, "error": f"Unknown command: {cmd}"}

            payload = json.dumps(resp).encode()
            mid = max(1, len(payload) // 3)
            conn.sendall(payload[:mid]); time.sleep(0.05)
            conn.sendall(payload[mid:2 * mid]); time.sleep(0.05)
            conn.sendall(payload[2 * mid:])
    except Exception:
        pass
    finally:
        try: conn.close()
        except Exception: pass


def main():
    if os.path.exists(SOCK):
        os.unlink(SOCK)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(SOCK)
    os.chmod(SOCK, 0o666)
    s.listen(5)
    print(f"mock daemon listening on {SOCK} (param={state['param'] or 'none'})", flush=True)
    while True:
        conn, _ = s.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
