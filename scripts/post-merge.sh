#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT_DIR/frontend/yarn.lock" ]]; then
  (
    cd "$ROOT_DIR/frontend"
    yarn install --frozen-lockfile --ignore-scripts --non-interactive
  )
else
  (
    cd "$ROOT_DIR/frontend"
    yarn install --ignore-scripts --non-interactive
  )
fi

node "$ROOT_DIR/scripts/patch-braces.cjs"

python -m pip install --break-system-packages --disable-pip-version-check --no-input \
  -r "$ROOT_DIR/backend/requirements.txt"

python -m compileall -q "$ROOT_DIR/backend"