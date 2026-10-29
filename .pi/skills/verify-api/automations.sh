#!/usr/bin/env bash
# Prove scheduled automations over the real API, its real clock and the real CLI
# (S-general-automations).
#
# The claim: a 1-minute cron added with `factory automation add` is fired by the API's own clock —
# one card on the repo's board and one run on it per minute — and a restart of the API does not fire
# the same minute again; a minute with no new commit on the base is recorded `skipped` with the
# reason; `factory automation run` starts one at once and `factory automation pause` stops the
# ticks. See `features/automations.md`.
#
# Its own API (./up.sh, on API_PORT, with its own run directory and AUTOMATIONS_POLL_MS=1000), booted,
# stopped and booted again over the same database between the driver's two phases. A fixture repo
# with no remote under .verify/run/automations/. Takes about three minutes: it waits for real minutes.
#
#   ./automations.sh
#   API_PORT=9530 ./automations.sh
#
# Env: DATABASE_URL (the run's own database), API_PORT, EVIDENCE_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
RUN_DIR="$ROOT/.verify/run/automations"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"

if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $API_PORT is already in use — set API_PORT to a free one" >&2
  exit 1
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/repos" "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api"

# A pass a second, so a tick lands within a second of its minute and the drive's waits stay short.
export AUTOMATIONS_POLL_MS=1000
# Long enough that the idle sweep never releases an owner between the drive's calls.
export SESSION_IDLE_TIMEOUT_MS=600000

stop() { VERIFY_RUN_DIR="$RUN_DIR" ./down.sh >/dev/null 2>&1 || true; }
trap 'stop' EXIT

drive() {
  env \
    API_URL="http://localhost:$API_PORT" \
    DATABASE_URL="${DATABASE_URL:?automations needs DATABASE_URL from the run}" \
    AUTOMATIONS_PHASE="$1" \
    AUTOMATIONS_STATE="$RUN_DIR/state.json" \
    AUTOMATIONS_REPOS="$RUN_DIR/repos" \
    EVIDENCE_DIR="$EVIDENCE_DIR" \
    bun "$ROOT/.pi/skills/verify-api/automations.ts" 2>&1 | tee -a "$RUN_DIR/driver.log"
  return "${PIPESTATUS[0]}"
}

RC=0
VERIFY_RUN_DIR="$RUN_DIR" API_PORT="$API_PORT" ./up.sh || exit 1
drive before || RC=1
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/automations-api-first.log" 2>/dev/null || true

# The restart: this process is stopped (SIGTERM, its owners released) and a new one reads the same
# database, inside the minute the first one fired.
stop
VERIFY_RUN_DIR="$RUN_DIR" API_PORT="$API_PORT" ./up.sh || exit 1
drive after || RC=1
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/automations-api-second.log" 2>/dev/null || true

# The second process's log names the first minute nowhere as a tick it started.
FIRST_TICK="$(bun -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).firstTickAt)' "$RUN_DIR/state.json" 2>/dev/null)"
if [ -n "$FIRST_TICK" ] && ! grep -q "schedule tick $FIRST_TICK started" "$EVIDENCE_DIR/automations-api-second.log" &&
   grep -q "schedule tick $FIRST_TICK started" "$EVIDENCE_DIR/automations-api-first.log"; then
  echo "PASS  logs: the first process started the minute $FIRST_TICK and the restarted one did not"
else
  echo "FAIL  logs: the first process started the minute ${FIRST_TICK:-?} and the restarted one did not" >&2
  RC=1
fi
cp "$RUN_DIR/driver.log" "$EVIDENCE_DIR/automations.log" 2>/dev/null || true
exit "$RC"
