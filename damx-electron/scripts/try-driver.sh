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
#   sudo ./scripts/try-driver.sh               load with nitro_v4=1
#   sudo ./scripts/try-driver.sh --enable-all  load with enable_all=1
#   sudo ./scripts/try-driver.sh --undo        unload and restore acer_wmi
#
# WHY --enable-all EXISTS
#   The driver only creates the four_zoned_kb sysfs group when
#       quirks->four_zone_kb || enable_all
#   (linuwu_sense.c:4535). On models whose quirk entry has four_zone_kb = 0 —
#   AN515-45 among them — nitro_v4 leaves keyboard RGB completely unexposed
#   even where the hardware has it. enable_all forces the quirk on
#   (linuwu_sense.c:489 and :1000) and the node appears.
#
#   It also forces the predator_v4 and nitro_sense quirks, so it is a broader
#   change than nitro_v4; if something else misbehaves, go back to nitro_v4.
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

# Which parameter to insert with.
if [ "${1:-}" = "--enable-all" ]; then
  MOD_PARAM="enable_all=1"
  PARAM_NOTE="enable_all (exposes keyboard RGB where the model quirk does not)"
else
  MOD_PARAM="nitro_v4=1"
  PARAM_NOTE="nitro_v4 (AN515-series)"
fi

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
  CUR=""
  for prm in enable_all nitro_v4 predator_v4; do
    [ "$(cat "/sys/module/linuwu_sense/parameters/$prm" 2>/dev/null)" = "Y" ] && CUR="$CUR $prm"
  done
  dim "  linuwu_sense already loaded (${CUR:- no parameters}); reloading as $PARAM_NOTE."
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

dim "  Inserting with $PARAM_NOTE…"
if ! INS_ERR="$(insmod "$KO" $MOD_PARAM 2>&1)"; then
  if echo "$INS_ERR" | grep -qi "File exists"; then
    red "  The module is still loaded and could not be removed first."
    echo "      sudo rmmod linuwu_sense   # then re-run this script"
  else
    red "  insmod failed: $INS_ERR"
    echo "      dmesg | tail -30"
  fi
  modprobe acer_wmi 2>/dev/null || true
  exit 1
fi
green "  Driver loaded with $MOD_PARAM."

# Read the parameters back rather than trusting that insmod did what was asked.
# A previous version of this script set the parameter variable but still passed
# a hardcoded one to insmod, and then reported a conclusion based on the
# parameter it had NOT used.
PARAM_DIR="/sys/module/linuwu_sense/parameters"
if [ -d "$PARAM_DIR" ]; then
  ACTUAL=""
  for prm in enable_all nitro_v4 predator_v4; do
    val="$(cat "$PARAM_DIR/$prm" 2>/dev/null || echo N)"
    [ "$val" = "Y" ] && ACTUAL="$ACTUAL $prm"
  done
  dim "  active parameters:${ACTUAL:- none}"

  WANT="${MOD_PARAM%%=*}"
  if ! echo "$ACTUAL" | grep -qw "$WANT"; then
    red "  Requested $WANT but the module reports:${ACTUAL:- none}"
    red "  Not continuing, since any conclusion drawn now would be wrong."
    exit 1
  fi
fi


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
    green "  keyboard RGB: available"
    ls "$ATTR_DIR/four_zoned_kb" 2>/dev/null | sed 's/^/    /'
  else
    warn "  keyboard RGB: no four_zoned_kb node"
    if [ "$MOD_PARAM" != "enable_all=1" ]; then
      dim "    This model's quirk has four_zone_kb = 0, so nitro_v4 never creates it."
      dim "    Try:  sudo $0 --enable-all"
    else
      dim "    enable_all was used and the node still did not appear, so the"
      dim "    controller is genuinely absent on this machine."
    fi
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
