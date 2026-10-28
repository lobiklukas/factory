#!/usr/bin/env bash
# Prove the Repositories page (LOB-262): an operator registers the repository the factory works on
# from the dashboard, a refusal is shown in the server's words, a repo that cannot run is flagged,
# and a session on a registered checkout is cut a `factory/<session-id>` worktree.
#
# This script owns its own API and dashboard (its own ports, session root, logs and pid files) and
# its own throwaway git checkouts under .verify/run/repos/, so the instance ./up.sh starts is not
# touched and nothing is left running.
#
#   ./repos.sh
#   REPOS_API_PORT=9551 REPOS_WEB_PORT=3551 ./repos.sh      # another port pair
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does.
# Evidence: .verify/evidence/latest/repos/ — repos-*.png, observed.json, api.log, web.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${REPOS_API_PORT:-9441}"
WEB_PORT="${REPOS_WEB_PORT:-3441}"
RUN_DIR="$ROOT/.verify/run/repos"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/repos"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set REPOS_API_PORT / REPOS_WEB_PORT to free ones" >&2
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
  rm -rf "$RUN_DIR/sessions" "$RUN_DIR/checkouts"
  # The registry has no delete RPC: take back the rows this run registered (their checkouts are gone
  # now), so a database an operator reads is not left with not-runnable rows. Over TCP, as always.
  bun -e '
    const sql = new Bun.SQL(process.argv[1]);
    try { await sql`DELETE FROM repos WHERE slug LIKE ${"verify-repos-%"}`; } finally { await sql.close(); }
  ' "${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory}" >/dev/null 2>&1 ||
    echo "repos: could not delete the verify-repos-* rows; they remain in the database" >&2
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
  echo "repos: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" RUN_DIR="$RUN_DIR" \
  node "$ROOT/.pi/skills/verify-web/repos.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "repos: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "repos: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
