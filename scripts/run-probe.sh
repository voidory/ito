#!/usr/bin/env bash
# Single-call harness: boot the dev build, run the rotated-selection probe,
# tear the server down. Kept in a script so the orchestration lives in one
# execute_bash invocation (background processes do not survive across calls).
set -u

LOG=/tmp/vite.log
npx vite --port 5173 --host 127.0.0.1 >"$LOG" 2>&1 &
SRV_PID=$!
cleanup() { kill "$SRV_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "Waiting for dev server..."
UP=0
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:5173 >/dev/null 2>&1; then
    echo "Server up after ${i}s"
    UP=1
    break
  fi
  sleep 1
done

if [ "$UP" -ne 1 ]; then
  echo "Server did not come up; log tail:"
  tail -n 20 "$LOG"
  exit 1
fi

TARGET_URL=http://127.0.0.1:5173 node scripts/rotated-selection-probe.mjs
EXIT=$?
echo "=== dev server log tail ==="
tail -n 5 "$LOG"
exit $EXIT
