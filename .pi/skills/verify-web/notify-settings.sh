#!/usr/bin/env bash
# Prove the notification settings page (F21) and the retention sweep (F22): a person adds an email
# address and this browser's Web Push subscription on /notifications; an event for a card they own
# reaches those sinks once (and one for a card somebody else owns reaches neither); a kind switched
# off on the page stops its events with no restart; a paused sink is skipped; and delivered
# notifications and run failures older than the retention window are deleted on a restart's first
# poll while undelivered, recent and in-window rows survive.
#
# This script owns everything it drives: a scratch database minted on DATABASE_URL's server (so the
# fakes' ledger holds this drive's messages and nothing else), the loopback fakes
# (`verify-api/notify-fake.ts`: an SMTP server and a Web Push service — never a real mail or push
# provider), the API and the dashboard. It leaves nothing running and drops the database.
#
#   DATABASE_URL=… ./notify-settings.sh
#   DATABASE_URL=… NS_API_PORT=9560 NS_WEB_PORT=3560 NS_FAKE_PORT=9561 NS_SMTP_PORT=9562 ./notify-settings.sh
#
# Env: DATABASE_URL (required — it names the *server*), NS_API_PORT (9448), NS_WEB_PORT (3448),
# NS_FAKE_PORT (9449), NS_SMTP_PORT (9450), EVIDENCE_DIR.
#
# What the fakes cannot prove: that a real SMTP provider accepts this message, that a browser
# vendor's push service accepts this request or that a real browser shows the notification. The
# browser's `PushManager.subscribe` is stubbed (it would call the vendor's push service). See
# docs/testing-third-parties.md.
#
# Evidence: .verify/evidence/latest/notify-settings/ — notifications-*.png, observed.json (the
# drive's checks), retention.json (the sweep's), ledger.json (every message the fakes received),
# api.log, web.log.
set -uo pipefail

# This suite runs its API with auth off (LOB-20): the page declares its own actor (`dashboard`), which
# only an open control plane keeps. A token exported for the other skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${NS_API_PORT:-9448}"
WEB_PORT="${NS_WEB_PORT:-3448}"
FAKE_PORT="${NS_FAKE_PORT:-9449}"
SMTP_PORT="${NS_SMTP_PORT:-9450}"
POLL_MS=300
# Half-second tries before an instance is called not ready: a busy machine takes minutes to start vite.
READY_TRIES="${NS_READY_TRIES:-360}"
RUN_DIR="$ROOT/.verify/run/notify-settings"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/notify-settings"
LEDGER="$RUN_DIR/ledger.json"
STAMP="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "notify-settings.sh needs DATABASE_URL naming the Postgres server to mint its database on" >&2
  exit 1
fi
SERVER_URL="$DATABASE_URL"
SCRATCH_DB="factory_verify_notify_settings_$STAMP"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT" "$FAKE_PORT" "$SMTP_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set NS_API_PORT / NS_WEB_PORT / NS_FAKE_PORT / NS_SMTP_PORT to free ones" >&2
    exit 1
  fi
done

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-70s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-70s %s\n' "$1" "$3"
  fi
}

stop_pid() { # pidfile
  [ -f "$1" ] || return 0
  local pid; pid="$(cat "$1")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$1"
}

scratch_sql() { # server-level statement, over TCP
  bun -e '
    const sql = new Bun.SQL(process.argv[1]);
    try { await sql.unsafe(process.argv[2]); } finally { await sql.close(); }
  ' "$SERVER_URL" "$1"
}
SCRATCH_CREATED=0
drop_scratch() {
  [ "$SCRATCH_CREATED" = "1" ] || return 0
  scratch_sql "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE)" >/dev/null 2>&1 ||
    echo "notify-settings.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
}

cleanup() {
  stop_pid "$RUN_DIR/web.pid"
  stop_pid "$RUN_DIR/api.pid"
  stop_pid "$RUN_DIR/fake.pid"
  cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/api.log" 2>/dev/null || true
  cp "$RUN_DIR/web.log" "$EVIDENCE_DIR/web.log" 2>/dev/null || true
  cp "$LEDGER" "$EVIDENCE_DIR/ledger.json" 2>/dev/null || true
  rm -rf "$RUN_DIR/sessions"
  drop_scratch
}
trap cleanup EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "notify-settings.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DATABASE_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
export DATABASE_URL
echo "notify-settings: drive database $SCRATCH_DB (dropped on exit)"
rm -rf "$RUN_DIR/sessions"

