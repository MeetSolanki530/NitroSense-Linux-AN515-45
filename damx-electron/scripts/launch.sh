#!/usr/bin/env bash
#
# Launches the app from this source tree, for the desktop entry to call.
#
# Builds only when the build output is missing or older than the sources, so a
# normal launch is instant rather than a 10-second rebuild.
#
# VS Code's Flatpak exports ELECTRON_RUN_AS_NODE=1, which makes the electron
# binary behave as plain node and exit without a window. Clearing it here as
# well as in `npm start` means launching from the desktop works even when the
# session inherited that variable.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

needs_build() {
  [ ! -f dist/index.html ] && return 0
  [ ! -f dist-electron/main.cjs ] && return 0
  # Rebuild when any tracked source is newer than the bundled entry point.
  if find electron src index.html vite.config.ts -newer dist-electron/main.cjs \
       -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

if needs_build; then
  npm run build >/dev/null
fi

exec env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE \
  ./node_modules/.bin/electron .
