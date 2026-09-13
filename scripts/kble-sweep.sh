#!/usr/bin/env bash
#
# Sweep every KBLE value looking for one that displays the per-zone colours.
#
# What is established:
#   PSEE (bit 4 of EC byte 0x03) decides who owns the lighting. 0 = the EC's
#   own default red, which ignores the zone registers. 1 = software, via KBLE.
#   KBLE 0 is off, 1..5 are the effects and use KBCR/KBCG/KBCB, not the zones.
#
# The zone registers KB1R..KB4B are written correctly and something must read
# them, because Acer's own app does four-zone static on this hardware. Only
# about a dozen of the 256 possible KBLE values have been tried.
#
# This sets four obvious zone colours, then walks KBLE printing each value.
# Watch the keyboard and the terminal together: when light appears, note the
# number on screen and press Ctrl-C.
#
# Run with:  sudo bash scripts/kble-sweep.sh [start] [end]
#
set -u

KB=/sys/devices/platform/acer-wmi/four_zoned_kb
RAW=$KB/wmi_raw
START="${1:-0}"
END="${2:-255}"
DELAY=0.45

[ "$(id -u)" = "0" ] || { echo "Run with sudo."; exit 1; }
if [ ! -w "$RAW" ]; then
  echo "wmi_raw is not available, so the loaded driver is not this repo's."
  echo "  cd ~/Downloads/NitroSense-Linux-App/Linuwu-Sense"
  echo "  make && sudo rmmod linuwu_sense && sudo insmod src/linuwu_sense.ko"
  exit 1
fi

# Distinct colours, so a per-zone display is unmistakable.
echo "6 1 255 0 0"   > "$RAW"
echo "6 2 0 255 0"   > "$RAW"
echo "6 4 0 0 255"   > "$RAW"
echo "6 8 255 255 0" > "$RAW"

echo
echo "Zones set to red / green / blue / yellow."
echo "Walking KBLE from $START to $END. Watch the keyboard."
echo "Note the number on screen when ANY light appears, then Ctrl-C."
echo

for le in $(seq "$START" "$END"); do
  # KBLE, KBLS=5, KBBP=100, KBCS=0, KBED=1, then white as the fallback colour
  # so a mode using KBCR/KBCG/KBCB shows white rather than black.
  echo "20 $le 5 100 0 1 255 255 255" > "$RAW" 2>/dev/null
  printf "\r  KBLE = %-4s" "$le"
  sleep "$DELAY"
done

echo
echo
echo "Sweep finished. Restoring breathing."
echo "1,5,100,1,255,106,0" > "$KB/four_zone_mode"
