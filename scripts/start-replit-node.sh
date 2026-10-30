#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PID=""
FRONTEND_PID=""

terminate_tree() {
  local pid="$1"
  local child
  while IFS= read -r child; do
    [[ -n "$child" ]] && terminate_tree "$child"
  done < <(ps -o pid= --ppid "$pid" 2>/dev/null || true)
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  for pid in "$FRONTEND_PID" "$API_PID"; do
    if [[ -n "$pid" ]]; then
      terminate_tree "$pid"
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

API_HTTP_STATUS="000"
for _ in {1..40}; do
  API_HTTP_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 1 http://127.0.0.1:8000/healthz 2>/dev/null || true)"
  if [[ "$API_HTTP_STATUS" =~ ^[1-5][0-9][0-9]$ ]]; then
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "Node API stopped before becoming ready." >&2
    exit 1
  fi
  sleep 0.25
done
if [[ ! "$API_HTTP_STATUS" =~ ^[1-5][0-9][0-9]$ ]]; then
  echo "Node API did not become ready on port 8000." >&2
  exit 1
fi
if [[ "$API_HTTP_STATUS" == "503" ]]; then
  echo "Node API is running in diagnostic mode; database-backed operations remain blocked." >&2
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
