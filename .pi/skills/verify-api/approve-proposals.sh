#!/usr/bin/env bash
# Prove the approval surface (LOB-202): a specifier run delegated from a Linear issue proposes three
# child issues, and `approveProposals` over the real Effect RPC client creates only the approved ones
# in a loopback Linear (`linear-api-fake.ts`) — as children of the delegating issue, in its team —
# with the `blockedBy` edges whose two ends exist, and creates nothing a second time.
#
# This script owns its own API instance, its own Linear fake, session root, logs and pid files. The
# API runs with `LINEAR_API_KEY` set and `LINEAR_API_URL` on the fake, so the process under test is
# the one a deployment with a Linear key runs; a faux specifier (`FAUX_SPEC`) declares a spec with no
# gaps and `FAUX_DECOMPOSITION` scripts the three proposals and their edges. It leaves nothing running.
#
#   DATABASE_URL=… ./approve-proposals.sh
#   DATABASE_URL=… APPROVE_PORT=9521 APPROVE_LINEAR_PORT=9522 ./approve-proposals.sh
#
# Env: DATABASE_URL (required — it names the *server*; the drive mints its own database on it),
# APPROVE_PORT (the API, 9428 when unset), APPROVE_LINEAR_PORT (the Linear fake, 9429), EVIDENCE_DIR.
#
# What the fake cannot prove: that Linear accepts these documents as spelled, validates the team and
# parent as it does, or renders the children as sub-issues. See `docs/testing-third-parties.md`.
#
# Evidence: .verify/evidence/latest/api/approve-proposals.json (every check, each approval's answer
# and the fake's whole ledger), approve-proposals-process.json (this script's checks), the API's and
# the fake's logs.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${APPROVE_PORT:-9428}"
LINEAR_PORT="${APPROVE_LINEAR_PORT:-9429}"
API_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/approve-proposals"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
# The specifier's one `spec` call: a spec with no gaps, so the run never parks and the spec is ready
# to decompose. Two criteria, so the derived faux decomposition proposes two issues.
SPEC='{"goal":"Approve proposals into tracker issues","acceptance":["A: the schema holds","B: the service holds","C: the RPC holds"],"gaps":[],"openQuestions":[]}'
# Three proposals with edges the derived answer would not make: B is blocked by A, C by A and B.
DECOMPOSITION='{"proposals":[{"title":"A: the schema","goal":"g","change":"c","acceptance":["a"],"blockedBy":[]},{"title":"B: the service","goal":"g","change":"c","acceptance":["b"],"blockedBy":[0]},{"title":"C: the RPC","goal":"g","change":"c","acceptance":["c"],"blockedBy":[0,1]}]}'
RUN_STAMP="$(date +%s)$(printf '%03d' $((RANDOM % 1000)))"
PARENT="DRIVE-$RUN_STAMP"
LEDGER="$RUN_DIR/linear-ledger.json"
LINEAR_PID_FILE="$RUN_DIR/linear.pid"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "approve-proposals.sh needs DATABASE_URL naming the Postgres server to mint its database on" >&2
  exit 1
fi
SERVER_URL="$DATABASE_URL"
SCRATCH_DB="factory_verify_approve_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

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

for port in "$PORT" "$LINEAR_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set APPROVE_PORT and APPROVE_LINEAR_PORT to free ones" >&2
    exit 1
  fi
done

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
    echo "approve-proposals.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
}

stop_linear() {
  [ -f "$LINEAR_PID_FILE" ] || return 0
  local pid; pid="$(cat "$LINEAR_PID_FILE")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$LINEAR_PID_FILE"
}

trap 'stop_api; stop_linear; drop_scratch' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "approve-proposals.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DATABASE_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
export DATABASE_URL
echo "approve-proposals: drive database $SCRATCH_DB (dropped on exit)"
rm -rf "$RUN_DIR/sessions"

# The loopback Linear, before the API: the API's boot log names it, and the drive reads its ledger.
rm -f "$LEDGER"
: > "$RUN_DIR/linear-fake.log"
( exec env LINEAR_FAKE_PORT="$LINEAR_PORT" LINEAR_FAKE_LEDGER="$LEDGER" \
    bun "$ROOT/.pi/skills/verify-api/linear-api-fake.ts" ) >> "$RUN_DIR/linear-fake.log" 2>&1 &
echo $! > "$LINEAR_PID_FILE"
for _ in $(seq 1 60); do
  [ -s "$LEDGER" ] && break
  sleep 0.1
done
[ -s "$LEDGER" ] || { echo "the Linear fake did not start — see $RUN_DIR/linear-fake.log" >&2; exit 1; }

# A long idle timeout: every read must be served by the owner the decomposition used, so a release
# in the middle cannot be what makes a read pass or fail.
: > "$LOG"
( cd "$ROOT/apps/api" && exec env \
    PORT="$PORT" \
    HOST="127.0.0.1" \
    MODEL_BACKEND=faux \
    FAUX_SPEC="[$SPEC]" \
    FAUX_DECOMPOSITION="$DECOMPOSITION" \
    LINEAR_API_KEY="lin_api_drive" \
    LINEAR_API_URL="http://127.0.0.1:$LINEAR_PORT/graphql" \
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
  LINEAR_FAKE_LEDGER="$LEDGER" LINEAR_PARENT="$PARENT" \
  bun "$ROOT/.pi/skills/verify-api/approve-proposals.ts" > "$RUN_DIR/driver.log" 2>&1
DRIVER_RC=$?
cat "$RUN_DIR/driver.log"
check "the driver passes its checks" "$([ "$DRIVER_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVER_RC"

check "one API process served the whole drive" \
  "$(kill -0 "$API_PID" 2>/dev/null && curl -sf -m 2 "$API_URL/livez" >/dev/null && echo 0 || echo 1)" \
  "pid=$API_PID"

# A reader that is neither the API nor the driver: the fake's ledger file holds every request the
# API made, and a created issue appears in it once per proposal title.
CREATES="$(bun -e '
  const ledger = await Bun.file(process.argv[1]).json();
  const titles = ledger.children.map((child) => child.title);
  console.log(`${ledger.requests.filter((r) => r.operation === "issueCreate").length} ${new Set(titles).size} ${titles.length}`);
' "$LEDGER" 2>/dev/null || echo "-1 -1 -1")"
check "three issueCreate requests made three distinct issues, none twice" \
  "$([ "$CREATES" = "3 3 3" ] && echo 0 || echo 1)" "requests/distinct/children=$CREATES"

cp "$LOG" "$EVIDENCE_DIR/approve-proposals-api.log"
cp "$LEDGER" "$EVIDENCE_DIR/approve-proposals-linear-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/linear-fake.log" "$EVIDENCE_DIR/approve-proposals-linear-fake.log" 2>/dev/null || true
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "database": "%s",\n' "$SCRATCH_DB"
  printf '  "parentIssue": "%s",\n' "$PARENT"
  printf '  "issueCreates/distinct/children": "%s",\n' "$CREATES"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/approve-proposals-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "approve-proposals: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "approve-proposals: FAILURES — see $EVIDENCE_DIR/approve-proposals-process.json" >&2
fi
exit "$failed"
