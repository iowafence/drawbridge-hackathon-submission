#!/usr/bin/env bash
# Starts the built app on 127.0.0.1 only, with the private server settings file (mode 600, outside the repository).
# Build first: npm run build
set -euo pipefail
ENV_FILE="${DRAWBRIDGE_SERVER_ENV:-$HOME/.config/drawbridge/sandbox-server.env}"
[ -f "$ENV_FILE" ] || { echo "missing settings file: $ENV_FILE" >&2; exit 2; }
[ "$(stat -c %a "$ENV_FILE")" = "600" ] || { echo "settings file must be mode 600: $ENV_FILE" >&2; exit 2; }
set -a
. "$ENV_FILE"
set +a
[ -n "${DRAWBRIDGE_OPERATOR_SCRYPT:-}" ] || { echo "DRAWBRIDGE_OPERATOR_SCRYPT is not set. Run: node scripts/operator-hash.mjs >> \"$ENV_FILE\"" >&2; exit 2; }
cd "$(dirname "$0")/.."
exec npx next start --hostname 127.0.0.1 --port "${DRAWBRIDGE_PORT:-3102}"
