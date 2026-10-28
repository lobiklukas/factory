#!/usr/bin/env bash
# Prove the New session form (E6): a press opens a form and creates nothing, an empty prompt sends no
# `createSession`, the typed prompt is the session's first user entry verbatim, a session on a picked
# repo and base ref is listed with both and works in a `factory/<session-id>` worktree, and a repo the
# server cannot cut a worktree from is refused inline in the server's words.
#
# This script owns its own API and dashboard (its own ports, session root, logs and pid files) and
# its own throwaway git checkouts under .verify/run/session-new/, so the instance ./up.sh starts is
# not touched and nothing is left running.
#
#   ./session-new.sh
#   SESSION_NEW_API_PORT=9551 SESSION_NEW_WEB_PORT=3551 ./session-new.sh      # another port pair
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does.
# Evidence: .verify/evidence/latest/session-new/ — session-new-*.png, observed.json, api.log, web.log.
set -uo pipefail

# This suite runs its API with auth off (LOB-20): its clients send no credential, and it declares
# actors (a run's session id) that only an open control plane keeps. A token exported for the
# rest of the verify skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${SESSION_NEW_API_PORT:-9461}"
WEB_PORT="${SESSION_NEW_WEB_PORT:-3461}"
RUN_DIR="$ROOT/.verify/run/session-new"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/session-new"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set SESSION_NEW_API_PORT / SESSION_NEW_WEB_PORT to free ones" >&2
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
  # Sessions first: their worktrees live in the checkouts, and the checkouts go with them.
  rm -rf "$RUN_DIR/sessions" "$RUN_DIR/checkouts"
  # The registry has no delete RPC: take back the rows this run registered (their checkouts are gone
  # now), so a database an operator reads is not left with not-runnable rows. Over TCP, as always.
  bun -e '
    const sql = new Bun.SQL(process.argv[1]);
    try { await sql`DELETE FROM repos WHERE slug LIKE ${"verify-session-new-%"}`; } finally { await sql.close(); }
  ' "${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory}" >/dev/null 2>&1 ||
    echo "session-new: could not delete the verify-session-new-* rows; they remain in the database" >&2
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
for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1 &&
     curl -sf -m 1 "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "session-new: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" RUN_DIR="$RUN_DIR" \
  node "$ROOT/.pi/skills/verify-web/session-new.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "session-new: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "session-new: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
