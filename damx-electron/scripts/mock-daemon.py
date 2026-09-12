#!/usr/bin/env python3
"""
Mock DAMX daemon. Mirrors the real daemon's socket behaviour exactly:
AF_UNIX/SOCK_STREAM, chmod 0666, bare recv(4096) per request, single
sendall() reply, NO framing.

Deliberately nastier than the real thing in two ways, to prove the client
copes:
  - replies are written in small chunks with a delay, so a reply is
    guaranteed to arrive split across multiple 'data' events
  - disruptive commands close the connection WITHOUT replying, the way the
    real daemon does when systemctl kills it mid-request
"""
import json, os, socket, sys, threading, time

SOCK = sys.argv[1] if len(sys.argv) > 1 else "/tmp/damx-mock.sock"

DISRUPTIVE = {
    "force_nitro_model", "force_predator_model", "force_enable_all",
    "set_modprobe_parameter_nitro", "set_modprobe_parameter_predator",
    "set_modprobe_parameter_enable_all", "remove_modprobe_parameter",
    "restart_daemon", "restart_drivers_and_daemon",
}

SETTINGS = {
    "laptop_type": "NITRO", "has_four_zone_kb": True,
    "available_features": [
        "thermal_profile", "backlight_timeout", "battery_calibration",
        "battery_limiter", "boot_animation_sound", "fan_speed",
        "lcd_override", "usb_charging", "four_zone_mode",
    ],
    "version": "1.0.0-mock", "driver_version": "0.0.9", "modprobe_parameter": "nitro_v4",
    "thermal_profile": {"current": "balanced",
                        "available": ["low-power", "balanced", "performance"]},
    "backlight_timeout": "0", "battery_calibration": "0", "battery_limiter": "1",
    "boot_animation_sound": "1", "fan_speed": {"cpu": "0", "gpu": "0"},
    "lcd_override": "0", "usb_charging": "10",
    "four_zone_mode": "0,0,100,1,255,80,0",
}

def handle(conn):
    try:
        while True:
            data = conn.recv(4096)
            if not data:
                break
            req = json.loads(data.decode())
            cmd, params = req.get("command", ""), req.get("params", {})

            if cmd in DISRUPTIVE:
                # Real daemon: systemctl restart kills it mid-request. No reply.
                time.sleep(0.2)
                conn.close()
                return

            if cmd == "get_all_settings":
                resp = {"success": True, "data": SETTINGS}
            elif cmd == "get_version":
                resp = {"success": True, "data": {"version": "1.0.0-mock"}}
            elif cmd == "set_usb_charging":
                lvl = params.get("level", 0)
                ok = lvl in (0, 10, 20, 30)
                resp = {"success": ok, "data": {"level": lvl} if ok else None,
                        "error": None if ok else "Failed to set USB charging"}
            else:
                resp = {"success": False, "error": f"Unknown command: {cmd}"}

            payload = json.dumps(resp).encode()
            # Force a split across multiple TCP reads.
            mid = max(1, len(payload) // 3)
            conn.sendall(payload[:mid]); time.sleep(0.05)
            conn.sendall(payload[mid:2*mid]); time.sleep(0.05)
            conn.sendall(payload[2*mid:])
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
    print(f"mock daemon listening on {SOCK}", flush=True)
    while True:
        conn, _ = s.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()

if __name__ == "__main__":
    main()
