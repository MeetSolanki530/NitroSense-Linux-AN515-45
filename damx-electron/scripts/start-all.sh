#!/usr/bin/env bash
#
# One command to bring the whole stack up: kernel driver, daemon, and app.
#
#   ./scripts/start-all.sh              driver (nitro_v4) + daemon + app
#   ./scripts/start-all.sh --dev        same, but with hot reload
#   ./scripts/start-all.sh --enable-all load the driver with enable_all
#   ./scripts/start-all.sh --no-driver  skip the driver step
#
# Run it as YOUR user, not with sudo. It asks for the sudo password once and
# uses it only for the driver and the daemon; the app itself runs as you,
# because an Electron app running as root writes root-owned config into your
# home directory.
#
# Ctrl-C stops the daemon and the app together. The driver is left loaded (it
# is cheap to keep, and holds no persistent state); remove it with
#     sudo ./scripts/try-driver.sh --undo
#
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT="$PWD"
DAEMON_SRC="$PROJECT/../DAMM-Daemon/DAMX-Daemon.py"
SOCK="/var/run/DAMX.sock"
LOG="/tmp/damx-daemon.log"
PIDFILE="/tmp/damx-daemon.pid"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

APP_CMD="start"
DRIVER_ARGS=()
LOAD_DRIVER=1

for arg in "$@"; do
  case "$arg" in
    --dev)         APP_CMD="dev" ;;
    --enable-all)  DRIVER_ARGS=(--enable-all) ;;
    --no-driver)   LOAD_DRIVER=0 ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *) red "Unknown option: $arg"; exit 1 ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  red "Do not run this with sudo."
  echo "  It elevates only the parts that need it, so the app stays as your user."
  exit 1
fi

# ---------------------------------------------------------------- cleanup
cleanup() {
  echo ""
  step "Shutting down"
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && sudo kill -0 "$pid" 2>/dev/null; then
      sudo kill "$pid" 2>/dev/null || true
      dim "  daemon stopped"
    fi
    sudo rm -f "$PIDFILE"
  fi
  sudo rm -f "$SOCK" 2>/dev/null || true
  dim "  socket removed"
  dim "  driver left loaded — remove with: sudo ./scripts/try-driver.sh --undo"
  echo ""
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- sudo once
step "Authorising"
dim "  Needed for the kernel driver and the daemon only."
sudo -v
# Keep the sudo timestamp warm while the app runs.
( while true; do sudo -n true 2>/dev/null; sleep 50; done ) &
SUDO_KEEPALIVE=$!
trap 'kill $SUDO_KEEPALIVE 2>/dev/null || true; cleanup' EXIT INT TERM

# ---------------------------------------------------------------- driver
if [ "$LOAD_DRIVER" -eq 1 ]; then
  step "1/3  Kernel driver"
  WANT="nitro_v4"
  [ "${DRIVER_ARGS[0]:-}" = "--enable-all" ] && WANT="enable_all"

  CURRENT=""
  if [ -d /sys/module/linuwu_sense ]; then
    for prm in enable_all nitro_v4 predator_v4; do
      [ "$(cat "/sys/module/linuwu_sense/parameters/$prm" 2>/dev/null)" = "Y" ] \
        && CURRENT="$CURRENT $prm"
    done
  fi

  if echo "$CURRENT" | grep -qw "$WANT"; then
    green "  Already loaded with $WANT — nothing to do."
  else
    dim "  Loading with $WANT…"
    sudo "$PROJECT/scripts/try-driver.sh" "${DRIVER_ARGS[@]}" | sed 's/^/  /'
  fi
else
  step "1/3  Kernel driver (skipped)"
fi

# ---------------------------------------------------------------- daemon
step "2/3  Daemon"
if [ ! -f "$DAEMON_SRC" ]; then
  red "  Daemon source not found at $DAEMON_SRC"
  exit 1
fi

# Clear a stale socket from a previous run so the new daemon can bind.
[ -S "$SOCK" ] && sudo rm -f "$SOCK"

sudo bash -c "cd '$(dirname "$DAEMON_SRC")' && python3 '$DAEMON_SRC' --verbose > '$LOG' 2>&1 & echo \$! > '$PIDFILE'"

for _ in $(seq 1 30); do
  [ -S "$SOCK" ] && break
  sleep 0.25
done

if [ ! -S "$SOCK" ]; then
  red "  Daemon did not create $SOCK"
  echo "  Last lines of $LOG:"
  sudo tail -20 "$LOG" 2>/dev/null | sed 's/^/    /'
  exit 1
fi

green "  Running (pid $(cat "$PIDFILE"))"
dim "  log: $LOG   — follow it with:  tail -f $LOG"

# Report what the daemon actually found, so a broken feature is visible here
# rather than only inside the UI.
sudo grep -E "Detected laptop type|Four-zone keyboard|Available features" "$LOG" 2>/dev/null \
  | sed 's/.*INFO - /  /' || true

# ---------------------------------------------------------------- app
step "3/3  App"
dim "  npm run $APP_CMD — Ctrl-C here stops everything."
echo ""
npm run "$APP_CMD"
