#!/bin/bash
# Persistent launcher for the metrics mini-service.
# Writes a PID file and detaches fully from the controlling terminal.

SERVICE_DIR="/home/z/my-project/mini-services/metrics-service"
LOG_FILE="/home/z/my-project/.zscripts/mini-service-metrics-service.log"
PID_FILE="/home/z/my-project/.zscripts/mini-service-metrics-service.pid"

cd "$SERVICE_DIR"

# Kill any existing instance.
if [ -f "$PID_FILE" ]; then
  old_pid=$(cat "$PID_FILE")
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" 2>/dev/null || true
    sleep 1
  fi
fi

# Start the service with setsid so it survives the parent shell exiting.
# Redirect all I/O to the log file.
setsid bash -c "cd '$SERVICE_DIR' && exec bun run dev" >"$LOG_FILE" 2>&1 &
PID=$!
disown $PID 2>/dev/null || true
echo $PID > "$PID_FILE"

# Give it a moment to start.
sleep 3

# Verify.
if curl -s -m 3 "http://localhost:3003/socket.io/?EIO=4&transport=polling" >/dev/null 2>&1; then
  echo "[start-metrics] OK — service responding on port 3003 (PID $PID)"
  exit 0
else
  echo "[start-metrics] FAIL — service did not respond"
  tail -20 "$LOG_FILE"
  exit 1
fi
