#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_DATA_DIR="${MONGO_DATA_DIR:-$ROOT_DIR/.data/mongodb}"
mkdir -p "$MONGO_DATA_DIR"

export MONGO_URL="${MONGO_URL:-mongodb://127.0.0.1:27017}"
export DB_NAME="${DB_NAME:-biztranspay_dev}"
export JWT_SECRET="${JWT_SECRET:-${SESSION_SECRET:-dev-secret}}"

MONGO_STARTED_BY_SCRIPT=0
if ! pgrep -x mongod >/dev/null 2>&1; then
  mongod \
    --dbpath "$MONGO_DATA_DIR" \
    --bind_ip 127.0.0.1 \
    --port 27017 \
    --logpath "$MONGO_DATA_DIR/mongod.log" \
    --fork
  MONGO_STARTED_BY_SCRIPT=1
fi

BACKEND_PID=""
FRONTEND_PID=""
CLEANED_UP=0

cleanup() {
  if [[ "$CLEANED_UP" -eq 1 ]]; then
    return
  fi
  CLEANED_UP=1
  if [[ -n "$FRONTEND_PID" ]]; then
    pkill -TERM -P "$FRONTEND_PID" 2>/dev/null || true
    kill "$FRONTEND_PID" 2>/dev/null || true
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$BACKEND_PID" ]]; then
    pkill -TERM -P "$BACKEND_PID" 2>/dev/null || true
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ "$MONGO_STARTED_BY_SCRIPT" -eq 1 ]]; then
    mongod --dbpath "$MONGO_DATA_DIR" --shutdown >/dev/null 2>&1 || true
  fi
}

shutdown() {
  trap - EXIT INT TERM
  cleanup
  exit "${1:-0}"
}

trap cleanup EXIT
trap 'shutdown 130' INT
trap 'shutdown 143' TERM

# Older versions of this launcher could leave FastAPI orphaned after a
# workflow restart. Remove only this project's exact stale server command.
pkill -TERM -f '[u]vicorn server:app --host 0.0.0.0 --port 8000' 2>/dev/null || true
for _ in {1..20}; do
  if ! pgrep -f '[u]vicorn server:app --host 0.0.0.0 --port 8000' >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

(
  cd "$ROOT_DIR/backend"
  python -m uvicorn server:app --host 0.0.0.0 --port 8000
) &
BACKEND_PID=$!

for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:8000/api/v1/health >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "Backend stopped before becoming ready" >&2
    exit 1
  fi
  sleep 1
done

if ! curl -fsS http://127.0.0.1:8000/api/v1/health >/dev/null 2>&1; then
  echo "Backend did not become ready on port 8000" >&2
  exit 1
fi

cd "$ROOT_DIR/frontend"
export BROWSER=none
export PORT=5000
export REACT_APP_BACKEND_URL="${REACT_APP_BACKEND_URL:-}"
yarn start &
FRONTEND_PID=$!

set +e
wait -n "$BACKEND_PID" "$FRONTEND_PID"
EXIT_STATUS=$?
set -e

if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "Backend process exited unexpectedly" >&2
elif ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
  echo "Frontend process exited unexpectedly" >&2
fi

exit "$EXIT_STATUS"