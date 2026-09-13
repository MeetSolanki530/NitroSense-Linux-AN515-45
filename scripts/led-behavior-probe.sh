#!/usr/bin/env bash
#
# Probe SetGamingLEDBehavior, the WMI method Acer's own NitroSense calls and
# this driver never does.
#
# Acer's HW_Support.ini for the AN515-45 declares Type:1 lighting with four
# zones and per-zone default colours, so the hardware does support static
# per-zone colour. Both methods the driver uses have been exhausted. The app
# calls four methods; SetGamingLEDBehavior (id 2) and GetGamingLED (id 4) are
# the two it does not.
#
# Needs the wmi_raw debug attribute, so build and load the driver from this
# repo first:
#   cd Linuwu-Sense && make && sudo rmmod linuwu_sense && sudo insmod src/linuwu_sense.ko
#
# Run with:  sudo bash scripts/led-behavior-probe.sh
#
set -u

KB=/sys/devices/platform/acer-wmi/four_zoned_kb
RAW=$KB/wmi_raw
S=$KB/four_zone_mode
P=$KB/per_zone_mode

[ "$(id -u)" = "0" ] || { echo "Run with sudo."; exit 1; }
[ -w "$RAW" ] || {
  echo "wmi_raw not present. Build and load this repo's driver first:"
  echo "  cd ~/Downloads/NitroSense-Linux-App/Linuwu-Sense"
  echo "  make && sudo rmmod linuwu_sense && sudo insmod src/linuwu_sense.ko"
  exit 1
}

dmesg -C 2>/dev/null || true

echo
echo "For each: the LED behaviour call is made, then static green is written."
echo "Answer y only if the keyboard lights green."
echo

try() {
  echo "$1" > "$RAW" 2>/dev/null
  echo "0,0,100,0,0,255,0" > "$S" 2>/dev/null
  printf "  wmi_raw '%-18s' then static  green? " "$1"
  read -r a < /dev/tty
  case "$a" in [Yy]*) echo "    >>> WORKS: $1"; WORKED="$WORKED\n  $1 (static)";; esac

  echo "00ff00,00ff00,00ff00,00ff00,100" > "$P" 2>/dev/null
  printf "  %-32s per-zone green? " ""
  read -r b < /dev/tty
  case "$b" in [Yy]*) echo "    >>> WORKS: $1 (per-zone)"; WORKED="$WORKED\n  $1 (per-zone)";; esac
}

WORKED=""

# Method 2, SetGamingLEDBehavior. One byte is the usual shape for an on/off or
# a behaviour selector.
try "2 0"
try "2 1"
try "2 2"
try "2 3"

# With a zone mask alongside, in case it takes behaviour plus target.
try "2 1 15"
try "2 1 1 2 4 8"

# BIT(3) is ACER_GAMING_KBL_SET_ON in the mainline acer-wmi RFC.
try "2 8"
try "2 8 1"

echo
if [ -n "$WORKED" ]; then
  echo "Worked:"
  printf "$WORKED\n"
else
  echo "None of these lit it."
fi

echo
echo "Kernel log from the probes (reply values show what the firmware thought):"
dmesg 2>/dev/null | grep wmi_raw || echo "  (none)"

echo
echo "Restoring breathing so you are not left dark."
echo "1,5,100,1,255,106,0" > "$S" 2>/dev/null
