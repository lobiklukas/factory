#!/usr/bin/env bash
# Prove a mission resumes in the phase it died in (LOB-231): SIGTERM lands while a mission's
# checkpoint is `implement` and its two workers' conversations are on a tool call; a fresh process
# that nobody sends anything to reopens the session at boot, the checkpoint and the
# `factory.mission` document both still say `implement`, and the workers carry on to completion —
# the same workers, in the same conversations — rather than being lost or restarted from `plan`.
#
# This script owns its own API instance — its own port, session root, log, pid file and database —
# because the point of the test is to kill it, and because a booting API resumes every mission its
# database says is in flight: pointed at the database ./up.sh's instance uses, the restart would
# reopen that instance's sessions under it. So it mints a throwaway database on the server
# DATABASE_URL names (`factory_verify_mission_restart_<random>`), and drops it on exit after the API
# is stopped. It does not touch the instance ./up.sh started, and it leaves nothing running.
#
#   DATABASE_URL=… ./mission-restart.sh
#   DATABASE_URL=… API_PORT=9540 ./mission-restart.sh     # another port
#
# Env: DATABASE_URL (required — it names the *server*, not the database the drive writes),
# MISSION_RESTART_PORT or API_PORT (9410 when both are unset), EVIDENCE_DIR.
#
# Evidence: .verify/evidence/latest/api/mission-restart-arm.json and mission-restart-verify.json
# (what the session looked like before the signal and after the restart, from the driver),
# mission-restart-process.json (what the process did, from this script), and the API log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${MISSION_RESTART_PORT:-${API_PORT:-9410}}"
API_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/mission-restart"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
STATE="$RUN_DIR/state.json"
DRIVER="$ROOT/.pi/skills/verify-api/mission-restart.ts"
LOG="$RUN_DIR/api.log"
# The checkout the session's worktree is cut from, fresh per run: it declares the verify command
# the mission's last phase runs, so a mission that completes leaves its mark in the worktree.
CHECKOUT="$RUN_DIR/checkout"
HOLD="$RUN_DIR/hold"
REPO="lobiklukas/factory-mission-restart-$(date +%s)$$"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "mission-restart.sh needs DATABASE_URL naming the Postgres server to mint its database on" >&2
  exit 1
fi
SERVER_URL="$DATABASE_URL"
SCRATCH_DB="factory_verify_mission_restart_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

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
    echo "mission-restart.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
}

# The hold is released on every exit too, so a check still waiting on it ends with its process.
trap 'touch "$HOLD/release" 2>/dev/null; stop_api; drop_scratch' EXIT

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — set MISSION_RESTART_PORT to a free one" >&2
  exit 1
fi

# The checkout: a real repository with one commit on main that declares the verify command, so the
# session gets a linked worktree on `factory/<id>` and the mission's verify phase has work to do.
rm -rf "$CHECKOUT" "$RUN_DIR/sessions" "$HOLD"
mkdir -p "$HOLD"
git init -q -b main "$CHECKOUT"
mkdir -p "$CHECKOUT/.factory"
printf '{"verify": "touch .mission-verified"}\n' > "$CHECKOUT/.factory/config"
git -C "$CHECKOUT" add .factory/config
git -C "$CHECKOUT" -c user.email=mission@localhost -c user.name=mission \
  commit -q -m "mission restart checkout"

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "mission-restart.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DATABASE_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
export DATABASE_URL
echo "mission-restart: drive database $SCRATCH_DB (dropped on exit)"

: > "$LOG"
# The faux tool call sleeps, so each worker's conversation is genuinely in flight when the signal
# lands: implement is held by the subtasks themselves, not by a pause in the mission.
start_api "sleep 8 && echo faux-ok"
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

# --- arm: a mission waiting in implement on two workers mid-turn, then SIGTERM -------------------
MODE=arm API_URL="$API_URL" MISSION_RESTART_STATE="$STATE" EVIDENCE_DIR="$EVIDENCE_DIR" \
  MISSION_RESTART_CHECKOUT="$CHECKOUT" MISSION_RESTART_REPO="$REPO" MISSION_RESTART_HOLD="$HOLD" \
  bun "$DRIVER" > "$RUN_DIR/arm.log" 2>&1
