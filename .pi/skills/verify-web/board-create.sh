#!/usr/bin/env bash
# Prove the "New board" form (C5): on a control plane with no board, an operator makes one from the
# dashboard — repository, definition and version picked, BoardExists and DefinitionNotFound shown in
# the server's words, the board visible to `factory board list`.
#
# This script owns its own API, dashboard and database (its own ports, session root, logs and pid
# files), because the empty state needs a database with no board in it. It mints a throwaway
# database on the server DATABASE_URL names (`factory_verify_web_board_create_<random>`) over TCP and
# drops it on exit. It does not touch ./up.sh's instance, and leaves nothing running.
#
#   DATABASE_URL=… ./board-create.sh
#   DATABASE_URL=… BOARD_CREATE_API_PORT=9561 BOARD_CREATE_WEB_PORT=3561 ./board-create.sh
#
# Evidence: .verify/evidence/latest/board-create/ — board-create-{empty,form,created,exists,
# definition-missing}.png, observed.json, api.log, web.log.
set -uo pipefail

# Auth off (LOB-20), as spend.sh runs it: the drive's oracle calls send no credential.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${BOARD_CREATE_API_PORT:-9561}"
WEB_PORT="${BOARD_CREATE_WEB_PORT:-3561}"
RUN_DIR="$ROOT/.verify/run/web-board-create"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board-create"
SERVER_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory}"
SCRATCH_DB="factory_verify_web_board_create_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set BOARD_CREATE_API_PORT / BOARD_CREATE_WEB_PORT to free ones" >&2
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

scratch_sql() { # statement
  bun -e '
    const sql = new Bun.SQL(process.argv[1]);
    try { await sql.unsafe(process.argv[2]); } finally { await sql.close(); }
  ' "$SERVER_URL" "$1"
}
SCRATCH_CREATED=0

cleanup() {
  stop web
  stop api
  cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/api.log" 2>/dev/null || true
  cp "$RUN_DIR/web.log" "$EVIDENCE_DIR/web.log" 2>/dev/null || true
  rm -rf "$RUN_DIR/sessions"
  if [ "$SCRATCH_CREATED" = "1" ]; then
    scratch_sql "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE)" >/dev/null 2>&1 ||
      echo "board-create.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
  fi
}
trap cleanup EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "board-create.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DATABASE_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
export DATABASE_URL
echo "board-create: drive database $SCRATCH_DB (dropped on exit)"

rm -rf "$RUN_DIR/sessions"

( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    ALLOWED_ORIGINS="http://localhost:$WEB_PORT" \
    MODEL_BACKEND=faux \
    FAUX_COMMAND="echo faux-ok" \
    SESSION_ROOT="$RUN_DIR/sessions" \
    SESSION_IDLE_TIMEOUT_MS=600000 \
    DATABASE_URL="$DATABASE_URL" \
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
  echo "board-create: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  node "$ROOT/.pi/skills/verify-web/board-create.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "board-create: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "board-create: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
