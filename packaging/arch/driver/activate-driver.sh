#!/usr/bin/env bash
# Start on the tested model only. Keep the stock driver available for recovery.
set -euo pipefail
[[ $(cat /sys/class/dmi/id/product_name) == 'Nitro AN515-45' ]] || {
  echo 'This installation is validated only for Nitro AN515-45' >&2; exit 1;
}
modinfo -k "$(uname -r)" linuwu_sense >/dev/null
recover() {
  if [[ -d /sys/module/linuwu_sense ]]; then
    modprobe -r linuwu_sense || return 1
  fi
  modprobe acer_wmi
}
if [[ ! -d /sys/module/linuwu_sense ]]; then
  modprobe -r acer_wmi
  if ! modprobe -a wmi video sparse_keymap rfkill || ! modprobe linuwu_sense; then
    recover
    exit 1
  fi
fi
fan=/sys/devices/platform/acer-wmi/nitro_sense/fan_speed
if [[ ! -e $fan ]] || ! printf '0,0\n' > "$fan"; then
  echo 'Could not initialize firmware automatic fan mode; restoring stock driver' >&2
  recover
  exit 1
fi
