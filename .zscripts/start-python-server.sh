#!/bin/bash
# Persistent launcher for the ColabGPU Python Flask server.
# Kills any existing instance on port 3000, then starts a fresh one.

set -e
APP_DIR="/home/z/my-project/pyapp"
LOG_FILE="$APP_DIR/server.log"
PID_FILE="$APP_DIR/server.pid"

cd "$APP_DIR"

# Kill any existing instance.
if [ -f "$PID_FILE" ]; then
  old_pid=$(cat "$PID_FILE")
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" 2>/dev/null || true
    sleep 1
  fi
fi
# Also kill any orphaned python app.py processes.
pkill -f "python3 app.py" 2>/dev/null || true
sleep 1

# Start fresh. nohup + disown so the process survives shell exit.
nohup python3 app.py > "$LOG_FILE" 2>&1 &
PID=$!
disown $PID 2>/dev/null || true
echo $PID > "$PID_FILE"

# Wait for it to come up.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null -m 2 "http://localhost:3000/" 2>/dev/null; then
    echo "[start-server] OK — Python server on port 3000 (PID $PID)"
    exit 0
  fi
  sleep 1
done

echo "[start-server] FAIL — server did not respond"
tail -30 "$LOG_FILE"
exit 1
