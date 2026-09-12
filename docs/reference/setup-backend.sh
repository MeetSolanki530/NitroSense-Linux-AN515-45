#!/usr/bin/env bash
#
# Installs the DAMX backend: the Linuwu-Sense kernel driver and the DAMX
# daemon. Run this once before testing the frontend against real hardware.
#
# WHY THIS EXISTS
#   This machine has no DAMX backend at all (no damx-daemon.service, no
#   /var/run/DAMX.sock, no linuwu_sense module), so the frontend has nothing
#   to talk to. The upstream repo ships only source, not a release bundle.
#
# WHICH DRIVER
#   PXDiv/Div-Linuwu-Sense, which the project README credits. The original
#   0x7375646F/Linuwu-Sense lacks the enable_all module parameter that the
#   Internals Manager uses; the Div fork has enable_all, nitro_v4 and
#   predator_v4.
#
# WHAT IT CHANGES
#   /lib/modules/<kernel>/kernel/drivers/platform/x86/linuwu_sense.ko
#   /etc/modprobe.d/blacklist-acer_wmi.conf   (driver's own Makefile)
#   /etc/modprobe.d/linuwu-sense.conf         (nitro_v4, for AN515 hardware)
#   /etc/modules-load.d/linuwu_sense.conf
#   /etc/systemd/system/linuwu_sense.service
#   /etc/systemd/system/damx-daemon.service
#   /opt/damx/daemon/                          (daemon source, unmodified)
#   group linuwu_sense, and your user added to it
#
# Undo with:  sudo ./scripts/setup-backend.sh --uninstall
#
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DRIVER_DIR="$PROJECT_ROOT/Linuwu-Sense"
DAEMON_SRC="$PROJECT_ROOT/DAMM-Daemon"
INSTALL_DIR="/opt/damx"
SERVICE="/etc/systemd/system/damx-daemon.service"
MODPROBE_CONF="/etc/modprobe.d/linuwu-sense.conf"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { red "Run as root:  sudo $0 $*"; exit 1; }

TARGET_USER="${SUDO_USER:-root}"

