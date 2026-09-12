#!/usr/bin/env bash
#
# Installs the Electron frontend in place of the Avalonia GUI.
#
# WHAT THIS TOUCHES
#   /opt/damx/gui/          the GUI directory only
#
# WHAT THIS DOES NOT TOUCH
#   the DAMX daemon, damx-daemon.service, the linuwu_sense driver,
#   nitro-key-detection.sh, nitro-key-detection.service, or
#   /usr/local/bin/DAMX (the installer-owned wrapper)
#
# WHY THE PATH MATTERS
#   nitro-key-detection.service guards each key press with
#       pgrep -f "/opt/damx/gui/DivAcerManagerMax"
#   and /usr/local/bin/DAMX invokes that absolute path. Installing the
#   Electron binary under the same name at the same path keeps the existing
#   key handling working with no change to the daemon or the key service.
#
#   The binary must be a REAL FILE here, never a symlink to a build tree:
#   Electron re-execs itself via /proc/self/exe, so a symlinked install makes
#   every process report the resolved path and the guard silently never
#   matches. Verified in scripts/test-nitro-guard.sh.
#
# Usage:
#   sudo ./scripts/install-frontend.sh            install (backs up first)
#   sudo ./scripts/install-frontend.sh --uninstall restore the previous GUI
#
set -euo pipefail

GUI_DIR="/opt/damx/gui"
BIN_NAME="DivAcerManagerMax"
SRC="$(cd "$(dirname "$0")/.." && pwd)/release/linux-unpacked"
STAMP="$(date +%Y%m%d-%H%M%S)"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    red "This must run as root (it writes to /opt/damx/gui)."
    echo "  sudo $0 $*"
    exit 1
  fi
}

latest_backup() {
  find /opt/damx -maxdepth 1 -name 'gui.backup-*' -type d 2>/dev/null | sort | tail -1
}

uninstall() {
  require_root --uninstall
  local backup
  backup="$(latest_backup)"
  if [ -z "$backup" ]; then
    red "No backup found under /opt/damx (looked for gui.backup-*)."
    exit 1
  fi
  warn "Restoring $backup -> $GUI_DIR"
  rm -rf "$GUI_DIR"
  mv "$backup" "$GUI_DIR"
  green "Restored. The Nitro key and daemon were never modified."
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall

require_root

echo ""
echo "Installing the Electron frontend"
dim "  source: $SRC"
dim "  target: $GUI_DIR"
echo ""

if [ ! -x "$SRC/$BIN_NAME" ]; then
  red "Build not found at $SRC/$BIN_NAME"
  echo "  Run:  npm run package:dir"
  exit 1
fi

if [ ! -d "/opt/damx" ]; then
  red "/opt/damx does not exist — the DAMX suite does not look installed."
  echo "  Install the upstream suite first; this replaces only its GUI."
  exit 1
fi

# Back up whatever is there now, so the original Avalonia GUI is recoverable.
if [ -d "$GUI_DIR" ]; then
  BACKUP="/opt/damx/gui.backup-$STAMP"
  warn "Backing up the current GUI to $BACKUP"
  cp -a "$GUI_DIR" "$BACKUP"
else
  warn "No existing $GUI_DIR; creating it."
fi

mkdir -p "$GUI_DIR"
# Clear old contents but keep the directory itself, since other packaging
# may reference it.
find "$GUI_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "$SRC/." "$GUI_DIR/"

# Electron's sandbox helper must be setuid root when it lives outside a user
# directory, or the app refuses to start.
if [ -f "$GUI_DIR/chrome-sandbox" ]; then
  chown root:root "$GUI_DIR/chrome-sandbox"
  chmod 4755 "$GUI_DIR/chrome-sandbox"
fi
chmod +x "$GUI_DIR/$BIN_NAME"

echo ""
green "Installed."

# Verify the property the Nitro key actually depends on.
echo ""
echo "Verifying the Nitro key guard"
if [ -L "$GUI_DIR/$BIN_NAME" ]; then
  red "  The installed binary is a symlink. The pgrep guard will not match."
  exit 1
fi
dim "  real file at $GUI_DIR/$BIN_NAME  (not a symlink)"

if [ -f /usr/local/bin/DAMX ]; then
  if grep -q "$GUI_DIR/$BIN_NAME" /usr/local/bin/DAMX; then
    dim "  /usr/local/bin/DAMX still points at the guarded path"
  else
    warn "  /usr/local/bin/DAMX does not reference $GUI_DIR/$BIN_NAME"
    warn "  The Nitro key may launch something else."
  fi
fi

echo ""
green "Done. Press the Nitro key, or run:  DAMX"
dim "Roll back with:  sudo $0 --uninstall"
echo ""