# The deployment's VAPID key pair, made the way an operator makes one. The private half stands in for
# a secret: the drive checks the API's log never names it.
VAPID="$(cd "$ROOT" && bun -e 'import { generateVapidKeys } from "@repo/core"; console.log(JSON.stringify(generateVapidKeys()))')"
VAPID_PUBLIC_KEY="$(printf '%s' "$VAPID" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).publicKey)')"
VAPID_PRIVATE_KEY="$(printf '%s' "$VAPID" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).privateKey)')"

rm -f "$LEDGER"
: > "$RUN_DIR/fake.log"
( exec env NOTIFY_FAKE_PORT="$FAKE_PORT" NOTIFY_FAKE_SMTP_PORT="$SMTP_PORT" NOTIFY_FAKE_LEDGER="$LEDGER" \
    bun "$ROOT/.pi/skills/verify-api/notify-fake.ts" ) >> "$RUN_DIR/fake.log" 2>&1 &
echo $! > "$RUN_DIR/fake.pid"
for _ in $(seq 1 60); do
  [ -s "$LEDGER" ] && break
  sleep 0.1
done
[ -s "$LEDGER" ] || { echo "the notify fake did not start — see $RUN_DIR/fake.log" >&2; exit 1; }

LINK_BASE="http://localhost:$WEB_PORT"
: > "$RUN_DIR/api.log"
start_api() { # extra env assignments…
  echo "=== boot ===" >> "$RUN_DIR/api.log"
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$API_PORT" \
      HOST="127.0.0.1" \
      ALLOWED_ORIGINS="$LINK_BASE" \
      MODEL_BACKEND=faux \
      FAUX_COMMAND="echo faux-ok" \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      DATABASE_URL="$DATABASE_URL" \
      NOTIFY_LINK_BASE="$LINK_BASE" \
      NOTIFY_POLL_MS="$POLL_MS" \
      NOTIFY_SMTP_URL="smtp://127.0.0.1:$SMTP_PORT" \
      NOTIFY_SMTP_FROM="factory@drive.test" \
      NOTIFY_VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" \
      NOTIFY_VAPID_PRIVATE_KEY="$VAPID_PRIVATE_KEY" \
      NOTIFY_VAPID_SUBJECT="mailto:ops@drive.test" \
      NOTIFY_PUSH_ALLOW_INSECURE=true \
      "$@" \
      bun run src/index.ts ) >> "$RUN_DIR/api.log" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
  for _ in $(seq 1 "$READY_TRIES"); do
    curl -sf -m 1 "http://127.0.0.1:$API_PORT/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "api did not become ready — see $RUN_DIR/api.log" >&2
  return 1
}
start_api || exit 1

( cd "$ROOT/apps/web" && exec env \
    VITE_PORT="$WEB_PORT" \
    VITE_SERVER_URL="http://localhost:$API_PORT" \
    bun run dev ) > "$RUN_DIR/web.log" 2>&1 &
echo $! > "$RUN_DIR/web.pid"
ready=0
for _ in $(seq 1 "$READY_TRIES"); do
  if curl -sf -m 1 "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" -eq 1 ] || { echo "the dashboard did not become ready — see $RUN_DIR/web.log" >&2; exit 1; }

check "the boot names each person's email and Web Push, and no secret" \
  "$(grep -q "notifications: question, approval, gate, failed to each person's email and each person's Web Push, every ${POLL_MS}ms, linking to $LINK_BASE" "$RUN_DIR/api.log" && echo 0 || echo 1)" \
  "boot line"

# --- 1. the page, in a browser -----------------------------------------------------------------------
WEB_URL="http://localhost:$WEB_PORT" API_URL="http://127.0.0.1:$API_PORT" EVIDENCE_DIR="$EVIDENCE_DIR" \
  FAKE_LEDGER="$LEDGER" FAKE_URL="http://127.0.0.1:$FAKE_PORT" LINK_BASE="$LINK_BASE" \
  VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" API_PID_FILE="$RUN_DIR/api.pid" \
  node "$ROOT/.pi/skills/verify-web/notify-settings.mjs"
check "the settings drive passes its checks" "$([ "$?" = "0" ] && echo 0 || echo 1)" "notify-settings.mjs"

# --- 2. retention: a restart's first poll sweeps what is older than the window ------------------------
query() { # sql → JSON rows, over TCP
  bun -e '
    const sql = new Bun.SQL(process.argv[1]);
    try { console.log(JSON.stringify(await sql.unsafe(process.argv[2]))); } finally { await sql.close(); }
  ' "$DATABASE_URL" "$1"
}
stop_pid "$RUN_DIR/api.pid"
OLD_SES="ses_verifyold$STAMP"
query "INSERT INTO sessions (id, title) VALUES ('$OLD_SES', 'retention drive')" >/dev/null
query "INSERT INTO run_failures (session_id, entry_id, reason, detail, failed_at) VALUES
  ('$OLD_SES', 'old', 'budget', 'forty days ago', now() - interval '40 days'),
  ('$OLD_SES', 'recent', 'budget', 'two days ago', now() - interval '2 days')" >/dev/null
