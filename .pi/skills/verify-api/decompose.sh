#!/usr/bin/env bash
# Prove the decomposition surface (LOB-201): a specifier run's spec becomes proposed child issues
# through `proposeDecomposition` over the real Effect RPC client, the proposals are committed as one
# document and read back through `getSession`, and nothing else is written — no session, no card, no
# event, no updated row. That no tracker request is made is the core suite's claim, not this drive's
# (see decompose.ts's header): this instance holds no tracker credentials.
#
# This script owns its own API instance — its own port, session root, log and pid file — because
# the instance has to run a faux specifier (`FAUX_SPEC`) whose spec declares no gaps, which the
# shared instance ./up.sh starts does not. It leaves nothing running.
#
#   DATABASE_URL=… ./decompose.sh
#   DATABASE_URL=… DECOMPOSE_PORT=9521 ./decompose.sh     # another port
#
# Env: DATABASE_URL (required — it names the *server*, not the database the drive writes),
# DECOMPOSE_PORT (9423 when unset), EVIDENCE_DIR.
#
# The drive fingerprints every table's content before and after the call, so it cannot share a database
# another process writes: it mints a throwaway database on the same server
# (`factory_verify_decompose_<random>`), points the API and the driver at it, and drops it on exit,
# after the API is stopped. A run killed with SIGKILL never reaches its drop; such a database holds
# only this drive's rows and is safe to drop by hand.
#
# Evidence: .verify/evidence/latest/api/decompose.json (every check the driver made, the spec, the
# proposals, the table fingerprints and the log's new commits), decompose-process.json (this script's checks)
# and decompose-api.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${DECOMPOSE_PORT:-9423}"
API_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/decompose"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
# The specifier's one `spec` call: a spec with no gaps, so the run never parks and the spec is ready
# to decompose. Two criteria, so the derived faux decomposition proposes two issues.
SPEC='{"goal":"Propose child issues from a spec document","acceptance":["a spec yields proposals readable through getSession","a refused proposal set is never stored"],"gaps":[],"openQuestions":[]}'
if [ -z "${DATABASE_URL:-}" ]; then
  echo "decompose.sh needs DATABASE_URL naming the Postgres server to mint its database on" >&2
  exit 1
fi
SERVER_URL="$DATABASE_URL"
SCRATCH_DB="factory_verify_decompose_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

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
  echo "port $PORT is already in use — set DECOMPOSE_PORT to a free one" >&2
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

# `CREATE`/`DROP DATABASE` over the configured server's connection; the name is an identifier this
# script minted from hex, so quoting it is the whole of the escaping it needs.
scratch_sql() { # statement
  bun -e '
    const sql = new Bun.SQL(process.argv[1]);
    try { await sql.unsafe(process.argv[2]); } finally { await sql.close(); }
  ' "$SERVER_URL" "$1"
}
SCRATCH_CREATED=0
drop_scratch() {
  [ "$SCRATCH_CREATED" = "1" ] || return 0
  scratch_sql "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE)" >/dev/null 2>&1 ||
    echo "decompose.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
}

trap 'stop_api; drop_scratch' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "decompose.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DATABASE_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
export DATABASE_URL
echo "decompose: drive database $SCRATCH_DB (dropped on exit)"
rm -rf "$RUN_DIR/sessions"

# A long idle timeout: every read must be served by the owner the decomposition used, so a release
# in the middle cannot be what makes a read pass or fail.
: > "$LOG"
( cd "$ROOT/apps/api" && exec env \
    PORT="$PORT" \
    HOST="127.0.0.1" \
    MODEL_BACKEND=faux \
    FAUX_SPEC="[$SPEC]" \
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
API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" EXPECT_SPEC="$SPEC" DATABASE_URL="$DATABASE_URL" \
  bun "$ROOT/.pi/skills/verify-api/decompose.ts" > "$RUN_DIR/driver.log" 2>&1
DRIVER_RC=$?
cat "$RUN_DIR/driver.log"
check "the driver passes its checks" "$([ "$DRIVER_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVER_RC"

check "one API process served the whole drive" \
  "$(kill -0 "$API_PID" 2>/dev/null && curl -sf -m 2 "$API_URL/livez" >/dev/null && echo 0 || echo 1)" \
  "pid=$API_PID"

# A reader that is neither the API nor the driver: the database itself holds the document's commit.
SESSION="$(bun -e '
  const observed = await Bun.file(process.argv[1]).json();
  console.log(observed.sessionId ?? "");
' "$EVIDENCE_DIR/decompose.json" 2>/dev/null)"
DOC_COMMITS="$(bun -e '
  const sql = new Bun.SQL(process.env.DATABASE_URL);
  const [row] = await sql`SELECT count(*)::int AS count FROM commits WHERE log_id = ${process.argv[1]} AND strpos(writes::text, ${"factory.proposedIssues"}) > 0`;
  console.log(row.count);
  await sql.close();
' "$SESSION" 2>/dev/null || echo "-1")"
check "the session's log holds one commit of factory.proposedIssues" \
  "$([ -n "$SESSION" ] && [ "$DOC_COMMITS" = "1" ] && echo 0 || echo 1)" "session=$SESSION commits=$DOC_COMMITS"

cp "$LOG" "$EVIDENCE_DIR/decompose-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "database": "%s",\n' "$SCRATCH_DB"
  printf '  "sessionId": "%s",\n' "$SESSION"
  printf '  "documentCommits": %s,\n' "${DOC_COMMITS:--1}"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/decompose-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "decompose: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "decompose: FAILURES — see $EVIDENCE_DIR/decompose-process.json" >&2
fi
exit "$failed"
