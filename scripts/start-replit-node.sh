#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PID=""
FRONTEND_PID=""

cleanup() {
  for pid in "$FRONTEND_PID" "$API_PID"; do
    if [[ -n "$pid" ]]; then
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
shutdown() {
  trap - EXIT INT TERM
  cleanup
  exit "${1:-0}"
}
trap cleanup EXIT
trap 'shutdown 130' INT
trap 'shutdown 143' TERM

export BIZTRANSPAY_MIGRATION_ENV=preview
export PORT=8000
export JWT_SECRET="${JWT_SECRET:-${SESSION_SECRET:-}}"

node "$ROOT_DIR/backend-node/app.js" &
API_PID=$!

for _ in {1..40}; do
  if curl -fsS http://127.0.0.1:8000/healthz >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "Node API stopped before becoming ready." >&2
    exit 1
  fi
  sleep 0.25
done
if ! curl -fsS http://127.0.0.1:8000/healthz >/dev/null 2>&1; then
  echo "Node API did not become ready on port 8000." >&2
  exit 1
fi

cd "$ROOT_DIR/frontend"
export BROWSER=none
export PORT=5000
export REACT_APP_BACKEND_URL=""
yarn start &
FRONTEND_PID=$!

set +e
wait -n "$API_PID" "$FRONTEND_PID"
EXIT_STATUS=$?
set -e
exit "$EXIT_STATUS"
