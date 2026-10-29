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