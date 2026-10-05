#!/usr/bin/env bash
# Launch an isolated API for the CLI drive.
#
# `factory` is a client of the control plane, so the skill starts its own API: its own port, its own
# session working directories under .verify/run, and a pid recorded in .verify/run/api.pid so
# ./down.sh stops exactly this one.
#
# MODEL_BACKEND=faux keeps the drive offline and deterministic — the session still runs a real bash
# tool call, but the model is scripted. SESSION_IDLE_TIMEOUT_MS is short on purpose: the drive
# proves both read-path labels (docs/design.md D8) by watching a session while this process owns it,
# then again after the idle sweep has released it. The value is recorded in
# .verify/run/cli-idle-ms so drive.sh waits the window that was actually configured.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9300}"
IDLE_MS="${SESSION_IDLE_TIMEOUT_MS:-5000}"
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
    SESSION_IDLE_TIMEOUT_MS="$IDLE_MS" \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"
echo "$IDLE_MS" > "$RUN_DIR/cli-idle-ms"

# Ready means `/readyz` says so, not merely that the port answers: the server binds before its
# migrations are applied (LOB-21), so `GET /` is true a moment before a session can be created.
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
echo "model backend: ${MODEL_BACKEND:-faux}; session idle timeout: ${IDLE_MS}ms"
