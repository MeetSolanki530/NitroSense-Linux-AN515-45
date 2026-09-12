#!/usr/bin/env bash
# Renders the shell offscreen and captures a PNG, so a change can be checked
# without a human watching a window.
#
#     ./scripts/smoke.sh [output.png]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-/tmp/damx-shell.png}"
npm run build >/dev/null

# VS Code sets ELECTRON_RUN_AS_NODE=1 for its extension host; with it set,
# Electron runs as plain Node and require('electron') yields a path string
# instead of the API. Clear it so this works from any terminal.
env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE \
  npx electron . --no-sandbox "--smoke-out=$OUT"

echo "captured: $OUT"
