#!/usr/bin/env bash
# Run with administrator privileges to undo persistent activation.
set -euo pipefail
systemctl disable --now nitrosense-daemon.service nitrosense-driver.service
if [[ -d /sys/module/linuwu_sense ]]; then
  fan=/sys/devices/platform/acer-wmi/nitro_sense/fan_speed
  if [[ -e $fan ]]; then printf '0,0\n' > "$fan"; fi
  modprobe -r linuwu_sense
fi
modprobe acer_wmi
printf 'Stock acer_wmi restored. NitroSense boot startup is disabled.\n'
