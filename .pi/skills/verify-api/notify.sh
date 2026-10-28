#!/usr/bin/env bash
# Prove the notifier (S-notifications): a parked question, a pending approval, a run its budget
# stopped and a run whose model request failed (on `faux/faulted`, a faux model whose script fails
# every request — F6's `fail`) each reach a person exactly once — on a Slack incoming webhook and on an ntfy topic, both
# the loopback fake (`notify-fake.ts`) — with a link to the card; a restarted API sends none of them
# again; and `NOTIFY_TYPES` keeps a kind it leaves out off a sink.
#
# This script owns everything it drives: a scratch database minted on DATABASE_URL's server (so the
# fake's ledger holds this drive's messages and nothing else, and "four messages" is a count), the
# fake, and the API — booted three times over that database: twice with both sinks (the restart),
# then with `NOTIFY_TYPES=question,failed` and a fresh ntfy topic. The model is a priced faux so a
# one-cent cap is reachable. It leaves nothing running and drops the database.
#
#   DATABASE_URL=… ./notify.sh
#   DATABASE_URL=… NOTIFY_PORT=9550 NOTIFY_FAKE_PORT=9551 NOTIFY_LINK_BASE=http://127.0.0.1:3550 ./notify.sh
#
# Env: DATABASE_URL (required — it names the *server*), NOTIFY_PORT (the API, 9446 when unset),
# NOTIFY_FAKE_PORT (the fake, 9447), NOTIFY_LINK_BASE (the dashboard origin links start with,
# http://127.0.0.1:3100 when unset; nothing needs to listen there), EVIDENCE_DIR.
#
# What the fake cannot prove: that Slack accepts this webhook body or renders its mrkdwn link as a
# link, that ntfy accepts this JSON publish or delivers it to a phone. See docs/testing-third-parties.md.
#
# Evidence: .verify/evidence/latest/api/notify-{seed,restart,toggled}.json (each phase's checks, ids
# and the ledger), notify-process.json (this script's checks), notify-ledger.json (every message the
# fake received), notify-api.log (all three boots).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${NOTIFY_PORT:-9446}"
FAKE_PORT="${NOTIFY_FAKE_PORT:-9447}"
LINK_BASE="${NOTIFY_LINK_BASE:-http://127.0.0.1:3100}"
API_URL="http://127.0.0.1:$PORT"
FAKE_URL="http://127.0.0.1:$FAKE_PORT"
RUN_DIR="$ROOT/.verify/run/notify"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
LEDGER="$RUN_DIR/notify-ledger.json"
STATE="$RUN_DIR/notify-state.json"
FAKE_PID_FILE="$RUN_DIR/fake.pid"
STAMP="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
# The webhook's path and the topics stand in for secrets: the drive checks the API's log never names them.
WEBHOOK_PATH="/slack/services/T0DRIVE/B0DRIVE/hook-$STAMP"
TOPIC="factory-drive-$STAMP"
TOGGLED_TOPIC="factory-drive-toggled-$STAMP"
NTFY_TOKEN="tk_drive_$STAMP"
POLL_MS=300
if [ -z "${DATABASE_URL:-}" ]; then
  echo "notify.sh needs DATABASE_URL naming the Postgres server to mint its database on" >&2
  exit 1
fi
SERVER_URL="$DATABASE_URL"
SCRATCH_DB="factory_verify_notify_$STAMP"

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
    echo "port $port is already in use — set NOTIFY_PORT and NOTIFY_FAKE_PORT to free ones" >&2
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
    echo "notify.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
}

trap 'stop_pid "$RUN_DIR/api.pid"; stop_pid "$FAKE_PID_FILE"; drop_scratch' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "notify.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DATABASE_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
export DATABASE_URL
echo "notify: drive database $SCRATCH_DB (dropped on exit)"
rm -rf "$RUN_DIR/sessions"

rm -f "$LEDGER" "$STATE"
: > "$RUN_DIR/fake.log"
( exec env NOTIFY_FAKE_PORT="$FAKE_PORT" NOTIFY_FAKE_LEDGER="$LEDGER" \
    bun "$ROOT/.pi/skills/verify-api/notify-fake.ts" ) >> "$RUN_DIR/fake.log" 2>&1 &
echo $! > "$FAKE_PID_FILE"
for _ in $(seq 1 60); do
  [ -s "$LEDGER" ] && break
  sleep 0.1
done
[ -s "$LEDGER" ] || { echo "the notify fake did not start — see $RUN_DIR/fake.log" >&2; exit 1; }