uninstall() {
  head_ "Removing the DAMX backend"
  systemctl stop damx-daemon.service 2>/dev/null || true
  systemctl disable damx-daemon.service 2>/dev/null || true
  rm -f "$SERVICE"
  systemctl daemon-reload 2>/dev/null || true
  rm -rf "$INSTALL_DIR/daemon"
  rm -f "$MODPROBE_CONF"
  if [ -d "$DRIVER_DIR" ]; then
    ( cd "$DRIVER_DIR" && make uninstall ) || warn "Driver uninstall reported errors."
  fi
  green "Backend removed. The frontend under $INSTALL_DIR/gui was left alone."
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall

# ---------------------------------------------------------------- preflight
head_ "Preflight"

KVER="$(uname -r)"
dim "  kernel: $KVER"

if [ ! -d "/lib/modules/$KVER/build" ]; then
  red "  Kernel headers missing for $KVER."
  echo "    Debian/Ubuntu: sudo apt install build-essential linux-headers-$KVER"
  echo "    Fedora:        sudo dnf install gcc make kernel-devel"
  echo "    Arch:          sudo pacman -S base-devel linux-headers"
  exit 1
fi
dim "  kernel headers: present"

command -v make >/dev/null || { red "  'make' not found. Install build tools (see above)."; exit 1; }
command -v gcc  >/dev/null || { red "  'gcc' not found. Install build tools (see above)."; exit 1; }
dim "  build tools: present"

SB="unknown"
if command -v mokutil >/dev/null 2>&1; then
  SB="$(mokutil --sb-state 2>/dev/null | head -1 || echo unknown)"
elif [ -d /sys/firmware/efi ]; then
  f="$(ls /sys/firmware/efi/efivars/SecureBoot-* 2>/dev/null | head -1 || true)"
  [ -n "$f" ] && SB="$(od -An -t u1 "$f" 2>/dev/null | awk '{print ($5==1)?"SecureBoot enabled":"SecureBoot disabled"}')"
fi
dim "  secure boot: $SB"

if echo "$SB" | grep -qi "enabled"; then
  echo ""
  warn "  Secure Boot is ENABLED. An unsigned module will be refused by the kernel."
  warn "  You will need to sign the module and enrol a MOK (reboot + blue"
  warn "  firmware screen), or disable Secure Boot in the BIOS."
  echo ""
  read -rp "  Continue anyway? [y/N] " ans
  [ "${ans,,}" = "y" ] || exit 1
fi

[ -f "$DRIVER_DIR/Makefile" ] || { red "  Driver source missing at $DRIVER_DIR"; exit 1; }
[ -f "$DAEMON_SRC/DAMX-Daemon.py" ] || { red "  Daemon source missing at $DAEMON_SRC"; exit 1; }
command -v python3 >/dev/null || { red "  python3 not found."; exit 1; }
dim "  sources: present"

# ------------------------------------------------------------------- driver
head_ "1/3  Building and installing the Linuwu-Sense driver"
dim "  This blacklists acer_wmi and loads linuwu_sense in its place."

( cd "$DRIVER_DIR" && make clean >/dev/null 2>&1 || true )
if ! ( cd "$DRIVER_DIR" && make ); then
  red "  Build failed. Check the compiler output above."
  exit 1
fi
if ! ( cd "$DRIVER_DIR" && make install ); then
  red "  Install failed."
  exit 1
fi

if [ ! -d /sys/module/linuwu_sense ]; then
  red "  linuwu_sense did not load. Check: dmesg | tail -30"
  exit 1
fi
green "  Driver loaded."

# --------------------------------------------------------- modprobe param
head_ "2/3  Setting the nitro_v4 module parameter"
dim "  AN515-series hardware needs this for the full feature set."
dim "  (Change or remove it later from the app's Internals tab.)"

echo "options linuwu_sense nitro_v4" > "$MODPROBE_CONF"
rmmod linuwu_sense 2>/dev/null || true
sleep 1
modprobe linuwu_sense
sleep 2

ATTR_DIR="/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi"
if [ -d "$ATTR_DIR" ]; then
  FOUND="$(ls "$ATTR_DIR" 2>/dev/null | grep -E 'nitro_sense|predator_sense' || true)"
  dim "  model directory: ${FOUND:-none detected}"
else
  warn "  acer-wmi attribute directory not found."
fi

# ------------------------------------------------------------------- daemon
head_ "3/3  Installing the DAMX daemon as a service"
dim "  Runs the upstream daemon source unmodified."

mkdir -p "$INSTALL_DIR/daemon"
cp -f "$DAEMON_SRC"/*.py "$INSTALL_DIR/daemon/"
chmod 755 "$INSTALL_DIR/daemon/DAMX-Daemon.py"

cat > "$SERVICE" <<UNIT
[Unit]
Description=DAMX Daemon for Acer laptops
After=multi-user.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 $INSTALL_DIR/daemon/DAMX-Daemon.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable damx-daemon.service >/dev/null 2>&1 || true
systemctl restart damx-daemon.service
sleep 3

if systemctl is-active --quiet damx-daemon.service; then
  green "  Daemon running."
else
  red "  Daemon failed to start. Check: systemctl status damx-daemon.service"
  exit 1
fi

if [ -S /var/run/DAMX.sock ]; then
  green "  Socket present at /var/run/DAMX.sock"
  ls -la /var/run/DAMX.sock | sed 's/^/    /'
else
  red "  Socket missing. Check: journalctl -u damx-daemon.service -n 40"
  exit 1
fi

head_ "Done"
echo "  Next:"
echo "    cd $PROJECT_ROOT/damx-electron"
echo "    node scripts/probe.ts     # confirm what the driver reports"
echo "    npm start"
echo ""
dim "  You were added to the linuwu_sense group; a re-login may be needed"
dim "  for that to take effect (the daemon runs as root, so the app works"
dim "  regardless)."
dim "  Undo everything with:  sudo $0 --uninstall"
echo ""
