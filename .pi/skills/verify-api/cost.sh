#!/usr/bin/env bash
# Prove cost prediction before a run (LOB-38): a range from the completed sessions most like a task,
# shown before a session exists, a cap at its high on request, and the backtest that publishes how
# wrong it has been — over the RPC client, and in the operator's terminal (`factory run`,
# `factory cost`).
#
# This script owns its own API instance — its own port, session root, log, pid file and database —
# because the API has to run a *priced* faux model (`FAUX_COST`: pi-ai's faux reports no cost, so no
# session would ever be history), and because every number the drive checks is drawn from the whole
# history the database holds: on a shared database another suite's sessions would move them. It mints
# a throwaway database on the server DATABASE_URL names (`factory_verify_cost_<random>`) and drops it
# on exit after the API is stopped. It does not touch ./up.sh's instance, and leaves nothing running.
#
#   DATABASE_URL=… ./cost.sh
#   DATABASE_URL=… COST_PORT=9551 ./cost.sh     # another port
#
# Env: DATABASE_URL (the *server* to mint the drive's database on, not the database it writes;
# default postgres://factory:factory@localhost:5442/factory), COST_PORT or API_PORT (9432 when both
# are unset), EVIDENCE_DIR.
#
# Evidence: .verify/evidence/latest/api/cost.json and cost-capped.json (every check the driver made
# and every answer it read), cost-cli-*.txt (what each `factory` command printed),
# cost-process.json (this script's checks) and cost-api.log.
set -uo pipefail

# This suite runs its API with auth off (LOB-20), as budget.sh does: a token exported for the rest of
# the verify skills must not turn auth on under a client that sends none.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${COST_PORT:-${API_PORT:-9432}}"
API_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/cost"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
COST="0.01"
SERVER_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory}"
SCRATCH_DB="factory_verify_cost_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TAG="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
REPO="verify-cost-$TAG/web"
OTHER="verify-cost-$TAG/api"
CLI=(bun run "$ROOT/apps/cli/src/index.ts")

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  local detail="${3//\\/\\\\}"
  detail="${detail//\"/\\\"}"
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$detail\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-72s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-72s %s\n' "$1" "$3"
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
    echo "cost.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
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

trap 'stop_api; cp "$LOG" "$EVIDENCE_DIR/cost-api.log" 2>/dev/null; rm -rf "$RUN_DIR/sessions"; drop_scratch' EXIT

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — set COST_PORT to a free one" >&2
  exit 1
fi

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
echo "cost: drive database $SCRATCH_DB (dropped on exit), repos $REPO and $OTHER"

rm -rf "$RUN_DIR/sessions"
: > "$LOG"
( cd "$ROOT/apps/api" && exec env \
    PORT="$PORT" \
    HOST="127.0.0.1" \
    MODEL_BACKEND=faux \
    FAUX_COST="$COST" \
    FAUX_COMMAND="echo faux-ok" \
    SESSION_ROOT="$RUN_DIR/sessions" \
    SESSION_IDLE_TIMEOUT_MS=600000 \
    DATABASE_URL="$DATABASE_URL" \
    bun run src/index.ts ) >> "$LOG" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

ready=0
for _ in $(seq 1 60); do
  curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 0.5
done
[ "$ready" = "1" ] || { echo "api did not become ready — see $LOG" >&2; exit 1; }

cli() { # evidence name, args…
  local name="$1"; shift
  "${CLI[@]}" "$@" --api "$API_URL" > "$EVIDENCE_DIR/cost-cli-$name.txt" 2>&1
  local rc=$?
  echo "\$ factory $* (exit $rc)"
  sed 's/^/    /' "$EVIDENCE_DIR/cost-cli-$name.txt"
  return "$rc"
}
sessions_in_db() {
  bun -e '
    const sql = new Bun.SQL(process.env.DATABASE_URL);
    try { console.log((await sql`SELECT count(*)::int AS n FROM sessions`)[0].n); } finally { await sql.close(); }
  '
}

# --- an empty history: nothing to predict from, nothing to cap at ----------------------------------
cli refused-empty run "fix the parser bug" --repo "$REPO" --cap-at-prediction
RC=$?
check "factory run --cap-at-prediction with no history is refused" \
  "$([ "$RC" != "0" ] && grep -q '^error: invalid_input: no prediction to cap at: 0 sessions completed, 3 comparable needed; pass --budget instead$' "$EVIDENCE_DIR/cost-cli-refused-empty.txt" && echo 0 || echo 1)" \
  "exit=$RC"
check "and it said there is no estimate before refusing" \
  "$(grep -q '^predicted: no estimate (0 sessions completed, 3 comparable needed; fix on faux/faux-1)$' "$EVIDENCE_DIR/cost-cli-refused-empty.txt" && echo 0 || echo 1)" \
  "the predicted line"
