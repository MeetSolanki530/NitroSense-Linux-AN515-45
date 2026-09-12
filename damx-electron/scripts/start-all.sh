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
# Logs live inside the project rather than /tmp so they can be read from a
# sandboxed editor session, which cannot see the host's /tmp or /var/run.
LOGDIR="$PROJECT/logs"
LOG="$LOGDIR/daemon.log"
APPLOG="$LOGDIR/app.log"
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
# Only tear down what THIS run started. Exiting early (bad option, no sudo)
# must not touch a daemon someone started from another terminal, and must not
# call sudo when sudo is why we are exiting.
DAEMON_STARTED=0

cleanup() {
  [ "$DAEMON_STARTED" -eq 1 ] || return 0
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
  # Ours to remove, since we started the daemon that created it.
  sudo rm -f "$SOCK" 2>/dev/null || true
  dim "  socket removed"
  dim "  driver left loaded — remove with: sudo ./scripts/try-driver.sh --undo"
  echo ""
}
trap cleanup EXIT INT TERM

mkdir -p "$LOGDIR"
: > "$APPLOG"

# ---------------------------------------------------------------- sudo once
step "Authorising"
if ! command -v sudo >/dev/null 2>&1; then
  red "  sudo is not available in this environment."
  echo ""
  echo "  The driver and daemon need root, so this script cannot run here."
  echo "  A sandboxed shell (Flatpak/snap, e.g. a Flatpak VS Code terminal)"
  echo "  has no sudo and cannot see the host's /var/run or the daemon socket."
  echo ""
  echo "  Run it from a normal terminal instead. The app alone, without"
  echo "  hardware controls, still works anywhere:"
  echo "      npm run dev"
  exit 1
fi
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

# A daemon may already be running from another terminal. Starting a second one
# would unlink that daemon's socket and leave it orphaned, so reuse it instead.
# The script's own command line does not contain the daemon filename, so this
# pgrep cannot match the script itself.
EXISTING="$(pgrep -f 'DAMX-Daemon\.py' || true)"
if [ -n "$EXISTING" ]; then
  warn "  A daemon is already running (pid $(echo "$EXISTING" | head -1)) — reusing it."
  dim "  Its log is wherever that terminal was pointed, not logs/daemon.log."
  if [ ! -S "$SOCK" ]; then
    red "  But $SOCK does not exist, so it is not serving. Stop it and re-run."
    exit 1
  fi
else
  # Only remove a socket when no daemon is alive to own it: a leftover file
  # from an unclean exit would otherwise block the bind.
  [ -S "$SOCK" ] && sudo rm -f "$SOCK"

  sudo bash -c "cd '$(dirname "$DAEMON_SRC")' && python3 '$DAEMON_SRC' --verbose > '$LOG' 2>&1 & echo \$! > '$PIDFILE'"
  DAEMON_STARTED=1
  # The daemon runs as root, so its log lands root-owned; make it readable.
  sleep 0.5
  sudo chmod 644 "$LOG" 2>/dev/null || true

  for _ in $(seq 1 30); do
    [ -S "$SOCK" ] && break
    sleep 0.25
  done
fi

if [ ! -S "$SOCK" ]; then
  red "  Daemon did not create $SOCK"
  echo "  Last lines of $LOG:"
  sudo tail -20 "$LOG" 2>/dev/null | sed 's/^/    /'
  exit 1
fi

if [ "$DAEMON_STARTED" -eq 1 ]; then
  green "  Running (pid $(cat "$PIDFILE" 2>/dev/null || echo '?'))"
  dim "  log: logs/daemon.log   — follow with:  tail -f logs/daemon.log"

  # Report what the daemon actually found, so a missing feature is visible
  # here rather than only inside the UI.
  sudo grep -E "Detected laptop type|Four-zone keyboard|Available features" "$LOG" 2>/dev/null \
    | sed 's/.*INFO - /  /' || true
else
  green "  Using the daemon that was already running."
fi

# ---------------------------------------------------------------- app
step "3/3  App"
dim "  npm run $APP_CMD — Ctrl-C here stops everything."
dim "  logs: logs/daemon.log and logs/app.log"
echo ""
npm run "$APP_CMD" 2>&1 | tee "$APPLOG"
