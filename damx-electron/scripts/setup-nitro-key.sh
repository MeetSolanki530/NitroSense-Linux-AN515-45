#!/usr/bin/env bash
#
# Binds the NitroSense key on the keyboard to launch this app.
#
# WHAT THIS TOUCHES  (all per-user GNOME settings, no root, no /etc, no /opt)
#   org.gnome.settings-daemon.plugins.media-keys custom-keybindings
#
# The upstream DAMX suite handles this key with a root systemd unit that
# pgreps for /opt/damx/gui/DivAcerManagerMax. That only works once the suite is
# installed there. Running from source, a GNOME custom shortcut does the same
# job with no privileges and no background process.
#
#   ./scripts/setup-nitro-key.sh --detect     find which key your Nitro key is
#   ./scripts/setup-nitro-key.sh              bind it (default XF86Launch1)
#   ./scripts/setup-nitro-key.sh XF86Launch2  bind a specific key
#   ./scripts/setup-nitro-key.sh --uninstall  remove the binding
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER="$APP_DIR/scripts/launch.sh"
NAME="Div Acer Manager Max"
SCHEMA="org.gnome.settings-daemon.plugins.media-keys"
CUSTOM="org.gnome.settings-daemon.plugins.media-keys.custom-keybinding"
BASE="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

detect() {
  head_ "Detecting the Nitro key"
  command -v evtest >/dev/null || { red "evtest is not installed:  sudo apt install evtest"; exit 1; }

  local dev
  dev="$(grep -B 4 'Handlers=.*event' /proc/bus/input/devices \
         | grep -A 4 'Acer WMI hotkeys' \
         | grep -oE 'event[0-9]+' | head -1 || true)"
  [ -n "$dev" ] || { red "No 'Acer WMI hotkeys' input device found."; exit 1; }

  dim "  device: /dev/input/$dev"
  echo ""
  warn "  Press the NitroSense key now. Ctrl-C when you see its line."
  echo ""
  dim "  Look for a line like:  code 148 (KEY_PROG1)"
  dim "  Then re-run this script with the matching key:"
  dim "     KEY_PROG1 -> XF86Launch1      KEY_PROG3 -> XF86Launch3"
  dim "     KEY_PROG2 -> XF86Launch2      KEY_PROG4 -> XF86Launch4"
  echo ""
  sudo evtest "/dev/input/$dev"
}

[ "${1:-}" = "--detect" ] && { detect; exit 0; }

command -v gsettings >/dev/null || { red "gsettings not found; this needs a GNOME-based session."; exit 1; }

# Find an existing entry for us, or the first free slot.
list="$(gsettings get "$SCHEMA" custom-keybindings 2>/dev/null || echo "@as []")"
slot=""
for i in $(seq 0 20); do
  path="$BASE/custom$i/"
  existing="$(gsettings get "$CUSTOM:$path" name 2>/dev/null || echo "''")"
  if [ "$existing" = "'$NAME'" ]; then slot="$path"; break; fi
done

if [ "${1:-}" = "--uninstall" ]; then
  if [ -z "$slot" ]; then dim "No binding of ours found."; exit 0; fi
  cleaned="$(python3 - "$list" "$slot" <<'PY'
import ast, sys
raw, slot = sys.argv[1], sys.argv[2]
try:
    items = ast.literal_eval(raw) if raw.strip() not in ('@as []', '') else []
except (ValueError, SyntaxError):
    items = []
items = [i for i in items if i != slot]
print("[" + ", ".join(f"'{i}'" for i in items) + "]")
PY
)"
  gsettings set "$SCHEMA" custom-keybindings "$cleaned"
  gsettings reset-recursively "$CUSTOM:$slot" 2>/dev/null || true
  green "Removed the Nitro key binding."
  exit 0
fi

KEY="${1:-XF86Launch1}"
[ -x "$LAUNCHER" ] || { red "Launcher missing or not executable: $LAUNCHER"; exit 1; }

if [ -z "$slot" ]; then
  for i in $(seq 0 20); do
    path="$BASE/custom$i/"
    used="$(gsettings get "$CUSTOM:$path" binding 2>/dev/null || echo "''")"
    if [ "$used" = "''" ] || [ "$used" = "@as []" ]; then slot="$path"; break; fi
  done
fi
[ -n "$slot" ] || { red "No free custom-shortcut slot found."; exit 1; }

gsettings set "$CUSTOM:$slot" name "$NAME"
gsettings set "$CUSTOM:$slot" command "$LAUNCHER"
gsettings set "$CUSTOM:$slot" binding "$KEY"

# Register the slot, without dropping anyone else's shortcuts.
merged="$(python3 - "$list" "$slot" <<'PY'
import ast, sys
raw, slot = sys.argv[1], sys.argv[2]
try:
    items = ast.literal_eval(raw) if raw.strip() not in ('@as []', '') else []
except (ValueError, SyntaxError):
    items = []
if slot not in items:
    items.append(slot)
print("[" + ", ".join(f"'{i}'" for i in items) + "]")
PY
)"
gsettings set "$SCHEMA" custom-keybindings "$merged"

green "Bound $KEY to the app."
dim "  slot:    $slot"
dim "  command: $LAUNCHER"
echo ""
dim "Press the NitroSense key to test. The splash appears immediately, then"
dim "the window. Pressing it again focuses the running window rather than"
dim "opening a second one (single-instance lock)."
echo ""
dim "Wrong key? Find the right one with:  $0 --detect"
dim "Remove with:  $0 --uninstall"
