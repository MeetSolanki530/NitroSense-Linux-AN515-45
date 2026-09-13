#!/bin/bash
#
# Runs as root after the package is unpacked.
#
# Brings up everything the app needs so that launching it just works:
#   1. the kernel driver, built against the running kernel and loaded at boot
#   2. the background service that talks to it
#   3. desktop and icon caches
#
# Deliberately never fails the install. A machine without kernel headers still
# gets a working app — it simply shows its hardware controls as unavailable
# until the driver can be built. Aborting the whole install over that would be
# worse than installing something partly useful.
#
set -u

RES="/opt/NitroSense/resources"
DRIVER_SRC="$RES/backend/driver"
DAEMON_SRC="$RES/backend/daemon"
DAEMON_DIR="/opt/NitroSense/backend"
SERVICE="/etc/systemd/system/nitrosense-daemon.service"
MODNAME="linuwu_sense"
KVER="$(uname -r)"
MDIR="/lib/modules/$KVER/kernel/drivers/platform/x86"

# DKMS package identity. Must match packaging/dkms.conf, since DKMS locates the
# source tree by "/usr/src/<name>-<version>".
DKMS_NAME="linuwu-sense"
DKMS_VER="0.2.0"
DKMS_SRC="/usr/src/$DKMS_NAME-$DKMS_VER"

say()  { echo "  $*"; }
warn() { echo "  ! $*" >&2; }

echo "NitroSense: setting up hardware support"

# ------------------------------------------------------------------ preflight
#
# Check what is actually present on THIS machine and collect anything missing,
# rather than declaring it all as hard dependencies.
#
# The kernel headers cannot be a dependency at all: the package name carries
# the running kernel version, so a fixed one would be wrong on most machines
# and would pull in a second kernel on some. nvidia-utils genuinely is
# optional, and making it a dependency would drag the proprietary driver onto
# machines that have deliberately avoided it.
#
# So the install never fails over any of this. It reports what is missing, with
# the one command that fixes it, and carries on.
MISSING=""
NOTE=""

need() {
  # need <apt package> <test command...>
  local pkg="$1"; shift
  if ! "$@" >/dev/null 2>&1; then
    MISSING="$MISSING $pkg"
  fi
}

# Required to build the kernel driver, which is what every hardware control
# needs. Without these the app installs and runs, showing them unavailable.
[ -d "/lib/modules/$KVER/build" ] || MISSING="$MISSING linux-headers-$KVER"
need build-essential command -v gcc
need make command -v make

# The driver needs the platform_profile device class, which arrived in 6.14.
# Older kernels fail the build with a page of errors about platform_profile_ops
# and BACKLIGHT_POWER_ON, which reads as something being wrong with the package
# rather than the kernel being too old. Say it plainly instead.
KERNEL_TOO_OLD=""
kver_major=${KVER%%.*}
kver_rest=${KVER#*.}
kver_minor=${kver_rest%%.*}
case "$kver_major$kver_minor" in
  *[!0-9]*) : ;;   # unparseable, do not guess
  *)
    if [ "$kver_major" -lt 6 ] || { [ "$kver_major" -eq 6 ] && [ "$kver_minor" -lt 14 ]; }; then
      KERNEL_TOO_OLD="yes"
    fi
    ;;
esac

# The app offers to start the background service for you, which needs a
# desktop authorisation prompt. The package that provides pkexec was split out
# of policykit-1 in polkit 122, so the name differs by release; suggest the one
# that actually exists here rather than a name that may 404 on apt.
if ! command -v pkexec >/dev/null 2>&1; then
  if apt-cache show pkexec >/dev/null 2>&1; then
    MISSING="$MISSING pkexec"
  else
    MISSING="$MISSING policykit-1"
  fi
fi

# Rebuilds the driver on every kernel upgrade. Strongly wanted rather than
# required: without it the driver works until the next kernel update and then
# silently disappears, which looks exactly like the app breaking by itself.
command -v dkms >/dev/null 2>&1 || MISSING="$MISSING dkms"

# Secure Boot refuses unsigned out-of-tree modules outright. Worth detecting
# up front, because the failure it produces ("Operation not permitted" or "Key
# was rejected by service") reads like a permissions problem and is not one.
SECUREBOOT="unknown"
if command -v mokutil >/dev/null 2>&1; then
  case "$(mokutil --sb-state 2>/dev/null)" in
    *enabled*)  SECUREBOOT="enabled" ;;
    *disabled*) SECUREBOOT="disabled" ;;
  esac
elif [ -d /sys/firmware/efi ]; then
  # No mokutil, so read the EFI variable directly. Its last byte is the flag.
  sb_var=$(find /sys/firmware/efi/efivars -name 'SecureBoot-*' 2>/dev/null | head -1)
  if [ -n "$sb_var" ]; then
    case "$(od -An -t u1 "$sb_var" 2>/dev/null | tr -s ' ' | awk '{print $NF}')" in
      1) SECUREBOOT="enabled" ;;
      0) SECUREBOOT="disabled" ;;
    esac
  fi
fi

