#!/usr/bin/env bash
# Prove the definition editor (D6): a board's settings page offers "Edit as new version", which opens
# `/boards/$boardId/settings/edit` on the board's pinned version. The drive adds a column, is refused
# by the server with the fault shown next to the offending field, gives the column a move, a skill
# and a requirement picked from the server's lists (no free text), sees the diff against the pinned
# version, saves, reads "v2 created", and finds version 2 in `listDefinitions` while the board stays
# pinned to version 1.
#
# The drive then covers the editor's autonomy, WIP-limit and run-cap fields (F2, F3): a blank gate (the
# server) and a non-positive limit (the RunCap schema) are refused beside their fields, a save writes them, a board on the new version
# shows them (and `factory board definition show` prints them), an untouched column keeps its autonomy,
# and emptied fields remove the limits.
#
# This script owns its own API and dashboard (its own ports, session root, logs and pid files); the
# instance ./up.sh starts is not touched and nothing is left running. `ROLE_MODELS=builder=faux/faux-1`
# gives the deployment a role table, so the role picker's list is the one `defineBoard` checks and is
# closed. A second API and dashboard on the next port pair run with NO role table, where `defineBoard`
# accepts any role and the editor takes a typed one (F4, `definition-edit-roles.mjs`).
#
#   ./definition-edit.sh
#   DEFINITION_EDIT_API_PORT=9512 DEFINITION_EDIT_WEB_PORT=3512 ./definition-edit.sh   # another port pair
#
# The second pair is the first's ports + 1 (DEFINITION_EDIT_API_PORT+1, DEFINITION_EDIT_WEB_PORT+1).
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does. Each run authors
# a definition id of its own (`edit<hex>`), so it can be rerun against the same database and never
# adds a version to `default`.
# Evidence: .verify/evidence/latest/definition-edit/ — definition-edit-*.png, observed.json, observed-roles.json, api.log, web.log, open-api.log, open-web.log.
set -uo pipefail

# Auth off (LOB-20), as spend.sh runs it: the drive's oracle calls send no credential.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${DEFINITION_EDIT_API_PORT:-9475}"
WEB_PORT="${DEFINITION_EDIT_WEB_PORT:-3475}"
OPEN_API_PORT=$((API_PORT + 1))
OPEN_WEB_PORT=$((WEB_PORT + 1))
RUN_DIR="$ROOT/.verify/run/definition-edit"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/definition-edit"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT" "$OPEN_API_PORT" "$OPEN_WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set DEFINITION_EDIT_API_PORT / DEFINITION_EDIT_WEB_PORT to free ones" >&2
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
  stop open-web
  stop open-api
  cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/api.log" 2>/dev/null || true
  cp "$RUN_DIR/web.log" "$EVIDENCE_DIR/web.log" 2>/dev/null || true
  cp "$RUN_DIR/open-api.log" "$EVIDENCE_DIR/open-api.log" 2>/dev/null || true
  cp "$RUN_DIR/open-web.log" "$EVIDENCE_DIR/open-web.log" 2>/dev/null || true
  rm -rf "$RUN_DIR/sessions" "$RUN_DIR/open-sessions"
}
trap cleanup EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

rm -rf "$RUN_DIR/sessions" "$RUN_DIR/open-sessions"

( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    ALLOWED_ORIGINS="http://localhost:$WEB_PORT" \
    MODEL_BACKEND=faux \
    ROLE_MODELS=builder=faux/faux-1 \
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

# The same API with no role table (F4): ROLE_MODELS is left out, so any role name is accepted.
( cd "$ROOT/apps/api" && exec env \
    -u ROLE_MODELS \
    PORT="$OPEN_API_PORT" \
    ALLOWED_ORIGINS="http://localhost:$OPEN_WEB_PORT" \
    MODEL_BACKEND=faux \
    FAUX_COMMAND="echo faux-ok" \
    SESSION_ROOT="$RUN_DIR/open-sessions" \
    SESSION_IDLE_TIMEOUT_MS=600000 \
    bun run src/index.ts ) > "$RUN_DIR/open-api.log" 2>&1 &
echo $! > "$RUN_DIR/open-api.pid"

( cd "$ROOT/apps/web" && exec env \
    VITE_PORT="$OPEN_WEB_PORT" \
    VITE_SERVER_URL="http://localhost:$OPEN_API_PORT" \
    bun run dev ) > "$RUN_DIR/open-web.log" 2>&1 &
echo $! > "$RUN_DIR/open-web.pid"

ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1 &&
     curl -sf -m 1 "http://localhost:$WEB_PORT/" >/dev/null 2>&1 &&
     curl -sf -m 1 "http://localhost:$OPEN_API_PORT/readyz" >/dev/null 2>&1 &&
     curl -sf -m 1 "http://localhost:$OPEN_WEB_PORT/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "definition-edit: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" RUN_DIR="$RUN_DIR" CLI_DIR="$ROOT/apps/cli" \
  node "$ROOT/.pi/skills/verify-web/definition-edit.mjs"
rc=$?

WEB_URL="http://localhost:$OPEN_WEB_PORT" API_URL="http://localhost:$OPEN_API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  node "$ROOT/.pi/skills/verify-web/definition-edit-roles.mjs"
roles_rc=$?
[ "$rc" -eq 0 ] && rc=$roles_rc

echo
if [ "$rc" -eq 0 ]; then
  echo "definition-edit: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "definition-edit: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
