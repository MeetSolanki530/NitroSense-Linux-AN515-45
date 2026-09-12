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

BASE_FEATURES = ["thermal_profile"]
FORCED_FEATURES = [
    "thermal_profile", "backlight_timeout", "battery_calibration",
    "battery_limiter", "boot_animation_sound", "fan_speed",
    "lcd_override", "usb_charging", "four_zone_mode",
]

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
}
lock = threading.Lock()


def features():
    if state["broken"]:
        return []
    return list(FORCED_FEATURES) if state["param"] else list(BASE_FEATURES)


def settings():
    f = features()
    s = {
        "laptop_type": "NITRO" if state["param"] else "UNKNOWN",
        "has_four_zone_kb": "four_zone_mode" in f,
        "available_features": f,
        "version": "1.0.0-mock",
        "driver_version": "0.0.9",
        "modprobe_parameter": state["param"] if state["persistent"] else "",
        "thermal_profile": {"current": "balanced",
                            "available": ["low-power", "balanced", "performance"]},
    }
    if "fan_speed" in f:
        s["fan_speed"] = {"cpu": "0", "gpu": "0"}
    for k, v in (("backlight_timeout", "0"), ("battery_calibration", "0"),
                 ("battery_limiter", "1"), ("boot_animation_sound", "1"),
                 ("lcd_override", "0"), ("usb_charging", "10")):
        if k in f:
            s[k] = v
    if "four_zone_mode" in f:
        s["four_zone_mode"] = "0,0,100,1,255,80,0"
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
            elif cmd == "set_usb_charging":
                lvl = params.get("level", 0)
                ok = lvl in (0, 10, 20, 30) and "usb_charging" in features()
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
