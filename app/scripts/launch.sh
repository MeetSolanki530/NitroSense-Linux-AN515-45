#!/usr/bin/env bash
#
# Launches the app from this source tree, for the desktop entry and the
# NitroSense key shortcut to call.
#
# THE ENVIRONMENT IS NOT YOURS
#   A desktop shortcut runs with a minimal environment: no nvm, a bare PATH,
#   and nowhere to print an error. Two things in here need node, and both used
#   to die at exit 127 before Electron ever started, silently:
#
#     - `npm run build`
#     - node_modules/.bin/electron, which is NOT a binary but a JavaScript
#       wrapper with a `#!/usr/bin/env node` shebang
#
#   So this finds node itself, and prefers the real Electron ELF binary over
#   the wrapper, which removes the node dependency from the launch path
#   entirely when no rebuild is needed.
#
#   It also builds only when sources are newer than the build output, so a
#   normal launch is instant rather than a ten-second rebuild.
#
#   VS Code's Flatpak exports ELECTRON_RUN_AS_NODE=1, which makes Electron
#   behave as plain node and exit without a window; cleared below.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

LOG="$APP_DIR/logs/launch.log"
mkdir -p "$(dirname "$LOG")"
# A shortcut has no terminal, so leave a trail for when it fails.
exec 2> >(tee -a "$LOG" >&2)
echo "--- $(date '+%F %T') launch, PATH=$PATH" >> "$LOG"

# ---------------------------------------------------------------- find node
if ! command -v node >/dev/null 2>&1; then
  # Newest nvm install first; plain shell glob sorts lexically, so reverse it.
  for dir in $(printf '%s\n' "$HOME/.nvm/versions/node"/*/bin | sort -rV) \
             /usr/local/bin /usr/bin /snap/bin; do
    if [ -x "$dir/node" ]; then
      PATH="$dir:$PATH"
      export PATH
      echo "  found node in $dir" >> "$LOG"
      break
    fi
  done
fi

# ---------------------------------------------------------------- build
needs_build() {
  [ ! -f dist/index.html ] && return 0
  [ ! -f dist-electron/main.cjs ] && return 0
  if find electron src index.html vite.config.ts -newer dist-electron/main.cjs \
       -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

if needs_build; then
  if command -v npm >/dev/null 2>&1; then
    echo "  rebuilding" >> "$LOG"
    npm run build >>"$LOG" 2>&1 || echo "  build FAILED, launching last build" >> "$LOG"
  else
    # Better a slightly stale window than no window: the previous build is
    # still on disk and perfectly runnable.
    echo "  npm not found; launching the existing build" >> "$LOG"
  fi
fi

# ---------------------------------------------------------------- launch
# The real binary, not the .bin wrapper, so this works without node present.
ELECTRON="$APP_DIR/node_modules/electron/dist/electron"
[ -x "$ELECTRON" ] || ELECTRON="$APP_DIR/node_modules/.bin/electron"

if [ ! -x "$ELECTRON" ]; then
  echo "  no electron binary found; run: npm install" >> "$LOG"
  exit 1
fi

echo "  exec $ELECTRON" >> "$LOG"
exec env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE "$ELECTRON" "$APP_DIR"