# Optional: discrete GPU temperature, clock and utilisation. Everything else
# works without it, and the integrated GPU is read from sysfs directly.
if ! command -v nvidia-smi >/dev/null 2>&1; then
  if [ -d /proc/driver/nvidia ] || lspci 2>/dev/null | grep -qi 'vga.*nvidia'; then
    NOTE="$NOTE\n  An NVIDIA GPU is present but nvidia-smi is not installed, so"
    NOTE="$NOTE\n  discrete GPU readings will be blank. Install the NVIDIA driver"
    NOTE="$NOTE\n  package for your distribution if you want them."
  fi
fi

# ------------------------------------------------------------------ driver

# This driver replaces acer_wmi and cannot coexist with it. Done once, before
# either build path, since both need it.
blacklist_acer_wmi() {
  echo "blacklist acer_wmi" > /etc/modprobe.d/blacklist-acer_wmi.conf
  rmmod acer_wmi 2>/dev/null || true
}

# Load at every boot. No module parameter on purpose: find_quirks() returns
# early for a forced one, before DMI matching runs, which would discard the
# per-model quirk that declares the four-zone keyboard.
enable_at_boot() {
  echo "$MODNAME" > /etc/modules-load.d/$MODNAME.conf
}

# Preferred path. DKMS keeps a copy of the source under /usr/src and rebuilds
# it whenever a new kernel is installed, so the driver survives the routine
# kernel upgrades that would otherwise leave the app with no hardware at all.
# It also signs the module automatically where the distribution has set up MOK
# signing, which is what makes Secure Boot machines work.
install_driver_dkms() {
  command -v dkms >/dev/null 2>&1 || return 1

  # Remove any older revision first, or dkms refuses to add over it.
  dkms remove -m "$DKMS_NAME" -v "$DKMS_VER" --all >/dev/null 2>&1 || true
  rm -rf "$DKMS_SRC"

  install -d "$DKMS_SRC"
  cp -a "$DRIVER_SRC"/. "$DKMS_SRC"/ || return 1
  [ -f "$DKMS_SRC/dkms.conf" ] || return 1

  say "registering the driver with DKMS (rebuilds on kernel updates)"
  if ! dkms add -m "$DKMS_NAME" -v "$DKMS_VER" >/tmp/nitrosense-driver-build.log 2>&1; then
    warn "dkms add failed; see /tmp/nitrosense-driver-build.log"
    return 1
  fi
  if ! dkms build -m "$DKMS_NAME" -v "$DKMS_VER" -k "$KVER" \
        >>/tmp/nitrosense-driver-build.log 2>&1; then
    warn "dkms build failed; see /tmp/nitrosense-driver-build.log"
    return 1
  fi
  if ! dkms install -m "$DKMS_NAME" -v "$DKMS_VER" -k "$KVER" --force \
        >>/tmp/nitrosense-driver-build.log 2>&1; then
    warn "dkms install failed; see /tmp/nitrosense-driver-build.log"
    return 1
  fi
  return 0
}

# Fallback for machines without dkms. Builds once, for the running kernel only.
install_driver_manual() {
  command -v make >/dev/null 2>&1 || { warn "make not found"; return 1; }
  command -v gcc  >/dev/null 2>&1 || { warn "gcc not found";  return 1; }

  say "building the kernel driver for $KVER"
  if ! make -C "$DRIVER_SRC" >/tmp/nitrosense-driver-build.log 2>&1; then
    warn "driver build failed; see /tmp/nitrosense-driver-build.log"
    return 1
  fi

  install -d "$MDIR"
  install -m 644 "$DRIVER_SRC/src/$MODNAME.ko" "$MDIR/"
  depmod -a "$KVER" || true
  return 0
}

install_driver() {
  if [ ! -f "$DRIVER_SRC/Makefile" ]; then
    warn "driver source missing; hardware controls will be unavailable"
    return 1
  fi
  if [ -n "$KERNEL_TOO_OLD" ]; then
    warn "this kernel ($KVER) is older than 6.14, which the driver needs"
    warn "the app will install, but hardware controls stay unavailable"
    warn "until you boot a newer kernel. See the summary below."
    return 1
  fi
  if [ ! -d "/lib/modules/$KVER/build" ]; then
    warn "kernel headers for $KVER not found"
    warn "install them, then run:  sudo dpkg-reconfigure nitrosense"
    warn "  Debian/Ubuntu:  sudo apt install linux-headers-$KVER"
    return 1
  fi

  blacklist_acer_wmi

  if install_driver_dkms; then
    say "driver built and registered with DKMS"
  elif install_driver_manual; then
    warn "built without DKMS: the driver will stop working after a kernel"
    warn "update until it is rebuilt. Install dkms and run"
    warn "'sudo dpkg-reconfigure nitrosense' to make it permanent."
  else
    return 1
  fi

  enable_at_boot

  modprobe "$MODNAME" 2>/dev/null || true
  if [ -d "/sys/module/$MODNAME" ]; then
    say "driver loaded"
    return 0
  fi

  # Distinguish the two reasons loading fails, because they need opposite
  # actions and the generic "try rebooting" advice fits neither. Secure Boot
  # rejects the module's signature; anything else usually just needs the
  # blacklist of acer_wmi to take effect on the next boot.
  if [ "$SECUREBOOT" = "enabled" ]; then
    warn "the driver was built but Secure Boot refused to load it"
    warn "either enrol a signing key (sudo mokutil --import ...) or turn"
    warn "Secure Boot off in the firmware settings, then reboot"
  else
    warn "driver installed but did not load; a reboot should pick it up"
  fi
  return 0
}

