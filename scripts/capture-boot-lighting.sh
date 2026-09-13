#!/usr/bin/env bash
#
# Capture the EC's lighting registers while the firmware's own static colour is
# still showing, before anything has written to the panel.
#
# After a power cycle the keyboard comes up red, which is the ZoneDefaultColor
# Acer declares for this model. So the EC does display a static colour; we have
# simply never known which register values produce it. Every write we have made
# set KBLE=0, which switches the backlight off, destroying the evidence.
#
# Run this FIRST THING after booting, before opening the app and before writing
# anything to four_zone_mode or per_zone_mode.
#
# The raw dump is saved before anything else happens, so the evidence survives
# even if the decoding below is wrong or the script is interrupted. Captures are
# timestamped and never overwritten.
#
# Read only. Run with:  sudo bash scripts/capture-boot-lighting.sh [label]
#
set -u

EC=/sys/kernel/debug/ec/ec0/io
OUT=/home/meet/Downloads/NitroSense-Linux-App/acpi/ec-captures
LABEL="${1:-boot}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BASE="$OUT/$STAMP-$LABEL"

[ "$(id -u)" = "0" ] || { echo "Run with sudo."; exit 1; }
if [ ! -r "$EC" ]; then
  modprobe ec_sys read_only=1 2>/dev/null
  [ -r "$EC" ] || { echo "Cannot read $EC"; exit 1; }
fi

mkdir -p "$OUT"

# ---------------------------------------------------------------- store first
# Raw bytes before any interpretation, so a mistake in the decoding below
# cannot lose the one state we care about.
cp "$EC" "$BASE.bin" 2>/dev/null || od -An -tx1 -v "$EC" > "$BASE.bin"
od -An -tx1 -v "$EC" > "$BASE.hex"
od -An -tu1 -v "$EC" > "$BASE.dec"

# ---------------------------------------------------------------- then decode
b=$(tr -s ' ' '\n' < "$BASE.dec" | grep -v '^$')
get() { echo "$b" | sed -n "$(($1 + 1))p"; }

{
  echo "NitroSense EC lighting capture"
  echo "  when   : $(date)"
  echo "  label  : $LABEL"
  echo "  kernel : $(uname -r)"
  echo "  module : $(lsmod 2>/dev/null | grep -c linuwu_sense) (1 = loaded)"
  echo "  daemon : $(systemctl is-active nitrosense-daemon 2>/dev/null || echo unknown)"
  echo
  echo "Offsets and field names are from this machine's own DSDT, not guesses."
  echo
  printf "  0x17 KBLE (mode)       = %s\n" "$(get 0x17)"
  printf "  0x18 KBLS (speed)      = %s\n" "$(get 0x18)"
  printf "  0x19 KBBP (brightness) = %s\n" "$(get 0x19)"
  printf "  0x1A KBCS              = %s\n" "$(get 0x1A)"
  printf "  0x1B KBED (direction)  = %s\n" "$(get 0x1B)"
  printf "  0x1C KBCR (red)        = %s\n" "$(get 0x1C)"
  printf "  0x1D KBCG (green)      = %s\n" "$(get 0x1D)"
  printf "  0x1E KBCB (blue)       = %s\n" "$(get 0x1E)"
  printf "  0x48 KBBA (zone sel)   = %s\n" "$(get 0x48)"
  echo
  printf "  zone1 = %s,%s,%s\n" "$(get 0x3C)" "$(get 0x3D)" "$(get 0x3E)"
  printf "  zone2 = %s,%s,%s\n" "$(get 0x3F)" "$(get 0x40)" "$(get 0x41)"
  printf "  zone3 = %s,%s,%s\n" "$(get 0x42)" "$(get 0x43)" "$(get 0x44)"
  printf "  zone4 = %s,%s,%s\n" "$(get 0x45)" "$(get 0x46)" "$(get 0x47)"
  echo
  echo "  sysfs four_zone_mode = $(cat /sys/devices/platform/acer-wmi/four_zoned_kb/four_zone_mode 2>/dev/null || echo unreadable)"
  echo "  sysfs per_zone_mode  = $(cat /sys/devices/platform/acer-wmi/four_zoned_kb/per_zone_mode 2>/dev/null || echo unreadable)"
} | tee "$BASE.txt"

# ------------------------------------------------------------------- compare
PREV=$(ls -1 "$OUT"/*.dec 2>/dev/null | grep -v "$STAMP" | tail -1)
if [ -n "$PREV" ]; then
  echo
  echo "Bytes that differ from the previous capture ($(basename "$PREV")):"
  paste <(tr -s ' ' '\n' < "$PREV" | grep -v '^$') \
        <(echo "$b") 2>/dev/null | awk '
    { if ($1 != $2) printf "  0x%02X : %s -> %s\n", NR-1, $1, $2 }' | head -40
fi

chmod -R a+r "$OUT" 2>/dev/null
echo
echo "Saved:"
ls -1 "$BASE".* | sed 's/^/  /'
