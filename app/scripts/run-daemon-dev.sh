#!/usr/bin/env bash
#
# Runs the hardware service straight from source, in the foreground, for
# testing the app against a real service.
#
# This INSTALLS NOTHING. No systemd unit, no files under /opt, no driver
# changes. It starts the service, it creates /var/run/nitrosense.sock, and
# Ctrl-C stops it and removes the socket.
#
# The service is pure Python stdlib, so there is nothing to pip install.
#
# Note: without the linuwu_sense kernel driver loaded, the service starts but
# reports few or no features — it has nothing to control. That is expected,
# and is itself a useful test: the app should connect and show each feature
# as unavailable rather than pretending it works.
#
#     sudo ./scripts/run-daemon-dev.sh
#
set -euo pipefail

DAEMON_DIR="$(cd "$(dirname "$0")/../../service" 2>/dev/null && pwd || true)"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  red "The daemon must run as root (it writes to sysfs and /var/run)."
  echo "  sudo $0"
  exit 1
fi

if [ -z "$DAEMON_DIR" ] || [ ! -f "$DAEMON_DIR/nitrosense-daemon.py" ]; then
  red "Could not find service/nitrosense-daemon.py next to this project."
  echo "  Expected at: $(cd "$(dirname "$0")/../.." && pwd)/service"
  exit 1
fi

if [ -S /var/run/nitrosense.sock ]; then
  warn "/var/run/nitrosense.sock already exists — one may already be running."
  warn "Starting anyway will replace it."
  echo ""
fi

echo ""
green "Starting the hardware service from source (nothing is installed)"
dim "  source: $DAEMON_DIR/nitrosense-daemon.py"
dim "  socket: /var/run/nitrosense.sock"
echo ""

if [ ! -d /sys/module/linuwu_sense ]; then
  warn "linuwu_sense is not loaded, so the service will report few or no"
  warn "features. The app should connect and show controls as unavailable."
  echo ""
fi

dim "Ctrl-C to stop. Leave this terminal open and start the app in another:"
dim "    cd $(cd "$(dirname "$0")/.." && pwd) && npm start"
echo ""

cleanup() {
  echo ""
  dim "Stopping; removing /var/run/nitrosense.sock"
  rm -f /var/run/nitrosense.sock
}
trap cleanup EXIT INT TERM

cd "$DAEMON_DIR"
exec python3 nitrosense-daemon.py --verbose
