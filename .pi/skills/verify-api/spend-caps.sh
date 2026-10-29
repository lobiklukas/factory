#!/usr/bin/env bash
# Prove aggregate spend caps (S-aggregate-spend-caps): with SPEND_CAPS giving a repo and an actor a
# daily cap, crossing 80% of the repo's cap creates one attention item and one notification, reaching
# it creates the 100% one, and then a new run on that repo (createSession, sendMessage, a signed
# delivery) is refused budget_exceeded — typed, naming the cap and its key — while a run on another
# repo is not, and an actor over their own cap is refused everywhere and another actor is not.
#
# This script owns everything it drives: a scratch database minted on DATABASE_URL's server (so the
# spend the caps count is this drive's and nothing else), the loopback ntfy fake (`notify-fake.ts`),
# and the API, on a priced faux model so a run costs a known two cents. It leaves nothing running and
# drops the database.
#
#   DATABASE_URL=... ./spend-caps.sh
#   DATABASE_URL=... SPEND_PORT=9520 SPEND_FAKE_PORT=9521 ./spend-caps.sh
#
# Env: DATABASE_URL (required — it names the *server*), SPEND_PORT (the API, 9456 when unset),
# SPEND_FAKE_PORT (the fake, 9457), SPEND_LINK_BASE (the dashboard origin links start with,
# http://127.0.0.1:3100 when unset; nothing needs to listen there), EVIDENCE_DIR.
#
# What the fake cannot prove: that ntfy accepts this JSON publish or delivers it to a phone. See
# docs/testing-third-parties.md.
#
# Evidence: .verify/evidence/latest/api/spend-caps.json (every check the driver made, the refusals,
# the attention items, the webhook answer), spend-caps-process.json (this script's checks),
# spend-caps-ledger.json (every message the fake received) and spend-caps-api.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${SPEND_PORT:-9456}"
FAKE_PORT="${SPEND_FAKE_PORT:-9457}"
LINK_BASE="${SPEND_LINK_BASE:-http://127.0.0.1:3100}"
API_URL="http://127.0.0.1:$PORT"
FAKE_URL="http://127.0.0.1:$FAKE_PORT"
RUN_DIR="$ROOT/.verify/run/spend-caps"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
LEDGER="$RUN_DIR/notify-ledger.json"
FAKE_PID_FILE="$RUN_DIR/fake.pid"
STAMP="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TOPIC="factory-spend-$STAMP"
SECRET="verify-spend-secret"
REPO_WEB="verify-$STAMP/spend-web"
REPO_DOCS="verify-$STAMP/spend-docs"
ACTOR_CAROL="carol-$STAMP"
ACTOR_AMY="amy-$STAMP"
ACTOR_BOB="bob-$STAMP"
CAPS="{\"repos\":{\"$REPO_WEB\":{\"daily\":0.025}},\"actors\":{\"$ACTOR_CAROL\":{\"daily\":0.015}}}"
POLL_MS=300
if [ -z "${DATABASE_URL:-}" ]; then
  echo "spend-caps.sh needs DATABASE_URL naming the Postgres server to mint its database on" >&2
  exit 1
fi
SERVER_URL="$DATABASE_URL"
SCRATCH_DB="factory_verify_spend_$STAMP"

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

for port in "$PORT" "$FAKE_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set SPEND_PORT and SPEND_FAKE_PORT to free ones" >&2
    exit 1
  fi
done

stop_pid() { # pidfile
  [ -f "$1" ] || return 0
  local pid; pid="$(cat "$1")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$1"
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
    echo "spend-caps.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
}

trap 'stop_pid "$RUN_DIR/api.pid"; stop_pid "$FAKE_PID_FILE"; drop_scratch' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "spend-caps.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DATABASE_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
export DATABASE_URL
echo "spend-caps: drive database $SCRATCH_DB (dropped on exit)"
rm -rf "$RUN_DIR/sessions"

