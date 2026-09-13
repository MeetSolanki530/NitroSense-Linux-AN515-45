#!/usr/bin/env bash
#
# Find the EC state that shows a static per-zone colour.
#
# Established from this machine's ACPI tables and EC dumps:
#   - method 0x06 writes zone colours into KB1R..KB4B correctly
#   - method 0x14 writes bytes 0-7 into KBLE,KBLS,KBBP,KBCS,KBED,KBCR,KBCG,KBCB
#   - KBLE=0 leaves the keyboard dark; KBLE=1..5 are working effects
#   - so KBLE=0 is OFF, not static, and static is some other combination
#
# Two fields are unreachable through the sysfs files and are swept here via the
# wmi_raw debug attribute:
#   KBCS, byte 3, which the firmware special-cases at 8
#   KBBA, the zone selector, left at 8 by the last per-zone write
#
# Run with:  sudo bash scripts/static-mode-hunt.sh
#
set -u

KB=/sys/devices/platform/acer-wmi/four_zoned_kb
RAW=$KB/wmi_raw

[ "$(id -u)" = "0" ] || { echo "Run with sudo."; exit 1; }
[ -w "$RAW" ] || { echo "wmi_raw missing. Build and load this repo's driver."; exit 1; }

# Distinct colours per zone, so a working static is unmistakable.
zones() {
  echo "6 1 255 0 0"   > "$RAW"   # zone 1 red
  echo "6 2 0 255 0"   > "$RAW"   # zone 2 green
  echo "6 4 0 0 255"   > "$RAW"   # zone 3 blue
  echo "6 8 255 255 0" > "$RAW"   # zone 4 yellow
}

ask() {
  printf "  %-46s lit? " "$1"
  read -r a < /dev/tty
  case "$a" in [Yy]*) FOUND="$FOUND\n  $1";; esac
}

FOUND=""
echo
echo "Each test sets four different zone colours, then a mode. Answer y if"
echo "ANY light appears, even one colour across the whole keyboard."
echo

# KBCS sweep with KBLE=0
for cs in 1 2 4 8 16 255; do
  zones
  echo "20 0 0 100 $cs 0 0 255 0" > "$RAW"
  ask "KBLE=0 KBCS=$cs"
done

# KBBA set to all zones, then KBLE=0
for ba in 15 0 255; do
  zones
  echo "6 $ba 0 255 0" > "$RAW"
  echo "20 0 0 100 0 0 0 255 0" > "$RAW"
  ask "KBBA=$ba then KBLE=0"
done

# KBLE values the driver allows but we have not tried with zone colours set
for le in 6 7; do
  zones
  echo "20 $le 0 100 0 0 0 255 0" > "$RAW"
  ask "KBLE=$le"
done

# KBLE beyond the driver's 0-7 range, reachable only through wmi_raw
for le in 8 9 10 15; do
  zones
  echo "20 $le 0 100 0 0 0 255 0" > "$RAW"
  ask "KBLE=$le"
done

# An effect at speed 0 with zone colours, in case zone display rides on a mode
for le in 1 4 5; do
  zones
  echo "20 $le 0 100 0 0 0 255 0" > "$RAW"
  ask "KBLE=$le speed=0 with zone colours"
done

echo
if [ -n "$FOUND" ]; then
  echo "Lit with:"
  printf "$FOUND\n"
else
  echo "Nothing lit."
fi

echo
echo "Restoring breathing."
echo "1,5,100,1,255,106,0" > "$KB/four_zone_mode"
