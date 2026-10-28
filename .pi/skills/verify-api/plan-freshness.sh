#!/usr/bin/env bash
# Prove plan freshness (LOB-45): a signed merged-PR delivery to `POST /webhooks/github`, with
# `PLAN_FRESHNESS=merged`, files exactly one plan revision on the card's spec session — proposals to
# add, re-scope or close against the children of the delegating Linear issue (a fixture plan in the
# loopback `linear-api-fake.ts`) — and nothing else: every table's fingerprint is unchanged but the
# spec session's own log and activity row, the delivery's dedupe row and the merged session's own
# workspace release; Linear sees one read and no write; a redelivery files nothing and calls nothing;
# declining sends nothing; approving a later revision lands each proposal once.
#
# This script owns its own API instance, its own Linear fake, session root, logs, pid files and
# database. The API runs with a faux model (`FAUX_SPEC` declares the spec, `FAUX_COST` prices each
# call so the drive can see a call happen in the spec session's ledger, `PLAN_FRESHNESS_MAX_COST`
# above it), `LINEAR_API_KEY` set and `LINEAR_API_URL` on the fake. It leaves nothing running.
#
#   DATABASE_URL=… ./plan-freshness.sh
#   DATABASE_URL=… PLAN_PORT=9530 PLAN_LINEAR_PORT=9531 ./plan-freshness.sh
#
# Env: DATABASE_URL (required — it names the *server*; the drive mints its own database on it),
# PLAN_PORT (the API, 9433 when unset), PLAN_LINEAR_PORT (the Linear fake, 9434), EVIDENCE_DIR.
#
# What the fake cannot prove: that Linear answers the plan query as spelled, or accepts the re-scope
# and close writes. See `docs/testing-third-parties.md`.
#
# Evidence: .verify/evidence/latest/api/plan-freshness.json (every check, each delivery's answer,
# the revisions and the fake's ledger), plan-freshness-process.json, the API's and the fake's logs.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${PLAN_PORT:-9433}"
LINEAR_PORT="${PLAN_LINEAR_PORT:-9434}"
API_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/plan-freshness"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
# The specifier's one `spec` call: two criteria, no gaps. The fixture plan covers the first (done) and
# carries an issue no criterion asks for, so the faux's derived reading adds the second and closes it.
SPEC='{"goal":"Keep the plan fresh","acceptance":["the schema exists","the RPC answers"],"gaps":[],"openQuestions":[]}'
SECRET="plan-freshness-drive-secret"
RUN_STAMP="$(date +%s)$(printf '%03d' $((RANDOM % 1000)))"
PARENT="PLAN-$RUN_STAMP"
CHILDREN="[{\"parent\":\"$PARENT\",\"title\":\"the schema exists\",\"state\":\"Done\",\"description\":\"- [x] the schema exists\"},{\"parent\":\"$PARENT\",\"title\":\"a dashboard nobody asked for\",\"description\":\"- [ ] it renders\"}]"
LEDGER="$RUN_DIR/linear-ledger.json"
LINEAR_PID_FILE="$RUN_DIR/linear.pid"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "plan-freshness.sh needs DATABASE_URL naming the Postgres server to mint its database on" >&2
  exit 1
fi
SERVER_URL="$DATABASE_URL"
SCRATCH_DB="factory_verify_plan_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

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
    echo "port $port is already in use — set PLAN_PORT and PLAN_LINEAR_PORT to free ones" >&2
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
    echo "plan-freshness.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
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

scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "plan-freshness.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DATABASE_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
export DATABASE_URL
echo "plan-freshness: drive database $SCRATCH_DB (dropped on exit)"
rm -rf "$RUN_DIR/sessions"

# The loopback Linear, before the API: the API's boot log names it, and the drive reads its ledger.
rm -f "$LEDGER"
: > "$RUN_DIR/linear-fake.log"
( exec env LINEAR_FAKE_PORT="$LINEAR_PORT" LINEAR_FAKE_LEDGER="$LEDGER" LINEAR_FAKE_CHILDREN="$CHILDREN" \
    bun "$ROOT/.pi/skills/verify-api/linear-api-fake.ts" ) >> "$RUN_DIR/linear-fake.log" 2>&1 &
echo $! > "$LINEAR_PID_FILE"
for _ in $(seq 1 60); do
  [ -s "$LEDGER" ] && break
  sleep 0.1
done
[ -s "$LEDGER" ] || { echo "the Linear fake did not start — see $RUN_DIR/linear-fake.log" >&2; exit 1; }

# A long idle timeout, so every read is served by the owner the pass used.
: > "$LOG"
( cd "$ROOT/apps/api" && exec env \
    PORT="$PORT" \
    HOST="127.0.0.1" \
    MODEL_BACKEND=faux \
    FAUX_SPEC="[$SPEC]" \
    FAUX_COST=0.01 \
    PLAN_FRESHNESS=merged \
    PLAN_FRESHNESS_MAX_COST=0.05 \
    GITHUB_WEBHOOK_SECRET="$SECRET" \
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
  LINEAR_FAKE_LEDGER="$LEDGER" LINEAR_PARENT="$PARENT" GITHUB_WEBHOOK_SECRET="$SECRET" \
  bun "$ROOT/.pi/skills/verify-api/plan-freshness.ts" > "$RUN_DIR/driver.log" 2>&1
DRIVER_RC=$?
cat "$RUN_DIR/driver.log"
check "the driver passes its checks" "$([ "$DRIVER_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVER_RC"

check "one API process served the whole drive" \
  "$(kill -0 "$API_PID" 2>/dev/null && curl -sf -m 2 "$API_URL/livez" >/dev/null && echo 0 || echo 1)" \
  "pid=$API_PID"

# A reader that is neither the API nor the driver: the fake's ledger. Before any approval the API sent
# Linear only reads; the one approval's writes are the close and the add, once each.
WRITES="$(bun -e '
  const ledger = await Bun.file(process.argv[1]).json();
  const reads = new Set(["issue", "issueChildren", "issueRelations", "issuePlan"]);
  const ops = ledger.requests.map((r) => r.operation);
  const firstWrite = ops.findIndex((op) => !reads.has(op));
  const before = firstWrite < 0 ? ops : ops.slice(0, firstWrite);
  const writes = ops.filter((op) => !reads.has(op)).sort().join(",");
  console.log(`${before.filter((op) => op === "issuePlan").length} ${writes}`);
' "$LEDGER" 2>/dev/null || echo "-1 none")"
check "two plan reads before any write, then one comment, one close and one create" \
  "$([ "$WRITES" = "2 commentCreate,issueCreate,issueUpdate" ] && echo 0 || echo 1)" "plan-reads/writes=$WRITES"

cp "$LOG" "$EVIDENCE_DIR/plan-freshness-api.log"
cp "$LEDGER" "$EVIDENCE_DIR/plan-freshness-linear-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/linear-fake.log" "$EVIDENCE_DIR/plan-freshness-linear-fake.log" 2>/dev/null || true
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "database": "%s",\n' "$SCRATCH_DB"
  printf '  "parentIssue": "%s",\n' "$PARENT"
  printf '  "planReads/writes": "%s",\n' "$WRITES"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/plan-freshness-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "plan-freshness: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "plan-freshness: FAILURES — see $EVIDENCE_DIR/plan-freshness-process.json" >&2
fi
exit "$failed"
