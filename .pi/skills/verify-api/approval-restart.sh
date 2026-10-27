#!/usr/bin/env bash
# Prove an approval survives the process that asked for it (LOB-52, D15): a gated call parks the run
# on an approval, the API is killed, and a fresh process folds the session with the approval still
# pending and no second request in the log — then the agent's retry re-asks nothing, and once a
# person approves, the same call runs once; the run after it asks again under a new request id.
#
# This script owns its own API instance — its own port, session root, log and pid file — because the
# point of the test is to kill it. It does not touch the instance ./up.sh started, and it leaves
# nothing running.
#
#   ./approval-restart.sh
#   APPROVAL_PORT=9501 ./approval-restart.sh      # another port
#   KILL_SIGNAL=TERM ./approval-restart.sh        # the graceful path instead of SIGKILL
#
# The faux tool call is the gated command, and it sleeps (`FAUX_COMMAND`): a gate that failed open
# would hold the run busy for the whole sleep, so a run that is idle seconds after the ask is a run
# that did not run it. After the approval the same sleep is what makes that run observably busy.
#
# Evidence: .verify/evidence/latest/api/approval-restart-{arm,verify}.json (what the session and its
# log looked like, from the driver), approval-restart-process.json (what the processes did, from
# this script), the API log, and both transcripts as text.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${APPROVAL_PORT:-9416}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/approval-restart"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
STATE="$RUN_DIR/state.json"
DRIVER="$ROOT/.pi/skills/verify-api/approval-restart.ts"
LOG="$RUN_DIR/api.log"
SIGNAL="${KILL_SIGNAL:-KILL}"
# The gate and the command it stops. Twelve seconds is long enough that "idle with an approval
# pending" cannot be the command having finished, and short enough to wait out once approved.
GATE="sleep"
COMMAND="sleep 12 && echo gated-ran"

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
    printf 'PASS  %-52s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-52s %s\n' "$1" "$3"
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

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — set APPROVAL_PORT to a free one" >&2
  exit 1
fi

start_api() {
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      FAUX_COMMAND="$COMMAND" \
      FAUX_EVERY_TURN=true \
      APPROVAL_REQUIRED="$GATE" \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
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

trap 'stop_api' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

: > "$LOG"
start_api
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }
FIRST_PID="$(cat "$RUN_DIR/api.pid")"

check "the API logs the gate it was started with" \
  "$(grep -q "commands that wait for an approval: $GATE" "$LOG" && echo 0 || echo 1)" \
  "APPROVAL_REQUIRED=$GATE"

# --- arm: a gated call parks the run on an approval -----------------------------------------------
MODE=arm API_URL="$API_URL" APPROVAL_STATE="$STATE" EVIDENCE_DIR="$EVIDENCE_DIR" \
  FAUX_COMMAND="$COMMAND" bun "$DRIVER" > "$RUN_DIR/arm.log" 2>&1
ARM_RC=$?
cat "$RUN_DIR/arm.log"
check "the arm phase passes its checks" "$([ "$ARM_RC" = "0" ] && echo 0 || echo 1)" "exit=$ARM_RC"
if [ ! -s "$STATE" ]; then
  echo "the arm phase never parked a run on an approval — see $RUN_DIR/arm.log" >&2
  exit 1
fi

# --- kill: the process that asked is gone ---------------------------------------------------------
kill "-$SIGNAL" "$FIRST_PID"
for _ in $(seq 1 150); do kill -0 "$FIRST_PID" 2>/dev/null || break; sleep 0.1; done
rm -f "$RUN_DIR/api.pid"
check "the process that asked is gone" \
  "$(kill -0 "$FIRST_PID" 2>/dev/null && echo 1 || echo 0)" \
  "pid=$FIRST_PID signal=SIG$SIGNAL"

# --- verify: a fresh process folds the approval and re-asks nothing --------------------------------
start_api
wait_ready || { echo "the restarted api did not become ready — see $LOG" >&2; exit 1; }
SECOND_PID="$(cat "$RUN_DIR/api.pid")"
check "a fresh process serves the session" \
  "$([ "$SECOND_PID" != "$FIRST_PID" ] && echo 0 || echo 1)" \
  "first=$FIRST_PID second=$SECOND_PID"

MODE=verify API_URL="$API_URL" APPROVAL_STATE="$STATE" EVIDENCE_DIR="$EVIDENCE_DIR" \
  FAUX_COMMAND="$COMMAND" bun "$DRIVER" > "$RUN_DIR/verify.log" 2>&1
VERIFY_RC=$?
cat "$RUN_DIR/verify.log"
check "the verify phase passes its checks" "$([ "$VERIFY_RC" = "0" ] && echo 0 || echo 1)" "exit=$VERIFY_RC"

SESSION_ID="$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$STATE','utf8')).sessionId)")"
cp "$LOG" "$EVIDENCE_DIR/approval-restart-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "signal": "SIG%s",\n' "$SIGNAL"
  printf '  "fauxCommand": "%s",\n' "$COMMAND"
  printf '  "approvalRequired": "%s",\n' "$GATE"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/approval-restart-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "approval-restart: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "approval-restart: FAILURES — see $EVIDENCE_DIR/approval-restart-process.json" >&2
fi
exit "$failed"
