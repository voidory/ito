#!/usr/bin/env bash
# Run the rotated-selection e2e spec against the production preview build using
# the sandbox-resident chrome-headless-shell (full Chromium is unavailable).
set -u
LOG=/tmp/preview.log
npm run preview -- --port 4173 --host 127.0.0.1 >"$LOG" 2>&1 &
SRV_PID=$!
trap 'kill "$SRV_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:4173 >/dev/null 2>&1 && break
  sleep 1
done
PW_CHROMIUM_BIN=/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell \
  PW_BASE_URL=http://127.0.0.1:4173 \
  npx playwright test --config=playwright.headless-shell.config.ts e2e/selection.spec.ts
EXIT=$?
echo "=== preview log tail ==="
tail -n 3 "$LOG"
exit $EXIT