cli refused-both run "fix the parser bug" --budget 1 --cap-at-prediction
RC=$?
check "factory run with both --budget and --cap-at-prediction is refused" \
  "$([ "$RC" != "0" ] && grep -q '^error: invalid_input: --cap-at-prediction and --budget both set the cap; pass one$' "$EVIDENCE_DIR/cost-cli-refused-both.txt" && echo 0 || echo 1)" \
  "exit=$RC"
N="$(sessions_in_db)"
check "neither refusal created a session" "$([ "$N" = "0" ] && echo 0 || echo 1)" "sessions=$N"

# --- the driver: history, predictions and backtests over the RPC client ----------------------------
API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" FAUX_COST="$COST" REPO="$REPO" OTHER="$OTHER" \
  bun "$ROOT/.pi/skills/verify-api/cost.ts" > "$RUN_DIR/driver.log" 2>&1
DRIVER_RC=$?
cat "$RUN_DIR/driver.log"
check "the driver passes its checks" "$([ "$DRIVER_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVER_RC"

# --- the operator's terminal ------------------------------------------------------------------------
cli predict cost predict "fix the flaky test" --repo "$REPO"
RC=$?
check "factory cost predict prints the range, its median, its sample and its basis" \
  "$([ "$RC" = "0" ] && grep -q '^predicted \$0.0200 to \$0.0370, median \$0.0250, from 4 sessions (repo+model+shape; fix on faux/faux-1)$' "$EVIDENCE_DIR/cost-cli-predict.txt" && echo 0 || echo 1)" \
  "exit=$RC"
cli backtest cost backtest --repo "$REPO" --rows
RC=$?
check "factory cost backtest leads with the median error" \
  "$([ "$RC" = "0" ] && grep -q '^backtest: median error 37.5% over 2 sessions (3 skipped, 5 completed)$' "$EVIDENCE_DIR/cost-cli-backtest.txt" && echo 0 || echo 1)" \
  "exit=$RC"
check "then the absolute error, the coverage, and that two is too few to mean much" \
  "$(grep -q '^median absolute error \$0.0125$' "$EVIDENCE_DIR/cost-cli-backtest.txt" &&
     grep -q '^range held the actual in 50.0% (1 of 2)$' "$EVIDENCE_DIR/cost-cli-backtest.txt" &&
     grep -q '^too few to mean much: 2 of the 20 scored sessions a meaningful number needs$' "$EVIDENCE_DIR/cost-cli-backtest.txt" && echo 0 || echo 1)" \
  "three lines"
ROWS="$(grep -c '^ses_' "$EVIDENCE_DIR/cost-cli-backtest.txt")"
check "--rows prints one line per scored session" "$([ "$ROWS" = "2" ] && echo 0 || echo 1)" "rows=$ROWS"

cli capped run "fix the parser regression" --repo "$REPO" --cap-at-prediction
RC=$?
check "factory run --cap-at-prediction runs" "$([ "$RC" = "0" ] && echo 0 || echo 1)" "exit=$RC"
check "it printed the prediction before the session existed" \
  "$(head -1 "$EVIDENCE_DIR/cost-cli-capped.txt" | grep -q '^predicted \$0.0200 to \$0.0370, median \$0.0250, from 4 sessions (repo+model+shape; fix on faux/faux-1)$' && echo 0 || echo 1)" \
  "first line"
check "and capped the session at the predicted high" \
  "$(grep -q '^budget \$0.0370 (the predicted high)$' "$EVIDENCE_DIR/cost-cli-capped.txt" && echo 0 || echo 1)" \
  "budget line"
CAPPED="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/cost-cli-capped.txt" | head -1)"
MODE=cap API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" CAPPED="$CAPPED" CAP="0.037" \
  bun "$ROOT/.pi/skills/verify-api/cost.ts" > "$RUN_DIR/capped.log" 2>&1
CAP_RC=$?
cat "$RUN_DIR/capped.log"
check "the server holds the cap the CLI printed" "$([ "$CAP_RC" = "0" ] && echo 0 || echo 1)" "session=$CAPPED"

cli plain run "fix the parser again" --repo "$REPO"
RC=$?
check "a plain factory run prints the prediction and sets no cap" \
  "$([ "$RC" = "0" ] && head -1 "$EVIDENCE_DIR/cost-cli-plain.txt" | grep -q '^predicted \$' && ! grep -q '^budget ' "$EVIDENCE_DIR/cost-cli-plain.txt" && echo 0 || echo 1)" \
  "exit=$RC"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "database": "%s",\n' "$SCRATCH_DB"
  printf '  "repo": "%s",\n' "$REPO"
  printf '  "cappedSession": "%s",\n' "$CAPPED"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/cost-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "cost: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "cost: FAILURES — see $EVIDENCE_DIR/cost-process.json" >&2
fi
exit "$failed"
