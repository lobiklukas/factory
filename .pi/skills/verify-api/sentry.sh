#!/usr/bin/env bash
# Drive the Sentry receiver (LOB-81) end to end, across a restart: boot this skill's API with a
# Sentry client secret, post signed alerts at `/webhooks/sentry`, stop the process, boot a fresh one
# on the same database, and post the same alert again.
#
#   ./sentry.sh
#
# Isolation is `up.sh`'s: its own port, its own session root, its own pid. What this script adds is
# the Sentry configuration, which has to exist *before* the API boots because the routes read the
# rules once when they are built:
#
#   TRIGGER_RULES               one rule: the `sentry` label → this run's own repo (per run, so
#                               another run's sessions cannot answer "how many did this open?")
#   SENTRY_CLIENT_SECRET        the integration's client secret the drive signs with
#   SENTRY_RATE_LIMIT           6 per SENTRY_RATE_WINDOW_SECONDS=60, so a burst of 10 is past it
#
# The two-process shape is `sigterm.sh`'s: phase `first` runs against the first process; `down.sh`
# stops it with SIGTERM (and SIGKILL if it lingers); phase `after-restart` runs against a fresh
# process. The dedupe is a `webhook_deliveries` row, so the replay must survive; the rate cap is
# per-process memory, so it is not expected to.
#
# What the drive cannot prove: that Sentry signs the bytes it sends, whether Sentry retries a
# delivery or keeps its `Request-ID`, and its 1-second response budget. See
# `docs/testing-third-parties.md`'s Sentry row.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9423}"
API_URL="http://localhost:$API_PORT"
RUN_DIR="$ROOT/.verify/run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-81}"
STATE="$EVIDENCE_DIR/sentry-state.json"
DRIVER="$ROOT/.pi/skills/verify-api/sentry.ts"

export TRIGGER_REPO="${TRIGGER_REPO:-acme/verify-api-sentry-$(date +%s)}"
export SENTRY_CLIENT_SECRET="${SENTRY_CLIENT_SECRET:-verify-api-sentry-secret}"
export SENTRY_RATE_LIMIT="${SENTRY_RATE_LIMIT:-6}"
export SENTRY_RATE_WINDOW_SECONDS="${SENTRY_RATE_WINDOW_SECONDS:-60}"
TRIGGER_RULES="$(printf \
  '[{"label":"sentry","repo":"%s","baseRef":"main","prompt":"Investigate {{title}} before editing anything:\\n{{body}}"}]' \
  "$TRIGGER_REPO")"
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
    EVIDENCE_DIR="$EVIDENCE_DIR" SENTRY_STATE="$STATE" \
    bun "$DRIVER" 2>&1 | tee "$EVIDENCE_DIR/sentry-$1.log"
  return "${PIPESTATUS[0]}"
}

cd "$ROOT/.pi/skills/verify-api"
./down.sh >/dev/null 2>&1 || true
trap './down.sh >/dev/null 2>&1 || true' EXIT

# --- the first process ----------------------------------------------------------------------------
API_PORT="$API_PORT" ./up.sh || exit 1
FIRST_PID="$(cat "$RUN_DIR/api.pid")"
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
