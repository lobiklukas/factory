#!/usr/bin/env bash
# Prove the spend pane (LOB-162, part 2 of LOB-17): `/spend` shows what sessions cost per repo, per
# actor, and per pair of the two, and its numbers are the server's.
#
# This script owns its own API and dashboard (its own ports, session root, logs and pid files),
# because the API has to run a *priced* faux model (`FAUX_COST`). pi-ai's faux reports no cost, so
# on the instance ./up.sh starts every line would read "no cost reported" and nothing would be
# proven. That instance is not touched, and this script leaves nothing running.
#
#   ./spend.sh
#   SPEND_API_PORT=9551 SPEND_WEB_PORT=3551 ./spend.sh      # another port pair
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does.
# Evidence: .verify/evidence/latest/spend/ — spend.png, spend-polled.png, observed.json, api.log,
# web.log.
set -uo pipefail

# This suite runs its API with auth off (LOB-20): its clients send no credential, and it declares
# actors (a run's session id) that only an open control plane keeps. A token exported for the
# rest of the verify skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${SPEND_API_PORT:-9421}"
WEB_PORT="${SPEND_WEB_PORT:-3421}"
RUN_DIR="$ROOT/.verify/run/spend"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/spend"
# A cent a model request. The faux script is two requests a run (a `bash` call, then the reply), so
# every run costs two cents, which is a number a mis-grouped row would visibly change.
COST="0.01"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set SPEND_API_PORT / SPEND_WEB_PORT to free ones" >&2
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

# `FAUX_COMMAND` is a plain echo: nothing here needs a run to stay on screen, and every run the drive
# waits on finishes in well under a second.
( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    ALLOWED_ORIGINS="http://localhost:$WEB_PORT" \
    MODEL_BACKEND=faux \
    FAUX_COST="$COST" \
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
  echo "spend: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" FAUX_COST="$COST" \
  node "$ROOT/.pi/skills/verify-web/spend.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "spend: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "spend: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
