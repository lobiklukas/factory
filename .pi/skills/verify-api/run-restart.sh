#!/usr/bin/env bash
# Prove a run whose process died continues when the session is reopened (LOB-25): SIGKILL lands
# while a session's run is on a tool call — no finalizer, no shutdown, nothing released — and a fresh
# process that nobody sends anything to reopens the session at boot and carries the run on: the same
# submission, the dead process's transcript as its start, the interrupted call settled as
# interrupted rather than run again, an answer after it, and a retried request that submits nothing.
#
# This script owns its own API instance — its own port, session root, log, pid file and database —
# because the point of the test is to kill it. A booting API resumes the runs its database says are
# in flight under its own session root, so the root alone keeps the restart off ./up.sh's sessions;
# the database is the script's own as well, so what the boot resumed is exactly the one run this
# drive started ("resumed 1"). It mints a throwaway database on the server DATABASE_URL names
# (`factory_verify_run_restart_<random>`), and drops it on exit after the API is stopped. It does not
# touch the instance ./up.sh started, and it leaves nothing running.
#
#   ./run-restart.sh
#   KILL_SIGNAL=TERM ./run-restart.sh                     # the graceful path instead of SIGKILL
#   DATABASE_URL=… RUN_RESTART_PORT=9540 ./run-restart.sh # another server, another port
#
# Env: DATABASE_URL (the *server* to mint the drive's database on, not the database it writes;
# default postgres://factory:factory@localhost:5442/factory, the API's own default),
# RUN_RESTART_PORT or API_PORT (9430 when both are unset), KILL_SIGNAL (KILL or TERM), EVIDENCE_DIR.
#
# Evidence: .verify/evidence/latest/api/run-restart-arm.json and run-restart-verify.json (what the
# session looked like before the kill and after the restart, from the driver),
# run-restart-process.json (what the process did, from this script), and the API log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${RUN_RESTART_PORT:-${API_PORT:-9430}}"
API_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/run-restart"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
STATE="$RUN_DIR/state.json"
DRIVER="$ROOT/.pi/skills/verify-api/run-restart.ts"
LOG="$RUN_DIR/api.log"
HOLD="$RUN_DIR/hold"
SIGNAL="${KILL_SIGNAL:-KILL}"
# The server only: the database the URL names is where the scratch one is created from, not written.
SERVER_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory}"
SCRATCH_DB="factory_verify_run_restart_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"
rm -f "$STATE"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-64s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-64s %s\n' "$1" "$3"
  fi
}

# The checks as a JSON object keyed by name, matching the drivers' evidence files.
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

start_api() { # faux command
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      FAUX_COMMAND="$1" \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      DATABASE_URL="$DATABASE_URL" \
      bun run src/index.ts ) >> "$LOG" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
}

wait_ready() {
  for _ in $(seq 1 60); do
    curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

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
    echo "run-restart.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
}

# The hold is released on every exit too, so the command a SIGKILL orphaned ends with the script.
trap 'touch "$HOLD/release" 2>/dev/null; stop_api; drop_scratch' EXIT

case "$SIGNAL" in
  KILL | TERM) ;;
  *) echo "KILL_SIGNAL must be KILL or TERM, not $SIGNAL" >&2; exit 1 ;;
esac

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — set RUN_RESTART_PORT to a free one" >&2
  exit 1
fi

rm -rf "$RUN_DIR/sessions" "$HOLD"
mkdir -p "$HOLD"

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "run-restart.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DATABASE_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
export DATABASE_URL
echo "run-restart: drive database $SCRATCH_DB (dropped on exit), signal SIG$SIGNAL"

: > "$LOG"
# The faux tool call counts its run into the worktree (the policy keeps a run's writes there), then
# holds on a file outside it, which it only reads: the run is in flight until the script says so.
start_api "echo run >> run-restart.runs; while [ ! -f $HOLD/release ]; do sleep 0.1; done; echo faux-ok"
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

# --- arm: a run on its tool call, then the signal -------------------------------------------------
MODE=arm API_URL="$API_URL" RUN_RESTART_STATE="$STATE" EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$DRIVER" > "$RUN_DIR/arm.log" 2>&1
ARM_RC=$?
cat "$RUN_DIR/arm.log"
if [ "$ARM_RC" != "0" ] || [ ! -s "$STATE" ]; then
  echo "the arm phase never reached a run in flight — see $RUN_DIR/arm.log" >&2
  exit 1
