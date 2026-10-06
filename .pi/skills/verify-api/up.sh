#!/usr/bin/env bash
# Launch an isolated API instance to drive the session RPC surface against.
#
# Isolation: its own port, its own session working directories under .verify/run,
# and pids recorded in .verify/run/api.pid so ./down.sh can stop exactly this one.
#
# MODEL_BACKEND=faux keeps verification offline and deterministic (pi-ai's scripted
# provider): no API key, no cost, same transcript every run. SESSION_IDLE_TIMEOUT_MS is
# short on purpose so a drive run can reach the historical-fold read path without
# waiting the 15 minutes a real deployment uses — see features/session-fold.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
RUN_DIR="$ROOT/.verify/run"

mkdir -p "$RUN_DIR"

if [ -f "$RUN_DIR/api.pid" ] && kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null; then
  echo "already running (api pid $(cat "$RUN_DIR/api.pid")); run ./down.sh first" >&2
  exit 1
fi

# Postgres is the session log; without it nothing here is worth driving. The shared check asks the
# port before it asks compose, so this works from a ralph worktree where compose would derive its
# own project name and fight the human's container for 5442 (LOB-57).
source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    HOST="127.0.0.1" \
    ALLOWED_ORIGINS="http://localhost:$API_PORT" \
    MODEL_BACKEND="${MODEL_BACKEND:-faux}" \
    SESSION_ROOT="$RUN_DIR/sessions" \
    SESSION_IDLE_TIMEOUT_MS="${SESSION_IDLE_TIMEOUT_MS:-2000}" \
    MAX_REQUEST_BODY_BYTES="${MAX_REQUEST_BODY_BYTES:-1048576}" \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

# Ready means `/readyz` says so, not merely that the port answers: the server binds before its
# migrations are applied (LOB-21), so `GET /` is true a moment before a session can be created. The
# body cap is explicit (the default is the same 1 MiB) so drive.ts's 413 check is tied to a value
# this script sets rather than to a default that could drift.
ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "api did not become ready in 30s — see $RUN_DIR/api.log" >&2
  exit 1
fi

echo "api  http://localhost:$API_PORT  (pid $(cat "$RUN_DIR/api.pid"))"
echo "model backend: ${MODEL_BACKEND:-faux}"