rm -f "$LEDGER"
: > "$RUN_DIR/fake.log"
( exec env NOTIFY_FAKE_PORT="$FAKE_PORT" NOTIFY_FAKE_LEDGER="$LEDGER" \
    bun "$ROOT/.pi/skills/verify-api/notify-fake.ts" ) >> "$RUN_DIR/fake.log" 2>&1 &
echo $! > "$FAKE_PID_FILE"
for _ in $(seq 1 60); do
  [ -s "$LEDGER" ] && break
  sleep 0.1
done
[ -s "$LEDGER" ] || { echo "the notify fake did not start — see $RUN_DIR/fake.log" >&2; exit 1; }

start_api() {
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      FAUX_COST=0.01 \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      DATABASE_URL="$DATABASE_URL" \
      SPEND_CAPS="$CAPS" \
      TRIGGER_SECRET="$SECRET" \
      TRIGGER_RULES="[{\"label\":\"factory\",\"repo\":\"$REPO_WEB\",\"baseRef\":\"main\",\"prompt\":\"Work on {{title}}: {{body}}\"}]" \
      NOTIFY_LINK_BASE="$LINK_BASE" \
      NOTIFY_POLL_MS="$POLL_MS" \
      NOTIFY_NTFY_URL="$FAKE_URL" \
      NOTIFY_NTFY_TOPIC="$TOPIC" \
      bun run src/index.ts ) >> "$LOG" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
  for _ in $(seq 1 60); do
    curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "api did not become ready — see $LOG" >&2
  return 1
}

: > "$LOG"
start_api || exit 1

check "the boot names the capped repositories and actors" \
  "$(grep -q "spend caps: 1 repository and 1 actor capped per UTC day or month (SPEND_CAPS)" "$LOG" && echo 0 || echo 1)" \
  "boot line"

API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" NOTIFY_FAKE_LEDGER="$LEDGER" LINK_BASE="$LINK_BASE" \
  TRIGGER_SECRET="$SECRET" SPEND_REPO_WEB="$REPO_WEB" SPEND_REPO_DOCS="$REPO_DOCS" \
  SPEND_ACTOR_CAROL="$ACTOR_CAROL" SPEND_ACTOR_AMY="$ACTOR_AMY" SPEND_ACTOR_BOB="$ACTOR_BOB" \
  bun "$ROOT/.pi/skills/verify-api/spend-caps.ts" > "$RUN_DIR/driver.log" 2>&1
DRIVER_RC=$?
cat "$RUN_DIR/driver.log"
check "the driver passes its checks" "$([ "$DRIVER_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVER_RC"

check "the API log records the refusal on the trigger route" \
  "$(grep -q 'webhook /webhooks/generic: refused at-capacity' "$LOG" && echo 0 || echo 1)" \
  "refused at-capacity"
check "the API log says each threshold once" \
  "$([ "$(grep -c "spend: repo $REPO_WEB reached" "$LOG")" = "2" ] && echo 0 || echo 1)" \
  "lines=$(grep -c "spend: repo $REPO_WEB reached" "$LOG")"

leaks=0
for secret in "$TOPIC"; do
  grep -qF "$secret" "$LOG" && leaks=$((leaks + 1))
done
check "the API's log names no ntfy topic" "$([ "$leaks" = "0" ] && echo 0 || echo 1)" "leaks=$leaks"
REFUSED="$(bun -e 'const l = await Bun.file(process.argv[1]).json(); console.log(l.refused.length)' "$LEDGER" 2>/dev/null || echo -1)"
check "the API called no route the fake does not serve" "$([ "$REFUSED" = "0" ] && echo 0 || echo 1)" "refused=$REFUSED"

cp "$LOG" "$EVIDENCE_DIR/spend-caps-api.log"
cp "$LEDGER" "$EVIDENCE_DIR/spend-caps-ledger.json" 2>/dev/null || true
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "database": "%s",\n' "$SCRATCH_DB"
  printf '  "caps": %s,\n' "$CAPS"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/spend-caps-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "spend-caps: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "spend-caps: FAILURES — see $EVIDENCE_DIR/spend-caps-process.json" >&2
fi
exit "$failed"
