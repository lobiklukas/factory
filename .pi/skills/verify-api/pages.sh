#!/usr/bin/env bash
# Prove the pages surface (LOB-220): `curateSession` writes a session's cited page and `listPages`
# reads it back over the real Effect RPC client, a second pass writes nothing for exactly one call's
# worth of spend, and the page rows a rebuild refills come back from the log.
#
# This script owns its own API instance — its own port, session root, log and pid file — because the
# instance has to run a *priced* faux model (`FAUX_COST`): pi-ai's faux reports no cost, so on the
# instance ./up.sh starts "one call's worth" has no unit, and a repeat that made no call would read
# the same as one that made two. It does not touch that instance, and it leaves nothing running.
#
#   DATABASE_URL=… ./pages.sh
#   DATABASE_URL=… PAGES_PORT=9570 ./pages.sh     # another port
#
# Env: DATABASE_URL (required — the driver deletes this run's page rows and runs `rebuildIndexes`,
# which refolds every log in that database, so it must name the run's own), PAGES_PORT (9422 when
# unset), EVIDENCE_DIR.
#
# Evidence: .verify/evidence/latest/api/pages.json (every check the driver made, each curation's
# answer, the pages at each step, the spend and the log's page-entry count), pages-process.json (this
# script's checks) and pages-api.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${PAGES_PORT:-9422}"
API_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/pages"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
# A cent a request: the unit the driver counts calls in.
COST="0.01"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "pages.sh needs DATABASE_URL naming this run's own database" >&2
  exit 1
fi

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-60s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-60s %s\n' "$1" "$3"
  fi
}

write_checks() {
  local first=1
  local row
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n'
}

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — set PAGES_PORT to a free one" >&2
  exit 1
fi

stop_api() {
  local pidfile="$RUN_DIR/api.pid"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

trap 'stop_api' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# A long idle timeout: the drive's reads must all be served by the owner the curations used, so a
# release in the middle cannot be what makes a read pass or fail.
: > "$LOG"
( cd "$ROOT/apps/api" && exec env \
    PORT="$PORT" \
    HOST="127.0.0.1" \
    MODEL_BACKEND=faux \
    FAUX_COST="$COST" \
    SESSION_ROOT="$RUN_DIR/sessions" \
    SESSION_IDLE_TIMEOUT_MS=600000 \
    DATABASE_URL="$DATABASE_URL" \
    bun run src/index.ts ) >> "$LOG" 2>&1 &
echo $! > "$RUN_DIR/api.pid"
API_PID="$(cat "$RUN_DIR/api.pid")"
ready=1
for _ in $(seq 1 60); do
  curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && { ready=0; break; }
  sleep 0.5
done
[ "$ready" = "0" ] || { echo "api did not become ready — see $LOG" >&2; exit 1; }

# --- the driver: the RPC client the CLI and the dashboard build ------------------------------------
API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" FAUX_COST="$COST" DATABASE_URL="$DATABASE_URL" \
  bun "$ROOT/.pi/skills/verify-api/pages.ts" > "$RUN_DIR/driver.log" 2>&1
DRIVER_RC=$?
cat "$RUN_DIR/driver.log"
check "the driver passes its checks" "$([ "$DRIVER_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVER_RC"

# The rebuild ran in the driver, not in the API: the process that served every call is the one this
# script started, and it is still serving.
check "one API process served the whole drive" \
  "$(kill -0 "$API_PID" 2>/dev/null && curl -sf -m 2 "$API_URL/livez" >/dev/null && echo 0 || echo 1)" \
  "pid=$API_PID"

# A reader that is neither the API nor the driver: the database itself holds one row for the page.
SESSION="$(bun -e '
  const observed = await Bun.file(process.argv[1]).json();
  console.log(observed.sessionId ?? "");
' "$EVIDENCE_DIR/pages.json" 2>/dev/null)"
ROWS="$(bun -e '
  const sql = new Bun.SQL(process.env.DATABASE_URL);
  const [row] = await sql`SELECT count(*)::int AS count FROM session_pages WHERE session_id = ${process.argv[1]}`;
  console.log(row.count);
  await sql.close();
' "$SESSION" 2>/dev/null || echo "-1")"
check "the database holds one session_pages row for the session" \
  "$([ -n "$SESSION" ] && [ "$ROWS" = "1" ] && echo 0 || echo 1)" "session=$SESSION rows=$ROWS"

cp "$LOG" "$EVIDENCE_DIR/pages-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "fauxCost": %s,\n' "$COST"
  printf '  "sessionId": "%s",\n' "$SESSION"
  printf '  "pageRows": %s,\n' "${ROWS:--1}"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/pages-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "pages: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "pages: FAILURES — see $EVIDENCE_DIR/pages-process.json" >&2
fi
exit "$failed"
