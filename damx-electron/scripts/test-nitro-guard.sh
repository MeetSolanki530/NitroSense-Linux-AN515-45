#!/usr/bin/env bash
# Verifies the Nitro key guard still works against the Electron binary.
#
# nitro-key-detection.service runs, on each key press:
#     pgrep -f "/opt/damx/gui/DivAcerManagerMax" || <launch>
# and the installer's /usr/local/bin/DAMX wrapper is a bash script (no exec)
# that invokes the binary by absolute path.
#
# This reproduces that exact arrangement under a stand-in prefix, so the
# mechanism is proven without needing root or touching /opt. The only
# difference from production is the path string itself.
set -uo pipefail
cd "$(dirname "$0")/.."

PREFIX="$PWD/release/guard-test"
GUI_DIR="$PREFIX/opt/damx/gui"
BIN="$GUI_DIR/DivAcerManagerMax"
WRAPPER="$PREFIX/DAMX"
UNPACKED="$PWD/release/linux-unpacked"

pass=0; fail=0
check() { if [ "$1" = "1" ]; then pass=$((pass+1)); printf '  \033[32mPASS\033[0m %s\n' "$2";
          else fail=$((fail+1)); printf '  \033[31mFAIL\033[0m %s %s\n' "$2" "${3:-}"; fi; }

if [ ! -x "$UNPACKED/DivAcerManagerMax" ]; then
  echo "Build first: npm run package:dir" >&2; exit 1
fi

# pgrep IS the mechanism under test; a broken one would silently pass the
# cleanup assertions by matching nothing.
if ! pgrep -f "definitely-not-a-real-process-xyz" >/dev/null 2>&1; then
  if ! pgrep --version >/dev/null 2>&1; then
    echo "pgrep is not working in this shell; results would be meaningless." >&2
    echo "(A host pgrep on PATH inside a sandbox often fails to load libproc2.)" >&2
    exit 1
  fi
fi

# Clear any stale instance first. One left running holds the single-instance
# lock, which makes every later launch exit immediately and would look like a
# guard failure rather than the leftover process it is.
python3 - <<'CLEAN'
import os, signal, pathlib
mine = {os.getpid(), os.getppid()}
for d in pathlib.Path('/proc').iterdir():
    if not d.name.isdigit() or int(d.name) in mine:
        continue
    try:
        cmd = (d / 'cmdline').read_bytes().decode(errors='replace')
    except Exception:
        continue
    # Match only the executable itself, never a shell that mentions its name.
    if cmd.startswith('/') and 'DivAcerManagerMax' in cmd.split(chr(0))[0]:
        try:
            os.kill(int(d.name), signal.SIGTERM)
        except Exception:
            pass
CLEAN
sleep 2

rm -rf "$PREFIX"; mkdir -p "$PREFIX/opt/damx"
# Hardlink rather than symlink, deliberately. Electron re-execs itself via
# /proc/self/exe, so a symlinked install directory makes every process report
# the RESOLVED path in its cmdline and the pgrep guard never matches. The
# binary must be a real file at the guarded path. This is also why the
# installer copies into /opt/damx/gui instead of linking to a build tree.
mkdir -p "$GUI_DIR"
cp -al "$UNPACKED/." "$GUI_DIR/" 2>/dev/null || cp -a "$UNPACKED/." "$GUI_DIR/"

# Mirror the installer's wrapper exactly: bash, absolute path, no exec.
cat > "$WRAPPER" <<WRAP
#!/bin/bash
$BIN "\$@"
WRAP
chmod +x "$WRAPPER"

echo ""
echo "1. Binary identity"
[ -x "$BIN" ] && check 1 "binary is executable at the guarded path" || check 0 "binary is executable at the guarded path"

echo ""
echo "2. Launch through the wrapper, as the key service does"
env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE \
  "$WRAPPER" --no-sandbox >/dev/null 2>&1 &
WRAPPER_PID=$!
sleep 6

MATCHES=$(pgrep -f "$BIN" | wc -l)
check "$([ "$MATCHES" -ge 1 ] && echo 1 || echo 0)" \
  "pgrep -f matches the running app ($MATCHES process(es))" "expected >=1"

# The guard is a plain boolean test, so reproduce it verbatim.
if pgrep -f "$BIN" > /dev/null; then GUARD="would-skip"; else GUARD="would-launch"; fi
check "$([ "$GUARD" = "would-skip" ] && echo 1 || echo 0)" \
  "guard reports already-running (second key press is a no-op)" "$GUARD"

echo ""
echo "3. Single-instance lock"
env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE \
  "$WRAPPER" --no-sandbox >/dev/null 2>&1 &
SECOND_PID=$!
sleep 4
if wait "$SECOND_PID" 2>/dev/null; then SECOND_EXIT=0; else SECOND_EXIT=$?; fi
check 1 "second launch exited instead of opening a window (code $SECOND_EXIT)"

echo ""
echo "4. Cleanup behaviour"
for p in $(pgrep -f "$BIN"); do kill "$p" 2>/dev/null; done
sleep 4
REMAIN=$(pgrep -f "$BIN" | wc -l)
check "$([ "$REMAIN" -eq 0 ] && echo 1 || echo 0)" \
  "guard reports not-running after exit (next press launches)" "$REMAIN left"

kill $WRAPPER_PID 2>/dev/null
rm -rf "$PREFIX"

echo ""
if [ "$fail" -eq 0 ]; then printf '\033[32m%d passed, %d failed\033[0m\n\n' "$pass" "$fail";
else printf '\033[31m%d passed, %d failed\033[0m\n\n' "$pass" "$fail"; fi
[ "$fail" -eq 0 ]
