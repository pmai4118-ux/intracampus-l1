#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 24 is required; see the repository README.' >&2
  exit 1
fi
exec node "$SCRIPT_DIR/smoke-rpc.mjs" "$@"
