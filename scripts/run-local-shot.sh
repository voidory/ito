#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-5173}"
export TARGET_URL="${TARGET_URL:-http://127.0.0.1:${PORT}}"
export OUT_DIR="${OUT_DIR:-/projects/sandbox/.kiro/artifacts/screenshots}"

mkdir -p "$OUT_DIR"

# Start Vite in the same bwrap PID namespace
npx vite --host 127.0.0.1 --port "$PORT" --strictPort >/tmp/vite-shot.log 2>&1 &
VITE_PID=$!
trap 'kill -9 $VITE_PID 2>/dev/null || true' EXIT

# Poll until Vite responds with HTTP 200 (max ~15s)
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "$TARGET_URL" | grep -q "200"; then
    break
  fi
  sleep 0.5
done

# Run the multi-view headless-shell capture
node scripts/local-shot.mjs
