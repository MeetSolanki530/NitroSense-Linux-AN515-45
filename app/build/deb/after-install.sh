#!/bin/bash
#
# Runs as root after the package is unpacked.
#
# Brings up everything the app needs so that launching it just works:
#   1. the kernel driver, built against the running kernel and loaded at boot
#   2. the background service that talks to it
#   3. desktop and icon caches
#
# Deliberately never fails the install. A machine without kernel headers still
# gets a working app — it simply shows its hardware controls as unavailable
# until the driver can be built. Aborting the whole install over that would be
# worse than installing something partly useful.
#
set -u

RES="/opt/NitroSense/resources"
DRIVER_SRC="$RES/backend/driver"
DAEMON_SRC="$RES/backend/daemon"
DAEMON_DIR="/opt/NitroSense/backend"
SERVICE="/etc/systemd/system/nitrosense-daemon.service"
MODNAME="linuwu_sense"
KVER="$(uname -r)"
MDIR="/lib/modules/$KVER/kernel/drivers/platform/x86"

say()  { echo "  $*"; }
warn() { echo "  ! $*" >&2; }

echo "NitroSense: setting up hardware support"

# ------------------------------------------------------------------ driver
install_driver() {
  if [ ! -f "$DRIVER_SRC/Makefile" ]; then
    warn "driver source missing; hardware controls will be unavailable"
    return 1
  fi
  if [ ! -d "/lib/modules/$KVER/build" ]; then
    warn "kernel headers for $KVER not found"
    warn "install them, then run:  sudo dpkg-reconfigure nitrosense"
    warn "  Debian/Ubuntu:  sudo apt install linux-headers-$KVER"
    return 1
  fi
  command -v make >/dev/null 2>&1 || { warn "make not found"; return 1; }
  command -v gcc  >/dev/null 2>&1 || { warn "gcc not found";  return 1; }

  say "building the kernel driver for $KVER"
  if ! make -C "$DRIVER_SRC" >/tmp/nitrosense-driver-build.log 2>&1; then
    warn "driver build failed; see /tmp/nitrosense-driver-build.log"
    return 1
  fi

  # This driver replaces acer_wmi and cannot coexist with it.
  echo "blacklist acer_wmi" > /etc/modprobe.d/blacklist-acer_wmi.conf
  rmmod acer_wmi 2>/dev/null || true

  install -d "$MDIR"
  install -m 644 "$DRIVER_SRC/src/$MODNAME.ko" "$MDIR/"
  depmod -a "$KVER" || true

  # Load at every boot. No module parameter on purpose: find_quirks() returns
  # early for a forced one, before DMI matching runs, which would discard the
  # per-model quirk that declares the four-zone keyboard.
  echo "$MODNAME" > /etc/modules-load.d/$MODNAME.conf

  modprobe "$MODNAME" 2>/dev/null || true
  if [ -d "/sys/module/$MODNAME" ]; then
    say "driver loaded"
  else
    warn "driver installed but did not load; a reboot may be needed"
  fi
  return 0
}

install_driver || true

# ------------------------------------------------------------------ service
# The kernel driver ships a service of its own, and installing it by hand
# leaves that behind. Ours supersedes it, and two services touching the same
# hardware is worse than either alone, so stand it down first.
for legacy in linuwu_sense.service; do
  if [ -f "/etc/systemd/system/$legacy" ]; then
    say "standing down a leftover $legacy"
    systemctl stop "$legacy" 2>/dev/null || true
    systemctl disable "$legacy" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$legacy"
  fi
done

install -d "$DAEMON_DIR"
if [ -f "$DAEMON_SRC/nitrosense-daemon.py" ]; then
  install -m 755 "$DAEMON_SRC"/*.py "$DAEMON_DIR/"

  cat > "$SERVICE" <<'UNIT'
[Unit]
Description=NitroSense hardware service
Documentation=https://github.com/MeetSolanki530/NitroSense-Linux-AN515-45
# The driver must exist before this can read or write anything through it.
After=systemd-modules-load.service
Wants=systemd-modules-load.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/NitroSense/backend/nitrosense-daemon.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload 2>/dev/null || true
  systemctl enable nitrosense-daemon.service >/dev/null 2>&1 || true
  systemctl restart nitrosense-daemon.service 2>/dev/null || true

  # Give it a moment to bind, so the message below reflects reality.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -S /var/run/nitrosense.sock ] && break
    sleep 0.3
  done
  if [ -S /var/run/nitrosense.sock ]; then
    say "background service running"
  else
    warn "service did not start; check:  systemctl status nitrosense-daemon"
  fi
else
  warn "service files missing; hardware controls will be unavailable"
fi

# ------------------------------------------------------------------ desktop
command -v update-desktop-database >/dev/null 2>&1 \
  && update-desktop-database -q /usr/share/applications 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 \
  && gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true

# Electron's sandbox helper must be setuid root outside a user directory.
if [ -f /opt/NitroSense/chrome-sandbox ]; then
  chown root:root /opt/NitroSense/chrome-sandbox
  chmod 4755 /opt/NitroSense/chrome-sandbox
fi

echo "NitroSense: ready. Launch it from the app menu."
exit 0
