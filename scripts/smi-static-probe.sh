#!/usr/bin/env bash
#
# Last avenue for a chooseable static colour: the SMI methods.
#
# Method 2 (SetGamingLEDBehavior) is dispatched to WSMI, which hands the whole
# 16-byte buffer to the BIOS's SMM code. That code is not in the ACPI tables so
# it cannot be read, but it can be called. Acer's own NitroSense calls this
# method and this driver never has.
#
# Earlier probing sent one or two bytes. Method 2 accepted exactly 8, BIT(3),
# and rejected 0,1,2,3. This tries fuller payloads shaped like the backlight
# call, since that is the only payload layout we know this firmware uses.
#
# Everything asks for GREEN, so success is unmistakable.
#
# Run with:  sudo bash scripts/smi-static-probe.sh
#
set -u

KB=/sys/devices/platform/acer-wmi/four_zoned_kb
RAW=$KB/wmi_raw
EC=/sys/kernel/debug/ec/ec0/io

[ "$(id -u)" = "0" ] || { echo "Run with sudo."; exit 1; }
[ -w "$RAW" ] || { echo "wmi_raw missing. Load this repo's driver."; exit 1; }

dmesg -C 2>/dev/null || true

FOUND=""
try() {
  echo "$1" > "$RAW" 2>/dev/null
  printf "  %-34s green? " "$1"
  read -r a < /dev/tty
  case "$a" in [Yy]*) FOUND="$FOUND\n  $1"; echo "    >>> WORKS";; esac
}

echo
echo "Method 2 with a backlight-shaped payload."
echo "Fields are: flag, speed, brightness, ?, direction, R, G, B"
echo

try "2 8 0 100 0 0 0 255 0"
try "2 8 5 100 0 1 0 255 0"
try "2 8 0 100 8 0 0 255 0"
try "2 8 15 100 0 0 0 255 0"

echo
echo "Method 2 with a zone-shaped payload, like method 6."
echo
try "2 8 1 0 255 0"
try "2 8 15 0 255 0"
try "2 1 8 0 255 0"

echo
echo "The other SMI methods that take input, same green."
echo
for m in 1 3 4 8 9 10 11 12 13 14 15 18 19; do
  try "$m 8 0 100 0 0 0 255 0"
done

echo
if [ -n "$FOUND" ]; then
  echo "Lit with:"
  printf "$FOUND\n"
else
  echo "Nothing lit."
fi

echo
echo "Firmware replies (0 means accepted):"
dmesg 2>/dev/null | grep wmi_raw | tail -30

echo
echo "Handing the keyboard back to the EC so you are not left dark."
cur=$(dd if="$EC" bs=1 skip=3 count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
echo "  EC byte 0x03 = $cur"
