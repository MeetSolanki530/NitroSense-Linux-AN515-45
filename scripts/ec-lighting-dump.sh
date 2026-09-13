#!/usr/bin/env bash
#
# Show the EC's keyboard lighting registers after a working effect and after a
# static write, so the two can be compared.
#
# The field names and offsets come from this machine's own ACPI tables, not
# from guesswork:
#
#   0x17 KBLE  effect/mode      0x1B KBED  direction
#   0x18 KBLS  speed            0x1C KBCR  red
#   0x19 KBBP  brightness       0x1D KBCG  green
#   0x1A KBCS  unknown          0x1E KBCB  blue
#   0x3C-0x47 KB1R..KB4B  the four zone colours
#   0x48 KBBA  zone selector
#
# WMBH method 0x14 writes bytes 0-7 straight into KBLE..KBCB and always returns
# success, which is why every write today reported OK. Method 0x06 writes the
# zone colours into KB1R..KB4B. So the colours reach the EC either way; what
# decides whether they show is KBLE.
#
# Read only. Run with:  sudo bash scripts/ec-lighting-dump.sh
#
set -u

EC=/sys/kernel/debug/ec/ec0/io
KB=/sys/devices/platform/acer-wmi/four_zoned_kb

[ "$(id -u)" = "0" ] || { echo "Run with sudo."; exit 1; }
if [ ! -r "$EC" ]; then
  modprobe ec_sys read_only=1 2>/dev/null
  [ -r "$EC" ] || { echo "Cannot read $EC"; exit 1; }
fi

show() {
  local b
  b=$(od -An -tu1 -v "$EC" | tr -s ' ' '\n' | grep -v '^$')
  get() { echo "$b" | sed -n "$(($1 + 1))p"; }

  printf "    KBLE(mode)=%-4s KBLS(speed)=%-4s KBBP(bright)=%-4s KBCS=%-4s KBED(dir)=%s\n" \
    "$(get 0x17)" "$(get 0x18)" "$(get 0x19)" "$(get 0x1A)" "$(get 0x1B)"
  printf "    KBCR=%-4s KBCG=%-4s KBCB=%-4s   KBBA(zone)=%s\n" \
    "$(get 0x1C)" "$(get 0x1D)" "$(get 0x1E)" "$(get 0x48)"
  printf "    zone1=%s,%s,%s  zone2=%s,%s,%s  zone3=%s,%s,%s  zone4=%s,%s,%s\n" \
    "$(get 0x3C)" "$(get 0x3D)" "$(get 0x3E)" \
    "$(get 0x3F)" "$(get 0x40)" "$(get 0x41)" \
    "$(get 0x42)" "$(get 0x43)" "$(get 0x44)" \
    "$(get 0x45)" "$(get 0x46)" "$(get 0x47)"
}

echo
echo "1. Breathing red, which lights"
echo "1,5,100,1,255,0,0" > "$KB/four_zone_mode"
sleep 1
show

echo
echo "2. Static green through four_zone_mode, which does not light"
echo "0,0,100,0,0,255,0" > "$KB/four_zone_mode"
sleep 1
show

echo
echo "3. Per-zone red/green/blue/yellow, which does not light"
echo "ff0000,00ff00,0000ff,ffff00,100" > "$KB/per_zone_mode"
sleep 1
show

echo
echo "4. Back to breathing"
echo "1,5,100,1,255,106,0" > "$KB/four_zone_mode"
sleep 1
show

echo
echo "Compare KBLE between 1 and 2. If the zone colours in 3 are correct but"
echo "nothing lights, the colours are reaching the EC and KBLE is what is"
echo "wrong, not the payload."
