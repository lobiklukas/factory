#!/usr/bin/env bash
# Prove the per-session budget cap (LOB-163, part 3 of LOB-17): a capped run stops at its limit, and
# the stop is reported to the operator — in the transcript, in the session snapshot, on the session
# stream, in the API's own log, and in `factory run`'s output.
#
# This script owns its own API instance — its own port, session root, log and pid file — because the
# instance has to run a *priced* faux model (`FAUX_COST`): pi-ai's faux reports no cost, so a cap on
# the instance ./up.sh starts could never be reached. It does not touch that instance, and it leaves
# nothing running.
#
#   ./budget.sh
#   BUDGET_PORT=9570 ./budget.sh     # another port
#
# Evidence: .verify/evidence/latest/api/budget.json (every check the driver made, the stream's event
# log and each session's budget), budget-transcript.txt, budget-cli.txt (what `factory run --budget`
# printed), budget-process.json (this script's checks) and budget-api.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${BUDGET_PORT:-9419}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/budget"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
# A cent a request, and a default cap no two-request run reaches: the capped session names its own.
COST="0.01"
DEFAULT_BUDGET="1"

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
  echo "port $PORT is already in use — set BUDGET_PORT to a free one" >&2
  exit 1
fi

start_api() {
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      FAUX_COST="$COST" \
      SESSION_BUDGET="$DEFAULT_BUDGET" \
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

check "the API logs the default cap it was started with" \
  "$(grep -q "session budget: \$$DEFAULT_BUDGET by default (SESSION_BUDGET)" "$LOG" && echo 0 || echo 1)" \
  "SESSION_BUDGET=$DEFAULT_BUDGET"

# --- the driver: the RPC client the CLI and the dashboard build ------------------------------------
API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" FAUX_COST="$COST" SESSION_BUDGET="$DEFAULT_BUDGET" \
  bun "$ROOT/.pi/skills/verify-api/budget.ts" > "$RUN_DIR/driver.log" 2>&1
DRIVER_RC=$?
cat "$RUN_DIR/driver.log"
check "the driver passes its checks" "$([ "$DRIVER_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVER_RC"

CAPPED="$(sed -n 's/^CAPPED=//p' "$EVIDENCE_DIR/budget-sessions.env" 2>/dev/null)"
check "the API log names the session its budget stopped" \
  "$([ -n "$CAPPED" ] && grep -q "session $CAPPED stopped by its budget: budget reached" "$LOG" && echo 0 || echo 1)" \
  "session=$CAPPED"

# --- the operator's terminal: factory run --budget --------------------------------------------------
( cd "$ROOT/apps/cli" && bun run src/index.ts run "spend at most a cent" --budget "$COST" --api "$API_URL" ) \
  > "$RUN_DIR/cli.txt" 2>&1
CLI_RC=$?
cp "$RUN_DIR/cli.txt" "$EVIDENCE_DIR/budget-cli.txt"
cat "$RUN_DIR/cli.txt"
check "factory run --budget exits cleanly" "$([ "$CLI_RC" = "0" ] && echo 0 || echo 1)" "exit=$CLI_RC"
check "factory run prints the cap it asked for" \
  "$(grep -q '^budget \$0.0100$' "$RUN_DIR/cli.txt" && echo 0 || echo 1)" "budget line"
check "factory run prints the stop as a transcript line" \
  "$(grep -q '^\[budget\] budget reached: the session has spent \$0.0100 of its \$0.0100 cap' "$RUN_DIR/cli.txt" && echo 0 || echo 1)" \
  "[budget] line"
check "factory run says the run was stopped, not answered" \
  "$(grep -q '^answer: (no answer)$' "$RUN_DIR/cli.txt" && grep -q '^stopped: budget reached (\$0.0100 of \$0.0100)$' "$RUN_DIR/cli.txt" && echo 0 || echo 1)" \
  "answer + stopped lines"

# --- the operator's terminal: factory budget (C23) ---------------------------------------------
( cd "$ROOT/apps/cli" && bun run src/index.ts budget "$CAPPED" --cap 0.5 --api "$API_URL" ) \
  > "$RUN_DIR/cli-budget.txt" 2>&1
CLI_BUDGET_RC=$?
cp "$RUN_DIR/cli-budget.txt" "$EVIDENCE_DIR/budget-cli-set.txt"
cat "$RUN_DIR/cli-budget.txt"
check "factory budget exits cleanly" "$([ "$CLI_BUDGET_RC" = "0" ] && echo 0 || echo 1)" "exit=$CLI_BUDGET_RC"
check "factory budget prints the cap now in force and the spend" \
  "$(grep -q "^capped $CAPPED: \$0.5000 cap, \$0.0200 spent$" "$RUN_DIR/cli-budget.txt" && echo 0 || echo 1)" "capped line"

cp "$LOG" "$EVIDENCE_DIR/budget-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "fauxCost": %s,\n' "$COST"
  printf '  "defaultBudget": %s,\n' "$DEFAULT_BUDGET"
  printf '  "cappedSession": "%s",\n' "$CAPPED"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/budget-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "budget: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "budget: FAILURES — see $EVIDENCE_DIR/budget-process.json" >&2
fi
exit "$failed"
