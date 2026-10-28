#!/usr/bin/env bash
# Prove what the dashboard does with a session pinned to a model the server no longer serves (E9).
#
# A session's model is pinned into its log when it first opens. When the API restarts on a catalog
# that no longer holds that model, a send to it used to fail inside pi-ai with an untyped
# `Unknown provider`. Now it is refused as `model_unavailable` naming the model, `getSession` and
# `listSessions` report `modelAvailable: false`, and the pane disables the composer, says why, and
# offers "Replay on <default model>", which creates a replay and navigates to it.
#
# The catalog change is a restart, so this script owns two boots of one API over one session root and
# one database (its own ports, logs and pid files; the instance ./up.sh starts is not touched):
#   1. `DEFAULT_MODEL=faux/faux-cheap`: a repo-bound session is created on faux-cheap and runs once,
#      and a control session is created on faux-1.
#   2. no DEFAULT_MODEL: the backend serves faux-1 alone, so faux-cheap is no longer served.
# Faux, not anthropic, for the browser drive: a replay onto anthropic would call api.anthropic.com.
# The real faux -> anthropic switch is a core test (`SessionService.test.ts`, E9).
#
#   ./model-unavailable.sh
#   MODELGONE_API_PORT=9582 MODELGONE_WEB_PORT=3582 ./model-unavailable.sh
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does.
# Evidence: .verify/evidence/latest/model-unavailable/ — *.png, observed.json, api-*.log, web.log.
set -uo pipefail

unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${MODELGONE_API_PORT:-9453}"
WEB_PORT="${MODELGONE_WEB_PORT:-3453}"
RUN_DIR="$ROOT/.verify/run/model-unavailable"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/model-unavailable"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set MODELGONE_API_PORT / MODELGONE_WEB_PORT to free ones" >&2
    exit 1
  fi
done

stop() { # name
  local pidfile="$RUN_DIR/$1.pid"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

cleanup() {
  stop web
  stop api
  cp "$RUN_DIR/web.log" "$EVIDENCE_DIR/web.log" 2>/dev/null || true
  rm -rf "$RUN_DIR/sessions" "$RUN_DIR/checkout"
}
trap cleanup EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

rm -rf "$RUN_DIR/sessions" "$RUN_DIR/checkout" "$RUN_DIR/seed.json"

# One API boot. $1 names the boot (its log); the rest are extra environment for the process.
boot_api() {
  local name="$1"; shift
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$API_PORT" \
      HOST="127.0.0.1" \
      ALLOWED_ORIGINS="http://localhost:$WEB_PORT" \
      MODEL_BACKEND=faux \
      FAUX_COMMAND="echo faux-ok" \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      "$@" \
      bun run src/index.ts ) > "$RUN_DIR/api-$name.log" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
  local ready=0
  for _ in $(seq 1 80); do
    if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.5
  done
  if [ "$ready" -ne 1 ]; then
    echo "model-unavailable: the API did not become ready — see $RUN_DIR/api-$name.log" >&2
    return 1
  fi
}

copy_logs() { cp "$RUN_DIR"/api-*.log "$EVIDENCE_DIR/" 2>/dev/null || true; }

# --- boot 1: faux-cheap is served; seed a session pinned to it --------------------------------------
boot_api seed DEFAULT_MODEL=faux/faux-cheap || { copy_logs; exit 1; }
API_URL="http://localhost:$API_PORT" RUN_DIR="$RUN_DIR" EVIDENCE_DIR="$EVIDENCE_DIR" MODE=seed \
  node "$ROOT/.pi/skills/verify-web/model-unavailable.mjs"
rc=$?
stop api
if [ "$rc" -ne 0 ]; then copy_logs; echo "model-unavailable: seeding failed" >&2; exit 1; fi

# --- boot 2: the backend serves faux-1 alone; the pin is now to a model nobody serves --------------
boot_api drive || { copy_logs; exit 1; }
( cd "$ROOT/apps/web" && exec env \
    VITE_PORT="$WEB_PORT" \
    VITE_SERVER_URL="http://localhost:$API_PORT" \
    bun run dev ) > "$RUN_DIR/web.log" 2>&1 &
echo $! > "$RUN_DIR/web.pid"
ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "model-unavailable: the dashboard did not become ready — see $RUN_DIR/web.log" >&2
  copy_logs
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" RUN_DIR="$RUN_DIR" MODE=drive \
  node "$ROOT/.pi/skills/verify-web/model-unavailable.mjs"
rc=$?
copy_logs

echo
if [ "$rc" -eq 0 ]; then
  echo "model-unavailable: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "model-unavailable: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
