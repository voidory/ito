#!/usr/bin/env bash
# Regression guard: run the PDF-anchor + reader-workbench e2e specs against the
# preview build with chrome-headless-shell, to confirm the rotation CSS did not
# disturb non-rotated highlight / anchor geometry.
set -u
LOG=/tmp/preview.log
npm run preview -- --port 4173 --host 127.0.0.1 >"$LOG" 2>&1 &
SRV_PID=$!
trap 'kill "$SRV_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:4173 >/dev/null 2>&1 && break
  sleep 1
done
PW_BASE_URL=http://127.0.0.1:4173 \
  npx playwright test --config=playwright.headless-shell.config.ts \
  e2e/pdf-anchor.spec.ts e2e/reader-workbench.spec.ts
EXIT=$?
echo "=== preview log tail ==="
tail -n 3 "$LOG"
exit $EXIT
