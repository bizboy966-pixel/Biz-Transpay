#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${MONGO_URL:?MONGO_URL must be configured by Emergent}"
: "${DB_NAME:?DB_NAME must be configured by Emergent}"
: "${JWT_SECRET:=${SESSION_SECRET:-}}"
: "${JWT_SECRET:?JWT_SECRET or SESSION_SECRET must be configured by Emergent}"

export JWT_SECRET
export PORT="${PORT:-8001}"

cd "$ROOT_DIR/backend"
exec python -m uvicorn server:app \
  --host 0.0.0.0 \
  --port "$PORT" \
  --proxy-headers \
  --forwarded-allow-ips="${FORWARDED_ALLOW_IPS:-*}"