fi
SESSION_ID="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).sessionId)' "$STATE")"
API_PID="$(cat "$RUN_DIR/api.pid")"

kill "-$SIGNAL" "$API_PID"
for _ in $(seq 1 300); do kill -0 "$API_PID" 2>/dev/null || break; sleep 0.1; done
rm -f "$RUN_DIR/api.pid"

check "the process exits on SIG$SIGNAL" \
  "$(kill -0 "$API_PID" 2>/dev/null && echo 1 || echo 0)" \
  "pid=$API_PID session=$SESSION_ID"
if [ "$SIGNAL" = "KILL" ]; then
  check "no finalizer ran: the shutdown never logged a release" \
    "$(grep -q 'shutdown: releasing every session owner' "$LOG" && echo 1 || echo 0)" \
    "log line absent"
else
  check "the shutdown released the session owners" \
    "$(grep -q 'shutdown: session owners released' "$LOG" && echo 0 || echo 1)" \
    "log line present"
fi
check "nothing listens on the port between the two processes" \
  "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && echo 1 || echo 0)" \
  "port=$PORT"
# A reader that is neither the API nor the driver: with no process running, the row the next boot
# reads still names the run in flight, under this script's session root.
MARKED_ROOT="$(bun -e '
  const sql = new Bun.SQL(process.env.DATABASE_URL);
  const [row] = await sql`SELECT run_session_root FROM sessions WHERE id = ${process.argv[1]}`;
  console.log(row?.run_session_root ?? "null");
  await sql.close();
' "$SESSION_ID" 2>/dev/null || echo "unreadable")"
check "the session's row says a run is in flight, under this root, while nothing runs" \
  "$([ "$MARKED_ROOT" = "$RUN_DIR/sessions" ] && echo 0 || echo 1)" "run_session_root=$MARKED_ROOT"

# --- verify: a fresh process continues the run on its own -----------------------------------------
start_api "echo faux-ok"
wait_ready || { echo "the restarted api did not become ready — see $LOG" >&2; exit 1; }

MODE=verify API_URL="$API_URL" RUN_RESTART_STATE="$STATE" EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$DRIVER" > "$RUN_DIR/verify.log" 2>&1
VERIFY_RC=$?
cat "$RUN_DIR/verify.log"
check "the resumed run passes its checks" "$([ "$VERIFY_RC" = "0" ] && echo 0 || echo 1)" "exit=$VERIFY_RC"
check "the boot logged the run it resumed" \
  "$(grep -q "runs: resumed 1 in flight: $SESSION_ID" "$LOG" && echo 0 || echo 1)" \
  "log line present"
check "the reopen named the submission it continued" \
  "$(grep -q "session $SESSION_ID: resumed 1 unsettled submission(s) on reopen" "$LOG" && echo 0 || echo 1)" \
  "log line present"
CLEARED="$(bun -e '
  const sql = new Bun.SQL(process.env.DATABASE_URL);
  for (let i = 0; i < 50; i++) {
    const [row] = await sql`SELECT run_session_root FROM sessions WHERE id = ${process.argv[1]}`;
    if (row?.run_session_root === null) { console.log("null"); process.exit(0); }
    await Bun.sleep(100);
  }
  console.log("set");
  await sql.close();
' "$SESSION_ID" 2>/dev/null || echo "unreadable")"
check "once the run settled, the row says none is in flight" \
  "$([ "$CLEARED" = "null" ] && echo 0 || echo 1)" "run_session_root=$CLEARED"

stop_api
check "the script leaves nothing listening on its port" \
  "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && echo 1 || echo 0)" \
  "port=$PORT"

cp "$LOG" "$EVIDENCE_DIR/run-restart-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "database": "%s",\n' "$SCRATCH_DB"
  printf '  "signal": "SIG%s",\n' "$SIGNAL"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/run-restart-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "run-restart: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "run-restart: FAILURES — see $EVIDENCE_DIR/run-restart-process.json" >&2
fi
exit "$failed"
