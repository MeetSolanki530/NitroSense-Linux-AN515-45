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
#   sudo ./scripts/try-driver.sh               load with no parameters (default)
#   sudo ./scripts/try-driver.sh --nitro-v4    force nitro_v4=1, skipping DMI
#   sudo ./scripts/try-driver.sh --enable-all  force every quirk on
#   sudo ./scripts/try-driver.sh --undo        unload and restore acer_wmi
#
# WHY THE DEFAULT PASSES NO PARAMETER
#   The driver only creates the four_zoned_kb sysfs group when
#       quirks->four_zone_kb || enable_all
#   and find_quirks() returns early for nitro_v4 BEFORE dmi_check_system runs.
#   So forcing nitro_v4=1 discards the AN515-45 DMI entry (which sets both
#   nitro_v4 and four_zone_kb) and loses keyboard RGB. Passing nothing lets
#   DMI matching pick the right quirk.
#
#   --enable-all also forces the predator_v4/nitro_sense/turbo quirks, which
#   changes how the Fn+F9/F10 backlight keys are decoded. Avoid it unless a
#   model genuinely has no DMI entry.
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

  # Force a full unload+reload of acer_wmi even if it is already loaded.
  # acer_wmi's WMI event-notify registration (what turns an Fn-key ACPI event
  # into an actual input event) is set up at module init. If it was left
  # loaded from an earlier `undo`, or auto-reloaded stale, that registration
  # can be incomplete even though the module and its sysfs nodes are present.
  # A full rmmod+modprobe cycle re-runs init from scratch.
  if module_loaded acer_wmi; then
    dim "  acer_wmi is loaded; reloading it fully to reset hotkey notify state."
    rmmod acer_wmi 2>/dev/null || warn "  Could not unload acer_wmi; it may be pinned by another driver."
    sleep 1
  fi

  if modprobe acer_wmi 2>/dev/null; then
    green "  acer_wmi (re)loaded."
    # Nudge the platform device to re-enumerate, in case the hotkey input
    # device was not recreated by modprobe alone.
    echo change > /sys/devices/platform/acer-wmi/uevent 2>/dev/null || true
  else
    red "  acer_wmi did not load. Check: dmesg | tail -30"
  fi

  echo ""
  if grep -qi "Acer WMI hotkeys" /proc/bus/input/devices 2>/dev/null; then
    green "  Hotkey input device present (Acer WMI hotkeys)."
  else
    warn "  No 'Acer WMI hotkeys' input device found."
  fi
  echo ""
  warn "  Test Fn keys now. If they still do not respond, the ACPI notify"
  warn "  handler is stuck in a state that only a reboot clears — this is a"
  warn "  known limitation of unloading/reloading vendor WMI drivers, not"
  warn "  something a further module reload can fix. Reboot restores it:"
  echo "      systemctl reboot"
  echo ""
  dim "  Nothing persistent was ever written, so a reboot returns you to the"
  dim "  exact state you had before any of this."
  echo ""
  exit 0
}

[ "${1:-}" = "--undo" ] && undo

# Which parameter to insert with.
#
# The default is NO parameter, so the driver's own DMI table picks the quirk.
# That matters here: passing nitro_v4=1 short-circuits find_quirks() before
# DMI matching runs (linuwu_sense.c find_quirks), which loses four_zone_kb and
# with it the keyboard RGB node. The AN515-45 DMI entry sets both.
if [ "${1:-}" = "--enable-all" ]; then
  MOD_PARAM="enable_all=1"
  PARAM_NOTE="enable_all (forces every quirk, including the predator ones)"
elif [ "${1:-}" = "--nitro-v4" ]; then
  MOD_PARAM="nitro_v4=1"
  PARAM_NOTE="nitro_v4 (forced; skips DMI matching)"
else
  MOD_PARAM=""
  PARAM_NOTE="no parameters (DMI quirk decides)"
fi

head_ "Temporary driver load (nothing persistent is written)"

if [ ! -f "$DRIVER_DIR/Makefile" ]; then
  red "Driver source missing at $DRIVER_DIR"; exit 1
fi

# Build in place; this writes only inside the project directory.
# Always rebuild rather than only-if-missing: kbuild only recompiles the
# object whose source actually changed, so a rebuild costs nothing when
# nothing changed, but skipping it silently reloads a stale .ko after any
# source edit — which is exactly what happened for three straight
# diagnostic patches to this file before this fix.
dim "  Building the module (writes only inside the project)…"
( cd "$DRIVER_DIR" && make ) || { red "  Build failed."; exit 1; }
green "  Module built: $KO"

if module_loaded linuwu_sense; then
  CUR=""
  for prm in enable_all nitro_v4 predator_v4; do
    [ "$(cat "/sys/module/linuwu_sense/parameters/$prm" 2>/dev/null)" = "Y" ] && CUR="$CUR $prm"
  done
  dim "  linuwu_sense already loaded (${CUR:- no parameters}); reloading as $PARAM_NOTE."
  if ! rmmod linuwu_sense 2>/dev/null; then
    red "  Could not unload the running module — it is in use."
    red "  Stop anything using it (the hardware service) and try again:"
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

  # Only verifiable when a parameter was actually requested; the default path
  # deliberately passes none and lets the DMI table decide.
  if [ -n "$MOD_PARAM" ]; then
    WANT="${MOD_PARAM%%=*}"
    if ! echo "$ACTUAL" | grep -qw "$WANT"; then
      red "  Requested $WANT but the module reports:${ACTUAL:- none}"
      red "  Not continuing, since any conclusion drawn now would be wrong."
      exit 1
    fi
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
    if [ -n "$MOD_PARAM" ]; then
      dim "    A forced parameter skips DMI matching, which is where this model's"
      dim "    four_zone_kb = 1 comes from. Re-run with no arguments."
    else
      dim "    DMI matching did not set four_zone_kb for this machine. Check that"
      dim "    the product name has a quirk entry in linuwu_sense.c:"
      dim "      cat /sys/class/dmi/id/product_name"
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
echo "      sudo $PROJECT_ROOT/app/scripts/run-daemon-dev.sh"
echo ""
echo "  Then in a third:"
echo "      cd $PROJECT_ROOT/app && node scripts/probe.ts && npm start"
echo ""
dim "  Undo everything:  sudo $0 --undo    (a reboot also clears it)"
echo ""
