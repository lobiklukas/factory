#!/usr/bin/env bash
# Prove the card pane's thread (LOB-239): a card parked by a faux run's question shows the question,
# a person answers it in the browser, the answer lifts the `needs_input` block, `factory board show`
# agrees, and the next run on the card is quoted the answer in its prompt.
#
# This script owns its own API and dashboard (its own ports, session root, logs and pid files),
# because the API has to run the faux script that *asks* (`FAUX_ASK`). `FAUX_ASK` is API-wide: on
# the instance ./up.sh starts it would make every card run in drive.mjs ask, and the attention
# block's plan-approval card would park on a question instead of waiting at its gate. That instance
# is not touched, and this script leaves nothing running.
#
#   ./thread.sh
#   THREAD_API_PORT=9531 THREAD_WEB_PORT=3531 ./thread.sh      # another port pair
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does; the next-run
# probe (`../verify-board/ask.ts MODE=told`) reads the run's recorded prompt from it.
# Evidence: .verify/evidence/latest/thread/ — thread-*.png, observed.json, thread-told.json,
# api.log, web.log.
set -uo pipefail

# This suite runs its API with auth off (LOB-20): its clients send no credential, and it declares
# actors (a run's session id) that only an open control plane keeps. A token exported for the
# rest of the verify skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${THREAD_API_PORT:-9431}"
WEB_PORT="${THREAD_WEB_PORT:-3431}"
RUN_DIR="$ROOT/.verify/run/thread"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/thread"
# What the faux run asks once its `bash` turn is done, when its prompt carries no thread yet. The
# run after the answer carries one, so it does not ask again: one script plays both runs.
QUESTION="${FAUX_ASK:-Which Postgres major does this card target?}"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set THREAD_API_PORT / THREAD_WEB_PORT to free ones" >&2
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

# `FAUX_COMMAND` is a plain echo: the run's `bash` read is not the subject, only the question after
# it, and `ask.ts`'s `told` probe reads the reply.
( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    ALLOWED_ORIGINS="http://localhost:$WEB_PORT" \
    MODEL_BACKEND=faux \
    FAUX_ASK="$QUESTION" \
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
  echo "thread: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" FAUX_ASK="$QUESTION" \
  node "$ROOT/.pi/skills/verify-web/thread.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "thread: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "thread: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
