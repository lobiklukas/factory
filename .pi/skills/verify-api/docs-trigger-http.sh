#!/usr/bin/env bash
# Prove the docs trigger has callers (LOB-234): a booted API runs the schedule as a daemon and takes
# a signed GitHub `push` on `POST /webhooks/github`, with no drive script delivering anything.
#
#   ./docs-trigger-http.sh
#
# `./docs-trigger.sh` (LOB-197) proves the trigger itself in-process; this proves what starts it in
# a deployment, so everything here is the API's: its boot configuration, its daemon, its route, its
# `SessionService`. Two boots, because the schedule is read once at boot:
#
#   on   DOCS_SCHEDULE_MS=400, DOCS_SCHEDULE_REPO=<stamped>, GITHUB_WEBHOOK_SECRET — the schedule
#        ticks, a push starts one session, a redelivery is a replay, the refusals are 400 and 401,
#        a docs PR's merge is skipped, a push redelivered after its repo is registered starts its run
#   off  DOCS_SCHEDULE_MS unset, the same kind of repo set and registered — no schedule session
#
# Isolation is `up.sh`'s: its own port, its own session root, its own pid. The repos carry a per-run
# stamp, so a database another run drove against cannot answer the counts.
#
# Env: API_PORT (9422 when unset), EVIDENCE_DIR, DATABASE_URL (inherited by the API).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9422}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-234}"
RUN_STAMP="$(date +%s)$$"
SECRET="verify-api-github-secret-$RUN_STAMP"

mkdir -p "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api" || exit 1
trap './down.sh >/dev/null 2>&1 || true' EXIT

status=0
phase() { # name, then the env the API boots with
  local name="$1"
  shift
  ./down.sh >/dev/null 2>&1 || true
  if ! env "$@" API_PORT="$API_PORT" ./up.sh; then
    echo "docs-trigger-http: the API did not boot for phase $name" >&2
    cp "$ROOT/.verify/run/api.log" "$EVIDENCE_DIR/api-$name.log" 2>/dev/null || true
    status=1
    return
  fi
  env "$@" \
    API_URL="http://localhost:$API_PORT" \
    EVIDENCE_DIR="$EVIDENCE_DIR" \
    DOCS_HTTP_PHASE="$name" \
    bun docs-trigger-http.ts 2>&1 | tee "$EVIDENCE_DIR/docs-trigger-http-$name.log"
  [ "${PIPESTATUS[0]}" = "0" ] || status=1
  cp "$ROOT/.verify/run/api.log" "$EVIDENCE_DIR/api-$name.log" 2>/dev/null || true
  ./down.sh >/dev/null 2>&1 || true
}

phase on \
  DOCS_SCHEDULE_MS=400 \
  DOCS_SCHEDULE_REPO="acme/verify-api-docs-schedule-$RUN_STAMP" \
  DOCS_PUSH_REPO="acme/verify-api-docs-push-$RUN_STAMP" \
  GITHUB_WEBHOOK_SECRET="$SECRET"

# The boot's own word for it, from the log the API wrote.
if grep -q "docs schedule: every 400ms over acme/verify-api-docs-schedule-$RUN_STAMP" \
  "$EVIDENCE_DIR/api-on.log" 2>/dev/null; then
  echo "PASS  the on boot logs the schedule it runs"
else
  echo "FAIL  the on boot logs the schedule it runs"
  status=1
fi

phase off \
  DOCS_SCHEDULE_REPO="acme/verify-api-docs-off-$RUN_STAMP" \
  GITHUB_WEBHOOK_SECRET="$SECRET"

if grep -q "docs schedule: off" "$EVIDENCE_DIR/api-off.log" 2>/dev/null; then
  echo "PASS  the off boot logs that the schedule is off"
else
  echo "FAIL  the off boot logs that the schedule is off"
  status=1
fi

echo
if [ "$status" -eq 0 ]; then
  echo "docs-trigger-http: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "docs-trigger-http: FAILURES — see $EVIDENCE_DIR" >&2
fi
exit "$status"
