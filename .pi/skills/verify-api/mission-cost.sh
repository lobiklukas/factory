#!/usr/bin/env bash
# Prove a mission reports what each worker spent (LOB-194, part 3 of LOB-35): two workers, two
# separate costs, their sum is the session's total, and the breakdown is read from the log — the same
# for the live owner, for the fold of a released session, and for a second API process that never ran
# the mission.
#
# This script owns its own API instance — its own port, session root, log and pid file — because the
# instance has to run a *priced* faux model (`FAUX_COST`): pi-ai's faux reports no cost, so there
# would be nothing to attribute on the instance ./up.sh starts. The API is stopped and started again
# between the two driver passes, which is the reopen. It does not touch ./up.sh's instance, and it
# leaves nothing running.
#
#   ./mission-cost.sh
#   MISSION_COST_PORT=9581 ./mission-cost.sh     # another port
#
# Evidence: .verify/evidence/latest/api/mission-cost-run.json and mission-cost-reopen.json (every
# check the driver made, with the breakdown it read), mission-cost-process.json (this script's
# checks) and mission-cost-api.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${MISSION_COST_PORT:-9427}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/mission-cost"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
# A cent a request: each worker's run is two requests, so each worker costs two cents.
COST="0.01"

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
  echo "port $PORT is already in use — set MISSION_COST_PORT to a free one" >&2
  exit 1
fi

start_api() {
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      FAUX_COST="$COST" \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=2000 \
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
rm -f "$EVIDENCE_DIR/mission-cost-session.json"
start_api
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

# --- pass one: run the mission, read the breakdown live and folded ------------------------------------
MODE=run API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" FAUX_COST="$COST" \
  bun "$ROOT/.pi/skills/verify-api/mission-cost.ts" > "$RUN_DIR/driver-run.log" 2>&1
RUN_RC=$?
cat "$RUN_DIR/driver-run.log"
check "the run pass: two workers' costs, their sum, the fold" "$([ "$RUN_RC" = "0" ] && echo 0 || echo 1)" "exit=$RUN_RC"

# --- the reopen: a new process, which never ran the mission ---------------------------------------------
stop_api
check "the API stopped before the reopen" \
  "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && echo 1 || echo 0)" "port $PORT free"
start_api
wait_ready || { echo "api did not become ready again — see $LOG" >&2; exit 1; }
MODE=reopen API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" FAUX_COST="$COST" \
  bun "$ROOT/.pi/skills/verify-api/mission-cost.ts" > "$RUN_DIR/driver-reopen.log" 2>&1
REOPEN_RC=$?
cat "$RUN_DIR/driver-reopen.log"
check "the reopen pass: the second process reads the same breakdown" \
  "$([ "$REOPEN_RC" = "0" ] && echo 0 || echo 1)" "exit=$REOPEN_RC"

cp "$LOG" "$EVIDENCE_DIR/mission-cost-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "fauxCost": %s,\n' "$COST"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/mission-cost-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "mission-cost: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "mission-cost: FAILURES — see $EVIDENCE_DIR/mission-cost-process.json" >&2
fi
exit "$failed"
