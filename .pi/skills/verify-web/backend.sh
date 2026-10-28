#!/usr/bin/env bash
# Prove the dashboard against a real-model deployment (LOB-272): no faux banner on any route, and a
# session's pane header and list row name `anthropic/claude-sonnet-5-5`.
#
# `drive.mjs` proves the faux half (the banner on /sessions and on a board) against the instance
# ./up.sh starts under MODEL_BACKEND=faux. This is the other half, and it needs a deployment whose
# backend is *inferred* anthropic, so it owns its own API and dashboard (own ports, session root, logs
# and pid files) and leaves nothing running. The credential is a dummy: the API only has to resolve
# one to choose the anthropic backend, and the drive never sends a session a message, so no request
# leaves the machine (creating a session opens a log; it calls no model).
#
#   ./backend.sh
#   BACKEND_API_PORT=9551 BACKEND_WEB_PORT=3551 ./backend.sh      # another port pair
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does.
# Evidence: .verify/evidence/latest/backend/ — backend-*.png, observed.json, api.log, web.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${BACKEND_API_PORT:-9451}"
WEB_PORT="${BACKEND_WEB_PORT:-3451}"
RUN_DIR="$ROOT/.verify/run/backend"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/backend"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set BACKEND_API_PORT / BACKEND_WEB_PORT to free ones" >&2
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

# A board for the "a board has no banner" check, made by the same seed verify-web's drive uses.
SEED_JSON="$(cd "$ROOT" && bun run .pi/skills/verify-board/seed.ts 2>"$RUN_DIR/seed.err")"
if [ -z "$SEED_JSON" ]; then
  echo "backend: the board seed printed nothing — see $RUN_DIR/seed.err" >&2
  exit 1
fi

# No MODEL_BACKEND: the backend is chosen by the credential, which is what a real deployment does.
# The other ambient credentials are cleared, so the dummy key is the one pi-ai resolves.
( cd "$ROOT/apps/api" && exec env -u MODEL_BACKEND -u ANTHROPIC_OAUTH_TOKEN \
    PORT="$API_PORT" \
    ALLOWED_ORIGINS="http://localhost:$WEB_PORT" \
    ANTHROPIC_API_KEY="sk-ant-verify-backend-dummy-not-a-credential" \
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
  echo "backend: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" BOARD_SEED="$SEED_JSON" \
  FACTORY_CLI="$ROOT/apps/cli/src/index.ts" \
  node "$ROOT/.pi/skills/verify-web/backend.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "backend: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "backend: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