start_api() { # extra env assignments…
  # Names only: the values are the secrets the log must not carry.
  echo "=== boot: $(printf '%s\n' "$@" | sed 's/=.*//' | tr '\n' ' ')===" >> "$LOG"
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      FAUX_COST=0.01 \
      ROLE_MODELS="faulted=faux/faulted" \
      FAUX_MODEL_SCRIPTS='{"faulted":{"fail":"model_error"}}' \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      DATABASE_URL="$DATABASE_URL" \
      NOTIFY_LINK_BASE="$LINK_BASE" \
      NOTIFY_POLL_MS="$POLL_MS" \
      NOTIFY_NTFY_URL="$FAKE_URL" \
      NOTIFY_NTFY_TOKEN="$NTFY_TOKEN" \
      "$@" \
      bun run src/index.ts ) >> "$LOG" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
  for _ in $(seq 1 60); do
    curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "api did not become ready — see $LOG" >&2
  return 1
}

drive() { # phase, topic
  API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" DATABASE_URL="$DATABASE_URL" PHASE="$1" \
    NOTIFY_FAKE_LEDGER="$LEDGER" NOTIFY_STATE="$STATE" LINK_BASE="$LINK_BASE" TOPIC="$2" \
    NTFY_TOKEN="$NTFY_TOKEN" \
    bun "$ROOT/.pi/skills/verify-api/notify.ts" > "$RUN_DIR/driver-$1.log" 2>&1
  local rc=$?
  cat "$RUN_DIR/driver-$1.log"
  check "the $1 phase passes its checks" "$([ "$rc" = "0" ] && echo 0 || echo 1)" "exit=$rc"
}

: > "$LOG"

# --- 1. both sinks: the four events, once each ----------------------------------------------------
start_api NOTIFY_SLACK_WEBHOOK_URL="$FAKE_URL$WEBHOOK_PATH" NOTIFY_NTFY_TOPIC="$TOPIC" || exit 1
check "the boot names both sinks, every kind, the interval and the links" \
  "$(grep -q "notifications: question, approval, gate, failed to a Slack incoming webhook and ntfy at $FAKE_URL, every ${POLL_MS}ms, linking to $LINK_BASE" "$LOG" && echo 0 || echo 1)" \
  "boot line"
drive seed "$TOPIC"
check "the API logged each delivery" \
  "$([ "$(grep -c 'notify: .* sent to ' "$LOG")" -ge 6 ] && echo 0 || echo 1)" \
  "sent lines=$(grep -c 'notify: .* sent to ' "$LOG")"
stop_pid "$RUN_DIR/api.pid"

# --- 2. the same configuration, restarted: nothing again ------------------------------------------
start_api NOTIFY_SLACK_WEBHOOK_URL="$FAKE_URL$WEBHOOK_PATH" NOTIFY_NTFY_TOPIC="$TOPIC" || exit 1
drive restart "$TOPIC"
stop_pid "$RUN_DIR/api.pid"

# --- 3. NOTIFY_TYPES leaves approvals out, on a fresh topic ----------------------------------------
start_api NOTIFY_NTFY_TOPIC="$TOGGLED_TOPIC" NOTIFY_TYPES="question,failed" || exit 1
check "the toggled boot names only the kinds it was given" \
  "$(grep -q "notifications: question, failed to ntfy at $FAKE_URL" "$LOG" && echo 0 || echo 1)" \
  "boot line"
drive toggled "$TOGGLED_TOPIC"
stop_pid "$RUN_DIR/api.pid"

# A reader that is neither the API nor the driver: the API's log over all three boots names no
# destination secret.
leaks=0
for secret in "$WEBHOOK_PATH" "$TOPIC" "$TOGGLED_TOPIC" "$NTFY_TOKEN"; do
  grep -qF "$secret" "$LOG" && leaks=$((leaks + 1))
done
check "the API's log names no webhook path, topic or token" "$([ "$leaks" = "0" ] && echo 0 || echo 1)" "leaks=$leaks"
REFUSED="$(bun -e 'const l = await Bun.file(process.argv[1]).json(); console.log(l.refused.length)' "$LEDGER" 2>/dev/null || echo -1)"
check "the API called no route the fake does not serve" "$([ "$REFUSED" = "0" ] && echo 0 || echo 1)" "refused=$REFUSED"

cp "$LOG" "$EVIDENCE_DIR/notify-api.log"
cp "$LEDGER" "$EVIDENCE_DIR/notify-ledger.json" 2>/dev/null || true
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "database": "%s",\n' "$SCRATCH_DB"
  printf '  "linkBase": "%s",\n' "$LINK_BASE"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/notify-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "notify: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "notify: FAILURES — see $EVIDENCE_DIR/notify-process.json" >&2
fi
exit "$failed"
