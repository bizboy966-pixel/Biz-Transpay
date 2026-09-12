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

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ "$MONGO_STARTED_BY_SCRIPT" -eq 1 ]]; then
    mongod --dbpath "$MONGO_DATA_DIR" --shutdown >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

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
exec yarn start