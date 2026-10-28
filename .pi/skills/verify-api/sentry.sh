#!/usr/bin/env bash
# Drive the Sentry receiver (LOB-81), its mapping (LOB-82) and its link-back (LOB-83) end to end,
# across a restart: boot this skill's API with a Sentry client secret, a filter and a Sentry API
# client, post signed alerts at `/webhooks/sentry`, stop the process, boot a fresh one on the same
# database, and post the same alert — and another event in the same Sentry issue — again.
#
#   ./sentry.sh
#
# Isolation is `up.sh`'s: its own port, its own session root, its own pid. What this script adds is
# the Sentry configuration, which has to exist *before* the API boots because the routes read the
# rules once when they are built:
#
#   TRIGGER_RULES               three rules: `sentry:project:404` → this run's repo with an
#                               `-unregistered` suffix, which nobody registers (so the alert burst
#                               records skips and opens no session); `sentry:project:777` → this
#                               run's repo with a blank prompt, so its session gets the default
#                               investigate-before-edit template (LOB-82); and the catch-all: the
#                               `sentry` label → this run's own repo (per run, so another run's
#                               sessions cannot answer "how many did this open?")
#   SENTRY_CLIENT_SECRET        the integration's client secret the drive signs with
#   SENTRY_RATE_LIMIT           12 per SENTRY_RATE_WINDOW_SECONDS=60, so a burst of 16 alerts is past it
#                               (the link-back phase spends six tokens and the receiver's own four,
#                               leaving two for the burst's admitted ones)
#   SENTRY_MIN_LEVEL            error, SENTRY_ENVIRONMENTS=production and SENTRY_RELEASES=verify@*:
#                               the filter the drive's warning, staging and other-release alerts fail
#                               (LOB-82)
#   SENTRY_API_URL, SENTRY_API_TOKEN, SENTRY_SESSION_URL_BASE
#                               the link-back's client (LOB-83), pointed at `sentry-api-fake.ts` on
#                               loopback: a note on the alert's Sentry issue naming the session. The
#                               fake is started here, before the first API, with a ledger file the
#                               drive reads and three issues that misbehave on purpose (its first
#                               note create applied and the connection dropped; every request a 503;
#                               every request unanswered). It outlives the API restart, so the
#                               ledger is one record across both processes.
#
# The two-process shape is `sigterm.sh`'s: phase `first` runs against the first process; `down.sh`
# stops it with SIGTERM (and SIGKILL if it lingers); phase `after-restart` runs against a fresh
# process. The dedupe is a `webhook_deliveries` row, so the replay must survive; the rate cap is
# per-process memory, so it is not expected to. Phase `linkback` runs first against the first
# process (the note, and what a failed one costs), then `first`, then `after-restart`.
#
# What the drive cannot prove: that Sentry signs the bytes it sends, whether Sentry retries a
# delivery or keeps its `Request-ID`, its 1-second response budget, and that the real Sentry REST
# API takes the notes routes and token as spelled here. See `docs/testing-third-parties.md`'s two
# Sentry rows.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9423}"
FAKE_PORT="${SENTRY_FAKE_PORT:-$((API_PORT + 1))}"
API_URL="http://localhost:$API_PORT"
RUN_DIR="$ROOT/.verify/run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-83}"
STATE="$EVIDENCE_DIR/sentry-state.json"
DRIVER="$ROOT/.pi/skills/verify-api/sentry.ts"

export TRIGGER_REPO="${TRIGGER_REPO:-acme/verify-api-sentry-$(date +%s)}"
export SENTRY_CLIENT_SECRET="${SENTRY_CLIENT_SECRET:-verify-api-sentry-secret}"
export SENTRY_RATE_LIMIT="${SENTRY_RATE_LIMIT:-12}"
export SENTRY_RATE_WINDOW_SECONDS="${SENTRY_RATE_WINDOW_SECONDS:-60}"
export SENTRY_MIN_LEVEL="${SENTRY_MIN_LEVEL:-error}"
export SENTRY_ENVIRONMENTS="${SENTRY_ENVIRONMENTS:-production}"
export SENTRY_RELEASES="${SENTRY_RELEASES:-verify@*}"
RUN_STAMP="$(date +%s)$(printf '%03d' $((RANDOM % 1000)))"
export SENTRY_LOSE_ACK_ISSUE="lob83-$RUN_STAMP-lose"
export SENTRY_FAIL_ISSUE="lob83-$RUN_STAMP-fail"
export SENTRY_HANG_ISSUE="lob83-$RUN_STAMP-hang"
export SENTRY_API_URL="http://127.0.0.1:$FAKE_PORT"
export SENTRY_API_TOKEN="${SENTRY_API_TOKEN:-verify-api-sentry-token}"
export SENTRY_SESSION_URL_BASE="${SENTRY_SESSION_URL_BASE:-http://localhost:3000/sessions}"
FAKE="$ROOT/.pi/skills/verify-api/sentry-api-fake.ts"
LEDGER="$RUN_DIR/sentry-ledger.json"
TRIGGER_RULES="$(printf \
  '[{"label":"sentry:project:404","repo":"%s-unregistered","prompt":"{{title}}"},{"label":"sentry:project:777","repo":"%s","prompt":""},{"label":"sentry","repo":"%s","baseRef":"main","prompt":"Investigate {{title}} before editing anything:\\n{{body}}"}]' \
  "$TRIGGER_REPO" "$TRIGGER_REPO" "$TRIGGER_REPO")"
