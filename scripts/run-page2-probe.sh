#!/usr/bin/env bash
# Single-call harness: boot the dev server, run the page-2 scroll/zoom probe,
# tear the server down.
set -u
LOG=/tmp/vite.log
npx vite --port 5173 --host 127.0.0.1 >"$LOG" 2>&1 &
SRV_PID=$!
trap 'kill "$SRV_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:5173 >/dev/null 2>&1 && break
  sleep 1
done
TARGET_URL=http://127.0.0.1:5173 \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell \
  node scripts/rotated-page2-probe.mjs
EXIT=$?
echo "=== vite log tail ==="
tail -n 4 "$LOG"
exit $EXIT
