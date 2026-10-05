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

# Postgres is the session log; without it nothing here is worth driving.
if ! (cd "$ROOT" && DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}" \
        docker compose up -d --wait postgres >/dev/null 2>&1); then
  echo "postgres is not up: docker compose up -d --wait postgres" >&2
  exit 1
fi

( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    HOST="127.0.0.1" \
    ALLOWED_ORIGINS="http://localhost:$API_PORT" \
    MODEL_BACKEND="${MODEL_BACKEND:-faux}" \
    SESSION_ROOT="$RUN_DIR/sessions" \
    SESSION_IDLE_TIMEOUT_MS="${SESSION_IDLE_TIMEOUT_MS:-2000}" \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://localhost:$API_PORT/" >/dev/null 2>&1; then
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
