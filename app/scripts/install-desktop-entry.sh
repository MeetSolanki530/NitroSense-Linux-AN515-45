#!/usr/bin/env bash
#
# Adds the app to the desktop's application menu, for running from source.
#
# WHAT THIS TOUCHES  (all under your home directory, no root, no /opt)
#   ~/.local/share/applications/nitrosense.desktop
#   ~/.local/share/icons/hicolor/<size>/apps/nitrosense.png
#
# The packaged install (scripts/install-frontend.sh) writes its own system-wide
# entry instead; this one exists so the source tree is launchable from the
# menu without installing anything.
#
#   ./scripts/install-desktop-entry.sh            install
#   ./scripts/install-desktop-entry.sh --uninstall remove
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ICON_SRC="$APP_DIR/build/icons"
DESKTOP_FILE="$HOME/.local/share/applications/nitrosense.desktop"
ICON_ROOT="$HOME/.local/share/icons/hicolor"
SIZES="16 24 32 48 64 128 256 512"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

refresh_caches() {
  command -v update-desktop-database >/dev/null 2>&1 \
    && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 \
    && gtk-update-icon-cache -f -t "$ICON_ROOT" 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$DESKTOP_FILE"
  for s in $SIZES; do rm -f "$ICON_ROOT/${s}x${s}/apps/nitrosense.png"; done
  refresh_caches
  green "Removed the desktop entry and icons."
  exit 0
fi

[ -d "$ICON_SRC" ] || { red "Icons missing at $ICON_SRC"; exit 1; }

for s in $SIZES; do
  src="$ICON_SRC/${s}x${s}.png"
  [ -f "$src" ] || continue
  install -Dm644 "$src" "$ICON_ROOT/${s}x${s}/apps/nitrosense.png"
done

mkdir -p "$(dirname "$DESKTOP_FILE")"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=NitroSense
GenericName=Acer Nitro Control
Comment=Fan, power, battery and keyboard control for Acer Nitro laptops
Exec=$APP_DIR/scripts/launch.sh
Icon=nitrosense
Terminal=false
Categories=Settings;HardwareSettings;
Keywords=acer;nitro;fan;rgb;battery;nitrosense;
StartupNotify=true
StartupWMClass=nitrosense
EOF
chmod 644 "$DESKTOP_FILE"

refresh_caches

green "Installed."
dim "  entry: $DESKTOP_FILE"
dim "  icons: $ICON_ROOT/<size>/apps/nitrosense.png"
echo ""
dim "It should appear in the app menu as \"NitroSense\"."
dim "To pin it to the dock, launch it once, then right-click its icon."
dim "Remove with:  $0 --uninstall"
