#!/usr/bin/env bash
# Prove cost prediction on the dashboard (LOB-38): the New session form shows what a session would
# cost before it exists, caps it at the predicted high when asked, and `/spend` publishes the
# backtest — how wrong the prediction has been on this control plane's own sessions.
#
# This script owns its own API, dashboard and database (its own ports, session root, logs and pid
# files), because the API has to run a *priced* faux model (`FAUX_COST`: pi-ai's faux reports no
# cost, so no session would ever be history) and because the form's first state — no history, no
# estimate — needs a database with no completed session in it. It mints a throwaway database on the
# server DATABASE_URL names (`factory_verify_web_cost_<random>`) and drops it on exit. It does not
# touch ./up.sh's instance, and leaves nothing running.
#
#   DATABASE_URL=… ./cost.sh
#   DATABASE_URL=… COST_API_PORT=9552 COST_WEB_PORT=3552 ./cost.sh      # another port pair
#
# Evidence: .verify/evidence/latest/cost/ — cost-empty.png, cost-predicted.png, cost-capped.png,
# cost-spend.png, observed.json, api.log, web.log.
set -uo pipefail

# Auth off (LOB-20), as spend.sh runs it: the drive's oracle calls send no credential.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${COST_API_PORT:-9452}"
WEB_PORT="${COST_WEB_PORT:-3452}"
RUN_DIR="$ROOT/.verify/run/web-cost"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cost"
# A cent a model request: a session's first message is two (the `bash` call and the reply), each
# later one a reply, so a session sent k messages costs k + 1 cents.
COST="0.01"
SERVER_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory}"
SCRATCH_DB="factory_verify_web_cost_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set COST_API_PORT / COST_WEB_PORT to free ones" >&2
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
      echo "cost.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
  fi
}
trap cleanup EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "cost.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DATABASE_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
export DATABASE_URL
echo "cost: drive database $SCRATCH_DB (dropped on exit)"

rm -rf "$RUN_DIR/sessions"

( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    ALLOWED_ORIGINS="http://localhost:$WEB_PORT" \
    MODEL_BACKEND=faux \
    FAUX_COST="$COST" \
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
  echo "cost: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" FAUX_COST="$COST" \
  node "$ROOT/.pi/skills/verify-web/cost.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "cost: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "cost: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
