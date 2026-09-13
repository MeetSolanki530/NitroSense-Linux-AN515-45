#!/usr/bin/env bash
#
# Tests the facer driver's RGB path on this laptop, TEMPORARILY.
#
# WHY THIS EXISTS
#   Linuwu-Sense's keyboard RGB writes report success on AN515-45 but never
#   light the keyboard. facer (JafarAkhondali/acer-predator-turbo-...) lists
#   AN515-45 as "RGB implemented: yes, tested: yes", and drives the SAME WMI
#   method 6 with a DIFFERENT payload:
#
#     facer  per-zone colour:  4 bytes  {zone, r, g, b}
#     Linuwu per-zone colour:  8 bytes  (u64)            <- suspected bug
#
#     facer  mode select:  16 bytes, byte[8]=0, byte[9]=1
#     Linuwu mode select:  16 bytes, byte[8]=3, byte[9]=1
#
#   If facer lights the keyboard, the payload shape is the fix and it can be
#   ported into the Linuwu-Sense copy. If facer also does nothing, the
#   hardware genuinely has no reachable backlight.
#
# WHAT THIS DOES NOT DO
#   - writes nothing under /etc  (no modules-load.d, no modprobe.d, no dkms)
#   - installs no systemd unit, runs no depmod, copies nothing to /lib/modules
#   - a reboot clears everything it does, as does --undo
#
#   sudo ./scripts/try-facer.sh          build, load, and light the keyboard red
#   sudo ./scripts/try-facer.sh --undo   unload facer, restore acer_wmi
#
set -euo pipefail

export PATH="/usr/sbin:/sbin:/usr/bin:/bin:$PATH"

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FACER_DIR="$PROJECT_ROOT/acer-turbo"
FACER_URL="https://github.com/JafarAkhondali/acer-predator-turbo-and-rgb-keyboard-linux-module"
KO="$FACER_DIR/src/facer.ko"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { red "Run as root:  sudo $0 $*"; exit 1; }

module_loaded() { [ -d "/sys/module/$1" ]; }

undo() {
  head_ "Unloading facer"
  if module_loaded facer; then
    rmmod facer 2>/dev/null && green "  facer unloaded." \
      || { red "  rmmod failed (in use?). Stop the hardware service and retry."; exit 1; }
  else
    dim "  facer was not loaded."
  fi
  modprobe acer_wmi 2>/dev/null && green "  acer_wmi restored." \
    || warn "  acer_wmi did not load; a reboot restores it."
  echo ""
  exit 0
}

[ "${1:-}" = "--undo" ] && undo

# Fetched on demand rather than kept as a checkout in the project. This is a
# comparison driver used to answer one question, not something the app needs,
# so a stale clone sitting in the tree is worth more confusion than the few
# seconds it takes to get it back.
if [ ! -f "$FACER_DIR/Makefile" ]; then
  command -v git >/dev/null 2>&1 || { red "git is needed to fetch facer"; exit 1; }
  dim "  Fetching facer into $FACER_DIR…"
  rm -rf "$FACER_DIR"
  git clone --depth 1 "$FACER_URL" "$FACER_DIR" >/dev/null 2>&1 || {
    red "  Could not clone facer from $FACER_URL"
    exit 1
  }
fi

head_ "Temporary facer load (nothing persistent is written)"

dim "  Building (writes only inside $FACER_DIR)…"
( cd "$FACER_DIR" && make ) >/dev/null 2>&1 || {
  red "  Build failed. Full output:"
  ( cd "$FACER_DIR" && make ) 2>&1 | tail -25
  exit 1
}
green "  Built: $KO"

# facer and linuwu_sense both replace acer_wmi; only one may be loaded.
for m in linuwu_sense acer_wmi facer; do
  if module_loaded "$m"; then
    dim "  Unloading $m (temporary)."
    rmmod "$m" 2>/dev/null || warn "  Could not unload $m; it may be in use (stop the daemon)."
    sleep 1
  fi
done

dim "  Inserting facer…"
if ! INS_ERR="$(insmod "$KO" 2>&1)"; then
  red "  insmod failed: $INS_ERR"
  modprobe acer_wmi 2>/dev/null || true
  exit 1
fi
green "  facer loaded."

sleep 2
head_ "What appeared"
FOUND_STATIC=""
for d in /dev/acer-gkbbl-static-0 /dev/acer-gkbbl-0; do
  if [ -e "$d" ]; then green "  $d"; [ "$d" = "/dev/acer-gkbbl-static-0" ] && FOUND_STATIC=1
  else warn "  $d  (missing)"; fi
done

if [ -z "$FOUND_STATIC" ]; then
  echo ""
  red "  The static RGB device did not appear, so facer sees no RGB capability"
  red "  on this machine either. That is the same answer Linuwu-Sense gave."
  echo ""
  dim "  Undo with:  sudo $0 --undo"
  exit 1
fi

head_ "Lighting all four zones green"
# Step 1: per-zone colour, 4 bytes {zone_bitmask, r, g, b}
for z in 1 2 3 4; do
  mask=$(( 1 << (z - 1) ))
  printf "$(printf '\\x%02x\\x00\\xff\\x00' "$mask")" > /dev/acer-gkbbl-static-0
  dim "  zone $z -> red"
done

# Step 2: tell the firmware to USE static mode. 16 bytes, byte[2]=brightness,
# byte[9]=1. Note byte[8] stays 0 here; Linuwu-Sense sets it to 3.
printf '\x00\x00\x64\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00' \
  > /dev/acer-gkbbl-0
dim "  static mode on, brightness 100"

echo ""
green "  Done. LOOK AT THE KEYBOARD NOW."
echo ""
dim "  If it is red, the 4-byte payload is the fix and it can be ported into"
dim "  the driver copy so the app can drive it."
dim "  If it is still dark, the backlight is genuinely unreachable."
echo ""
dim "  Undo everything:  sudo $0 --undo    (a reboot also clears it)"
echo ""
