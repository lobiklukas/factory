#!/usr/bin/env bash
# Prove the board settings view (D3): `/boards/$boardId/settings` and each lane header's disclosure
# say what the board's pinned definition version does — every column's kind, role and the model it
# resolves to, skills, exit requirements marked "checked" or "not yet checked", moves out and human
# gates — and equal `getDefinition`'s answer for that version; a board pinned to an older version
# says the newer ones exist.
#
# A column's model is deployment configuration, so this script owns its own API and dashboard (its
# own ports, session root, logs and pid files), booted with `ROLE_MODELS=specifier=faux/faux-spec`:
# one role resolves to a role model and every other column to the deployment's own, so the page has
# both kinds to show. The instance ./up.sh starts is not touched and nothing is left running.
#
#   ./board-settings.sh
#   BOARD_SETTINGS_API_PORT=9541 BOARD_SETTINGS_WEB_PORT=3541 ./board-settings.sh   # another port pair
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does. Each run makes
# two boards of its own, so it can be rerun against the same database.
# Evidence: .verify/evidence/latest/board-settings/ — board-settings-*.png, observed.json, api.log, web.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${BOARD_SETTINGS_API_PORT:-9471}"
WEB_PORT="${BOARD_SETTINGS_WEB_PORT:-3471}"
RUN_DIR="$ROOT/.verify/run/board-settings"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board-settings"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set BOARD_SETTINGS_API_PORT / BOARD_SETTINGS_WEB_PORT to free ones" >&2
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
  echo "board-settings: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" RUN_DIR="$RUN_DIR" \
  node "$ROOT/.pi/skills/verify-web/board-settings.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "board-settings: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "board-settings: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
