#!/usr/bin/env bash
# Prove the card pane's exit checklist (D9): "Leaves <column> when" lists each of the column's
# requirements as met, unmet with the reason, or not checked, equal to what the server's
# `getTaskExit` says at the same moment, and a move the server would refuse over an unmet requirement
# says why before it is clicked. A declared spec flips `spec_doc` to met within one poll interval, a
# click on a warned move shows the server's own refusal, and a move into `canceled` is never warned.
#
# This script owns its own API and dashboard (its own ports, session root, logs and pid files); the
# instance ./up.sh starts is not touched and nothing is left running.
#
#   ./exit-checklist.sh
#   EXIT_API_PORT=9561 EXIT_WEB_PORT=3561 ./exit-checklist.sh      # another port pair
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does.
# Evidence: .verify/evidence/latest/exit-checklist/ — exit-*.png, observed.json, api.log, web.log.
set -uo pipefail

# Auth off (LOB-20), as ./up.sh runs it: the drive's own oracle calls send no credential.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${EXIT_API_PORT:-9561}"
WEB_PORT="${EXIT_WEB_PORT:-3561}"
RUN_DIR="$ROOT/.verify/run/exit-checklist"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/exit-checklist"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set EXIT_API_PORT / EXIT_WEB_PORT to free ones" >&2
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
for _ in $(seq 1 240); do
  if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1 &&
     curl -sf -m 1 "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "exit-checklist: the instance did not become ready in 120s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  node "$ROOT/.pi/skills/verify-web/exit-checklist.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "exit-checklist: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "exit-checklist: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