export TRIGGER_RULES

mkdir -p "$EVIDENCE_DIR"
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

drive() { # mode
  MODE="$1" API_URL="$API_URL" API_LOG="$RUN_DIR/api.log" \
    EVIDENCE_DIR="$EVIDENCE_DIR" SENTRY_STATE="$STATE" SENTRY_FAKE_LEDGER="$LEDGER" \
    bun "$DRIVER" 2>&1 | tee "$EVIDENCE_DIR/sentry-$1.log"
  return "${PIPESTATUS[0]}"
}

cd "$ROOT/.pi/skills/verify-api"
./down.sh >/dev/null 2>&1 || true

# --- the loopback Sentry REST API, which outlives both API processes -----------------------------
FAKE_PID_FILE="$RUN_DIR/sentry-api-fake.pid"
stop_fake() {
  [ -f "$FAKE_PID_FILE" ] || return 0
  local pid; pid="$(cat "$FAKE_PID_FILE")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$FAKE_PID_FILE"
}
trap './down.sh >/dev/null 2>&1 || true; stop_fake' EXIT
mkdir -p "$RUN_DIR"
if lsof -nP -iTCP:"$FAKE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $FAKE_PORT is already in use; set SENTRY_FAKE_PORT to a free port" >&2
  exit 1
fi
rm -f "$LEDGER"
: > "$RUN_DIR/sentry-api-fake.log"
( exec env SENTRY_FAKE_PORT="$FAKE_PORT" SENTRY_FAKE_LEDGER="$LEDGER" \
    SENTRY_FAKE_TOKEN="$SENTRY_API_TOKEN" SENTRY_FAKE_LOSE_ACK="$SENTRY_LOSE_ACK_ISSUE" \
    SENTRY_FAKE_FAIL="$SENTRY_FAIL_ISSUE" SENTRY_FAKE_HANG="$SENTRY_HANG_ISSUE" \
    bun "$FAKE" ) >> "$RUN_DIR/sentry-api-fake.log" 2>&1 &
echo $! > "$FAKE_PID_FILE"
for _ in $(seq 1 60); do
  [ -s "$LEDGER" ] && break
  sleep 0.1
done
if [ ! -s "$LEDGER" ]; then
  echo "the Sentry API fake did not start — see $RUN_DIR/sentry-api-fake.log" >&2
  exit 1
fi

# --- the first process ----------------------------------------------------------------------------
API_PORT="$API_PORT" ./up.sh || exit 1
FIRST_PID="$(cat "$RUN_DIR/api.pid")"
drive linkback
check "the link-back phase's checks pass" "$?" "pid=$FIRST_PID"
drive first
check "the first process's checks pass" "$?" "pid=$FIRST_PID"
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/sentry-api-first.log"

# --- restart: SIGTERM, then a fresh process on the same database ----------------------------------
./down.sh >/dev/null
check "the first process is gone" \
  "$(kill -0 "$FIRST_PID" 2>/dev/null && echo 1 || echo 0)" "pid=$FIRST_PID"
API_PORT="$API_PORT" ./up.sh || exit 1
SECOND_PID="$(cat "$RUN_DIR/api.pid")"
check "the restart is a different process" \
  "$([ "$SECOND_PID" != "$FIRST_PID" ] && echo 0 || echo 1)" "pid=$SECOND_PID"
if [ -s "$STATE" ]; then
  drive after-restart
  check "the restarted process's checks pass" "$?" "pid=$SECOND_PID"
else
  check "the restarted process's checks pass" 1 "the first phase wrote no state"
fi
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/sentry-api-after-restart.log"
cp "$LEDGER" "$EVIDENCE_DIR/sentry-api-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/sentry-api-fake.log" "$EVIDENCE_DIR/sentry-api-fake.log" 2>/dev/null || true

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "repo": "%s",\n' "$TRIGGER_REPO"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/sentry-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "sentry: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "sentry: FAILURES — see $EVIDENCE_DIR/sentry-process.json" >&2
fi
exit "$failed"
