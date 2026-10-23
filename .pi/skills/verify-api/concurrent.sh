#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${CONCURRENT_PORT:-9400}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/concurrent"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
DRIVER="$ROOT/.pi/skills/verify-api/concurrent.ts"
LOG="$RUN_DIR/api.log"
mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"
source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1
( cd "$ROOT/apps/api" && exec env PORT="$PORT" HOST="127.0.0.1" MODEL_BACKEND=faux SESSION_ROOT="$RUN_DIR/sessions" bun run src/index.ts ) >> "$LOG" 2>&1 &
echo $! > "$RUN_DIR/api.pid"
PID="$(cat "$RUN_DIR/api.pid")"
for _ in $(seq 1 60); do curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && break; sleep 0.5; done
MODE=verify API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" bun "$DRIVER"
RC=$?
kill "$PID" 2>/dev/null || true
exit "$RC"