ARM_RC=$?
cat "$RUN_DIR/arm.log"
if [ "$ARM_RC" != "0" ] || [ ! -s "$STATE" ]; then
  echo "the arm phase never reached a mission in implement — see $RUN_DIR/arm.log" >&2
  exit 1
fi
SESSION_ID="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).sessionId)' "$STATE")"
MISSION_ID="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).missionId)' "$STATE")"
API_PID="$(cat "$RUN_DIR/api.pid")"

kill -TERM "$API_PID"
for _ in $(seq 1 150); do kill -0 "$API_PID" 2>/dev/null || break; sleep 0.1; done
rm -f "$RUN_DIR/api.pid"

check "the process exits on SIGTERM" \
  "$(kill -0 "$API_PID" 2>/dev/null && echo 1 || echo 0)" \
  "pid=$API_PID session=$SESSION_ID mission=$MISSION_ID"
check "the shutdown released the session owners" \
  "$(grep -q 'shutdown: session owners released' "$LOG" && echo 0 || echo 1)" \
  "log line present"
check "nothing listens on the port between the two processes" \
  "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && echo 1 || echo 0)" \
  "port=$PORT"
# A reader that is neither the API nor the driver: with no process running, the row the next boot
# reads still says the session has a mission in flight.
MARKED="$(bun -e '
  const sql = new Bun.SQL(process.env.DATABASE_URL);
  const [row] = await sql`SELECT mission_in_flight FROM sessions WHERE id = ${process.argv[1]}`;
  console.log(row?.mission_in_flight === true ? "true" : "false");
  await sql.close();
' "$SESSION_ID" 2>/dev/null || echo "unreadable")"
check "the session's row says a mission is in flight while nothing runs" \
  "$([ "$MARKED" = "true" ] && echo 0 || echo 1)" "mission_in_flight=$MARKED"

# --- verify: a fresh process resumes the mission on its own --------------------------------------
start_api "echo faux-ok"
wait_ready || { echo "the restarted api did not become ready — see $LOG" >&2; exit 1; }

MODE=verify API_URL="$API_URL" MISSION_RESTART_STATE="$STATE" EVIDENCE_DIR="$EVIDENCE_DIR" \
  MISSION_RESTART_CHECKOUT="$CHECKOUT" MISSION_RESTART_REPO="$REPO" MISSION_RESTART_HOLD="$HOLD" \
  bun "$DRIVER" > "$RUN_DIR/verify.log" 2>&1
VERIFY_RC=$?
cat "$RUN_DIR/verify.log"
check "the resumed mission passes its checks" "$([ "$VERIFY_RC" = "0" ] && echo 0 || echo 1)" "exit=$VERIFY_RC"
check "the boot logged the mission it resumed" \
  "$(grep -q "missions: resumed 1 in flight: $SESSION_ID" "$LOG" && echo 0 || echo 1)" \
  "log line present"
CLEARED="$(bun -e '
  const sql = new Bun.SQL(process.env.DATABASE_URL);
  for (let i = 0; i < 50; i++) {
    const [row] = await sql`SELECT mission_in_flight FROM sessions WHERE id = ${process.argv[1]}`;
    if (row?.mission_in_flight === false) { console.log("false"); process.exit(0); }
    await Bun.sleep(100);
  }
  console.log("true");
  await sql.close();
' "$SESSION_ID" 2>/dev/null || echo "unreadable")"
check "once the mission settled, the row says none is in flight" \
  "$([ "$CLEARED" = "false" ] && echo 0 || echo 1)" "mission_in_flight=$CLEARED"

stop_api
check "the script leaves nothing listening on its port" \
  "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && echo 1 || echo 0)" \
  "port=$PORT"

cp "$LOG" "$EVIDENCE_DIR/mission-restart-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "database": "%s",\n' "$SCRATCH_DB"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "missionId": "%s",\n' "$MISSION_ID"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/mission-restart-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "mission-restart: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "mission-restart: FAILURES — see $EVIDENCE_DIR/mission-restart-process.json" >&2
fi
exit "$failed"
