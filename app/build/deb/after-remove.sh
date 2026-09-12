#!/bin/bash
#
# Runs as root after the package is removed.
#
# Undoes exactly what after-install.sh did, and nothing else. Leftovers from a
# half-removed install are genuinely harmful here: a stale blacklist keeps
# acer_wmi from loading, so the machine loses its vendor hotkey handling with
# nothing installed to explain why.
#
set -u

MODNAME="linuwu_sense"
KVER="$(uname -r)"
MDIR="/lib/modules/$KVER/kernel/drivers/platform/x86"

echo "NitroSense: removing hardware support"

# ------------------------------------------------------------------ service
if [ -f /etc/systemd/system/nitrosense-daemon.service ]; then
  systemctl stop nitrosense-daemon.service 2>/dev/null || true
  systemctl disable nitrosense-daemon.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/nitrosense-daemon.service
  systemctl daemon-reload 2>/dev/null || true
fi
rm -f /var/run/nitrosense.sock
rm -rf /opt/NitroSense/backend

# ------------------------------------------------------------------ driver
rm -f /etc/modules-load.d/$MODNAME.conf
rm -f /etc/modprobe.d/blacklist-acer_wmi.conf
rm -f "$MDIR/$MODNAME.ko"
depmod -a "$KVER" 2>/dev/null || true

# Hand the hardware back to the in-tree driver, so hotkeys keep working.
rmmod "$MODNAME" 2>/dev/null || true
modprobe acer_wmi 2>/dev/null || true

# ------------------------------------------------------------------ desktop
command -v update-desktop-database >/dev/null 2>&1 \
  && update-desktop-database -q /usr/share/applications 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 \
  && gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true

# Per-user settings are deliberately left alone: the keyboard shortcut and the
# app's own config belong to the user, not the package, and removing them would
# lose the choice on a reinstall or upgrade.
echo "NitroSense: removed. Your keyboard shortcut was left in place."
exit 0
