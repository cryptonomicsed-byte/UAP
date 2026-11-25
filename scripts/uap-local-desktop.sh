#!/bin/bash
# Banner-gated local desktops. A listening port is not a screen.
set -u
mkdir -p /opt/hq/logs

banner_ok() {
  local port="$1"
  python3 - "$port" << 'PY'
import socket, sys
port = int(sys.argv[1])
s = socket.socket()
s.settimeout(1.5)
try:
    s.connect(("127.0.0.1", port))
    data = s.recv(12)
except Exception:
    data = b""
finally:
    s.close()
sys.exit(0 if data.startswith(b"RFB ") else 1)
PY
}

start_one() {
  local n="$1" port="$2"
  if ! xdpyinfo -display ":$n" >/dev/null 2>&1; then
    Xvfb ":$n" -screen 0 1280x800x24 -ac -nolisten tcp >>"/opt/hq/logs/xvfb-$n.log" 2>&1 &
    sleep 0.4
  fi
  if ! banner_ok "$port"; then
    # A wedged x11vnc accepts TCP and never sends RFB. Kill only this port.
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${port}/tcp" >/dev/null 2>&1 || true
    fi
    sleep 0.2
    x11vnc -display ":$n" -rfbport "$port" -localhost -nopw -shared -forever -wait 100 -defer 30 -noxrecord >>"/opt/hq/logs/x11vnc-$n.log" 2>&1 &
    sleep 0.6
  fi
}

while true; do
  start_one 99 5999
  start_one 100 6000
  start_one 101 6001
  sleep 15
done