query "INSERT INTO notification_deliveries (event_id, sink, kind, title, body, link, created_at, attempts, delivered_at) VALUES
  ('failed:$OLD_SES:old', 'drive:retention', 'failed', 't', 'b', 'http://x/', now() - interval '40 days', 1, now() - interval '40 days'),
  ('failed:$OLD_SES:undelivered', 'drive:retention', 'failed', 't', 'b', 'http://x/', now() - interval '40 days', 1, NULL),
  ('failed:$OLD_SES:recent', 'drive:retention', 'failed', 't', 'b', 'http://x/', now() - interval '2 days', 1, now() - interval '2 days')" >/dev/null
BEFORE_MESSAGES="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).messages.length)' "$LEDGER")"
start_api NOTIFY_RETENTION_DAYS=30 || exit 1
# The first pass runs one poll after the boot, and the first pass sweeps.
SWEPT=1
for _ in $(seq 1 60); do
  LEFT="$(query "SELECT count(*)::int AS n FROM notification_deliveries WHERE sink = 'drive:retention' AND event_id = 'failed:$OLD_SES:old'" | bun -e 'console.log(JSON.parse(await Bun.stdin.text())[0].n)')"
  if [ "$LEFT" = "0" ]; then SWEPT=0; break; fi
  sleep 0.5
done
check "the first poll after a restart deletes the delivered row older than 30 days" "$SWEPT" "old row left=$LEFT"
LEDGER_ROWS="$(query "SELECT event_id, delivered_at IS NOT NULL AS delivered FROM notification_deliveries WHERE sink = 'drive:retention' ORDER BY event_id")"
FAILURE_ROWS="$(query "SELECT entry_id FROM run_failures WHERE session_id = '$OLD_SES' ORDER BY entry_id")"
AFTER_MESSAGES="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).messages.length)' "$LEDGER")"
sleep 2
check "the undelivered row and the two-day-old delivered row survive" \
  "$(printf '%s' "$LEDGER_ROWS" | bun -e 'const rows = JSON.parse(await Bun.stdin.text()).map((x) => x.event_id.split(":").at(-1) + ":" + x.delivered).sort().join(","); process.exit(rows === "recent:true,undelivered:false" ? 0 : 1)' && echo 0 || echo 1)" \
  "$(printf '%s' "$LEDGER_ROWS" | tr -d ' \n' | cut -c1-200)"
check "run failures: the forty-day-old row is deleted, the two-day-old one stays" \
  "$(printf '%s' "$FAILURE_ROWS" | bun -e 'const r = JSON.parse(await Bun.stdin.text()).map(x => x.entry_id).join(","); process.exit(r === "recent" ? 0 : 1)' && echo 0 || echo 1)" \
  "$(printf '%s' "$FAILURE_ROWS" | tr -d ' \n')"
check "no message was sent for a removed row's event" \
  "$([ "$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).messages.length)' "$LEDGER")" = "$AFTER_MESSAGES" ] && [ "$AFTER_MESSAGES" = "$BEFORE_MESSAGES" ] && echo 0 || echo 1)" \
  "messages before=$BEFORE_MESSAGES after=$AFTER_MESSAGES"
check "the API logged the prune" \
  "$(grep -q 'notify: pruned [0-9]* delivered notifications and [0-9]* run failures older than 30 days' "$RUN_DIR/api.log" && echo 0 || echo 1)" \
  "prune line"
printf '{"ledger": %s, "runFailures": %s}\n' "$LEDGER_ROWS" "$FAILURE_ROWS" > "$EVIDENCE_DIR/retention.json"
stop_pid "$RUN_DIR/api.pid"

# --- 3. nothing secret in the API's log, and nothing the fakes do not serve -------------------------------
leaks=0
for secret in "$VAPID_PRIVATE_KEY" "capability" "drive-"; do
  grep -qF "$secret" "$RUN_DIR/api.log" && leaks=$((leaks + 1))
done
check "the API's log names no VAPID private key, push endpoint or address" "$([ "$leaks" = "0" ] && echo 0 || echo 1)" "leaks=$leaks"
REFUSED="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).refused.length)' "$LEDGER" 2>/dev/null || echo -1)"
check "the API called no route the fake does not serve" "$([ "$REFUSED" = "0" ] && echo 0 || echo 1)" "refused=$REFUSED"

{
  printf '{\n  "database": "%s",\n  "checks": {\n' "$SCRATCH_DB"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "notify-settings: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "notify-settings: FAILURES — see $EVIDENCE_DIR/process.json and observed.json" >&2
fi
exit "$failed"
