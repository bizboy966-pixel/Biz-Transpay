#!/usr/bin/env bash
set -euo pipefail

echo "Biz-transPay production startup is blocked: the Node.js migration is not yet complete or validated." >&2
echo "Do not deploy until route parity, isolated MySQL checks, and financial regressions pass." >&2
exit 1
