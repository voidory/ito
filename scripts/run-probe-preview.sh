#!/usr/bin/env bash
# Same geometry probe, but against the production preview build (port 4173) to
# confirm the fix holds in the built bundle, not just the dev server.
set -u
LOG=/tmp/preview.log
npm run preview -- --port 4173 --host 127.0.0.1 >"$LOG" 2>&1 &
SRV_PID=$!
trap 'kill "$SRV_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:4173 >/dev/null 2>&1 && break
  sleep 1
done
TARGET_URL=http://127.0.0.1:4173 node scripts/rotated-selection-probe.mjs
