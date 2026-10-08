#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/backend"

if [[ -z "${JWT_SECRET:-}" && -z "${SESSION_SECRET:-}" ]]; then
  echo "JWT_SECRET or SESSION_SECRET must be configured; refusing to start." >&2
  exit 1
fi
export JWT_SECRET="${JWT_SECRET:-${SESSION_SECRET:-}}"
exec python -m uvicorn server:app --host 0.0.0.0 --port "${PORT:-5000}"