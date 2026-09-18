#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/backend"

export JWT_SECRET="${JWT_SECRET:-${SESSION_SECRET:-dev-secret}}"
exec python -m uvicorn server:app --host 0.0.0.0 --port "${PORT:-5000}"