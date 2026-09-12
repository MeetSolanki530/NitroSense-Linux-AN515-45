#!/usr/bin/env bash
#
# Loads the Linuwu-Sense driver TEMPORARILY, so the frontend can be tested
# against real hardware without changing any persistent system settings.
#
# WHAT THIS DOES NOT DO
#   - does not touch Secure Boot (no signing, no MOK enrolment)
#   - writes nothing under /etc  (no blacklist, no modprobe.d, no modules-load.d)
#   - installs no systemd unit and no file under /opt
#   - does not run depmod or copy anything into /lib/modules
#   - creates no group and changes no user
#
# Everything it does is undone by --undo, and by a reboot regardless.
#
#   sudo ./scripts/try-driver.sh          load temporarily
#   sudo ./scripts/try-driver.sh --undo   unload and restore acer_wmi
#
set -euo pipefail

# sudo's secure_path does not always include sbin, and a missing lsmod made
# module detection silently report "not loaded" while insmod failed with
# EEXIST. Everything below uses sysfs for detection, which needs no PATH.
export PATH="/usr/sbin:/sbin:/usr/bin:/bin:$PATH"

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DRIVER_DIR="$PROJECT_ROOT/Linuwu-Sense"
KO="$DRIVER_DIR/src/linuwu_sense.ko"
ATTR_DIR="/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { red "Run as root:  sudo $0 $*"; exit 1; }

# /sys/module/<name> is the authoritative test: no PATH, no parsing.
module_loaded() { [ -d "/sys/module/$1" ]; }

undo() {
  head_ "Unloading"
  if module_loaded linuwu_sense; then
    if rmmod linuwu_sense 2>/dev/null; then
      green "  linuwu_sense unloaded."
    else
      red "  rmmod failed (in use?). Check: lsmod | grep linuwu"
      exit 1
    fi
  else
    dim "  linuwu_sense was not loaded."
  fi

  if module_loaded acer_wmi; then
    dim "  acer_wmi already loaded."
  elif modprobe acer_wmi 2>/dev/null; then
    green "  acer_wmi restored."
  else
    dim "  acer_wmi not reloaded (it may be built into the kernel)."
  fi
  echo ""
  dim "  Nothing persistent was ever written, so there is nothing else to undo."
  echo ""
  exit 0
}

[ "${1:-}" = "--undo" ] && undo

head_ "Temporary driver load (nothing persistent is written)"

if [ ! -f "$DRIVER_DIR/Makefile" ]; then
  red "Driver source missing at $DRIVER_DIR"; exit 1
fi

# Build in place; this writes only inside the project directory.
if [ ! -f "$KO" ]; then
  dim "  Building the module (writes only inside the project)…"
  ( cd "$DRIVER_DIR" && make ) || { red "  Build failed."; exit 1; }
fi
green "  Module built: $KO"

if module_loaded linuwu_sense; then
  CUR="$(cat /sys/module/linuwu_sense/parameters/nitro_v4 2>/dev/null || echo '?')"
  dim "  linuwu_sense already loaded (nitro_v4=$CUR); reloading to be sure."
  if ! rmmod linuwu_sense 2>/dev/null; then
    red "  Could not unload the running module — it is in use."
    red "  Stop anything using it (the DAMX daemon) and try again:"
    echo "      sudo rmmod linuwu_sense"
    exit 1
  fi
  sleep 1
fi

# linuwu_sense replaces acer_wmi, so acer_wmi must be out of the way. This is
# an in-memory change only; a reboot (or --undo) brings acer_wmi back.
if module_loaded acer_wmi; then
  dim "  Unloading acer_wmi (temporary; --undo restores it)."
  rmmod acer_wmi 2>/dev/null || warn "  Could not unload acer_wmi; continuing."
  sleep 1
fi

dim "  Inserting with nitro_v4=1 (AN515-series)…"
if ! insmod "$KO" nitro_v4=1; then
  red "  insmod failed. Check: dmesg | tail -30"
  modprobe acer_wmi 2>/dev/null || true
  exit 1
fi
green "  Driver loaded."

sleep 2
head_ "What appeared"
if [ -d "$ATTR_DIR" ]; then
  MODEL="$(ls "$ATTR_DIR" 2>/dev/null | grep -E 'nitro_sense|predator_sense' || true)"
  dim "  model directory: ${MODEL:-none detected}"
  if [ -n "$MODEL" ]; then
    echo "  attributes:"
    ls "$ATTR_DIR/$MODEL" 2>/dev/null | sed 's/^/    /'
  fi
  if [ -d "$ATTR_DIR/four_zoned_kb" ]; then
    echo "  keyboard:"
    ls "$ATTR_DIR/four_zoned_kb" 2>/dev/null | sed 's/^/    /'
  fi
else
  warn "  acer-wmi attribute directory not found. Check: dmesg | tail -30"
fi

if [ -f /sys/firmware/acpi/platform_profile_choices ]; then
  dim "  thermal profiles: $(cat /sys/firmware/acpi/platform_profile_choices)"
else
  warn "  no platform_profile_choices — thermal profile control will be unavailable"
fi

head_ "Next"
echo "  In a second terminal, start the daemon from source (also installs nothing):"
echo "      sudo $PROJECT_ROOT/damx-electron/scripts/run-daemon-dev.sh"
echo ""
echo "  Then in a third:"
echo "      cd $PROJECT_ROOT/damx-electron && node scripts/probe.ts && npm start"
echo ""
dim "  Undo everything:  sudo $0 --undo    (a reboot also clears it)"
echo ""
