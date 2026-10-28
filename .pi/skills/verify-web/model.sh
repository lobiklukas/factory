#!/usr/bin/env bash
# Prove the New session form's model picker (LOB-274): the picker offers exactly the models the
# server serves (`getServerInfo.models`), with the deployment's default first; a session started on a
# picked model runs on it, and one started on the default runs the deployment's `DEFAULT_MODEL`.
#
# The models are deployment settings, so this script owns its own API and dashboard (its own ports,
# session root, logs and pid files), booted with `DEFAULT_MODEL=faux/faux-cheap` and
# `ROLE_MODELS=specifier=faux/faux-spec` — how a faux deployment serves three models with no key.
# The instance ./up.sh starts is not touched and nothing is left running.
#
#   ./model.sh
#   MODEL_API_PORT=9551 MODEL_WEB_PORT=3551 ./model.sh      # another port pair
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does.
# Evidence: .verify/evidence/latest/model/ — model-*.png, observed.json, api.log, web.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${MODEL_API_PORT:-9451}"
WEB_PORT="${MODEL_WEB_PORT:-3451}"
RUN_DIR="$ROOT/.verify/run/model"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/model"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set MODEL_API_PORT / MODEL_WEB_PORT to free ones" >&2
    exit 1
  fi
done

stop() { # name
  local pidfile="$RUN_DIR/$1.pid"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

cleanup() {
  stop web
  stop api
  cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/api.log" 2>/dev/null || true
  cp "$RUN_DIR/web.log" "$EVIDENCE_DIR/web.log" 2>/dev/null || true
  rm -rf "$RUN_DIR/sessions"
}
trap cleanup EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

rm -rf "$RUN_DIR/sessions"

( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    ALLOWED_ORIGINS="http://localhost:$WEB_PORT" \
    MODEL_BACKEND=faux \
    DEFAULT_MODEL=faux/faux-cheap \
    ROLE_MODELS=specifier=faux/faux-spec \
    FAUX_COMMAND="echo faux-ok" \
    SESSION_ROOT="$RUN_DIR/sessions" \
    SESSION_IDLE_TIMEOUT_MS=600000 \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

( cd "$ROOT/apps/web" && exec env \
    VITE_PORT="$WEB_PORT" \
    VITE_SERVER_URL="http://localhost:$API_PORT" \
    bun run dev ) > "$RUN_DIR/web.log" 2>&1 &
echo $! > "$RUN_DIR/web.pid"

ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1 &&
     curl -sf -m 1 "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "model: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" RUN_DIR="$RUN_DIR" \
  node "$ROOT/.pi/skills/verify-web/model.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "model: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "model: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
