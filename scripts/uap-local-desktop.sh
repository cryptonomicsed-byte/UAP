#!/bin/bash
# Keep the three local agent displays and their VNC ports up. Localhost only.
set -u
mkdir -p /opt/hq/logs
start_one() {
  local n="$1" port="$2"
  if ! xdpyinfo -display ":$n" >/dev/null 2>&1; then
    Xvfb ":$n" -screen 0 1280x800x24 -ac -nolisten tcp >>"/opt/hq/logs/xvfb-$n.log" 2>&1 &
    sleep 0.4
  fi
  if ! timeout 1 bash -c "echo >/dev/tcp/127.0.0.1/$port" 2>/dev/null; then
    x11vnc -display ":$n" -rfbport "$port" -localhost -nopw -shared -forever -noxdamage -wait 100 -defer 30 >>"/opt/hq/logs/x11vnc-$n.log" 2>&1 &
  fi
}
while true; do
  start_one 99 5999
  start_one 100 6000
  start_one 101 6001
  sleep 15
done
