#!/usr/bin/env bash
# Prove the session pane's Interrupt button (C8): a press on a busy run sends one `interruptSession`,
# the header goes idle within the poll window, and the run never prints `faux-ok`; the transcript
# ends the turn with its `interrupted` row; a follow-up message runs normally; and an interrupt the
# server refuses because the run already settled (`not_running`) is a toast in the server's words.
#
# The run has to be busy long enough to press: this script owns its own API and dashboard (its own
# ports, session root, logs and pid files), booted with `FAUX_SLEEP_MS` so the scripted model naps
# before it calls `bash` and again before it answers. The instance ./up.sh starts is not touched and
# nothing is left running.
#
#   ./interrupt.sh
#   INTERRUPT_API_PORT=9541 INTERRUPT_WEB_PORT=3541 ./interrupt.sh      # another port pair
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does.
# Evidence: .verify/evidence/latest/interrupt/ — interrupt-*.png, observed.json, api.log, web.log.
set -uo pipefail

# Auth off (LOB-20), as ./up.sh runs it: the drive's own oracle calls send no credential.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${INTERRUPT_API_PORT:-9461}"
WEB_PORT="${INTERRUPT_WEB_PORT:-3461}"
SLEEP_MS="${FAUX_SLEEP_MS:-4000}"
RUN_DIR="$ROOT/.verify/run/interrupt"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/interrupt"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set INTERRUPT_API_PORT / INTERRUPT_WEB_PORT to free ones" >&2
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
    FAUX_SLEEP_MS="$SLEEP_MS" \
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
  echo "interrupt: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" FAUX_SLEEP_MS="$SLEEP_MS" \
  node "$ROOT/.pi/skills/verify-web/interrupt.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "interrupt: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "interrupt: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