install_driver || true

# ------------------------------------------------------------------ service
# The kernel driver ships a service of its own, and installing it by hand
# leaves that behind. Ours supersedes it, and two services touching the same
# hardware is worse than either alone, so stand it down first.
for legacy in linuwu_sense.service; do
  if [ -f "/etc/systemd/system/$legacy" ]; then
    say "standing down a leftover $legacy"
    systemctl stop "$legacy" 2>/dev/null || true
    systemctl disable "$legacy" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$legacy"
  fi
done

install -d "$DAEMON_DIR"
if [ -f "$DAEMON_SRC/nitrosense-daemon.py" ]; then
  install -m 755 "$DAEMON_SRC"/*.py "$DAEMON_DIR/"

  cat > "$SERVICE" <<'UNIT'
[Unit]
Description=NitroSense hardware service
Documentation=https://github.com/MeetSolanki530/NitroSense-Linux-AN515-45
# The driver must exist before this can read or write anything through it.
After=systemd-modules-load.service
Wants=systemd-modules-load.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/NitroSense/backend/nitrosense-daemon.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload 2>/dev/null || true
  systemctl enable nitrosense-daemon.service >/dev/null 2>&1 || true
  systemctl restart nitrosense-daemon.service 2>/dev/null || true

  # Give it a moment to bind, so the message below reflects reality.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -S /var/run/nitrosense.sock ] && break
    sleep 0.3
  done
  if [ -S /var/run/nitrosense.sock ]; then
    say "background service running"
  else
    warn "service did not start; check:  systemctl status nitrosense-daemon"
  fi
else
  warn "service files missing; hardware controls will be unavailable"
fi

# ------------------------------------------------------------------ desktop
command -v update-desktop-database >/dev/null 2>&1 \
  && update-desktop-database -q /usr/share/applications 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 \
  && gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true

# Electron's sandbox helper must be setuid root outside a user directory.
if [ -f /opt/NitroSense/chrome-sandbox ]; then
  chown root:root /opt/NitroSense/chrome-sandbox
  chmod 4755 /opt/NitroSense/chrome-sandbox
fi

# ------------------------------------------------------------------ summary
#
# Last, so it is the part still on screen when apt finishes rather than being
# scrolled away by the driver build.
if [ -n "$KERNEL_TOO_OLD" ]; then
  echo ""
  echo "NitroSense: this kernel is too old"
  echo ""
  echo "  You are running $KVER. The driver needs 6.14 or newer, because it"
  echo "  uses a kernel interface that did not exist before then. This is not"
  echo "  something the package can work around."
  echo ""
  echo "  On Ubuntu 24.04, the newer kernel is one package away:"
  echo ""
  echo "    sudo apt install linux-generic-hwe-24.04"
  echo ""
  echo "  Reboot into it and the driver builds by itself. Until then the app"
  echo "  opens but every hardware control stays unavailable."
fi

if [ -n "$MISSING" ]; then
  echo ""
  echo "NitroSense: some things are missing"
  echo ""
  echo "  Install them with:"
  echo ""
  # shellcheck disable=SC2086
  echo "    sudo apt install$MISSING"
  echo ""
  echo "  Then rebuild the driver:"
  echo ""
  echo "    sudo dpkg-reconfigure nitrosense"
  echo ""
  echo "  The app works without them; hardware controls will show as"
  echo "  unavailable until the driver can be built."
fi

if [ -n "$NOTE" ]; then
  echo ""
  # shellcheck disable=SC2059
  printf "NitroSense: note$NOTE\n"
fi

# Only worth raising when the driver actually failed to load, since on a
# machine with MOK signing set up Secure Boot causes no trouble at all and
# saying otherwise would just be noise.
if [ "$SECUREBOOT" = "enabled" ] && [ ! -d "/sys/module/$MODNAME" ]; then
  echo ""
  echo "NitroSense: Secure Boot is on"
  echo ""
  echo "  Secure Boot only accepts kernel modules signed with a key your"
  echo "  firmware trusts, and this one is built on your machine, so it is"
  echo "  not signed by anybody yet."
  echo ""
  echo "  Two ways forward:"
  echo ""
  echo "    - Enrol a signing key, which keeps Secure Boot on. Installing"
  echo "      dkms and shim-signed sets this up and prompts you at the next"
  echo "      reboot to confirm the key."
  echo ""
  echo "    - Or turn Secure Boot off in the firmware settings."
fi

echo ""
echo "NitroSense: ready. Launch it from the app menu."
exit 0
