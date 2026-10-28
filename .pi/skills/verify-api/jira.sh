#!/usr/bin/env bash
# Drive the Jira adapter over HTTP (LOB-189, served by LOB-259): a signed `jira:issue_created`
# delivery posted at `POST /webhooks/jira` of a booted API opens one session and one Jira comment,
# the same body again opens neither, a bad signature is refused, and the same API booted with
# `JIRA_WEBHOOK_SECRET` unset answers 503.
#
#   ./jira.sh
#   API_PORT=9580 JIRA_FAKE_PORT=9581 ./jira.sh        # another pair of ports
#
# Only Jira is fake: the loopback `jira-fake.ts` answers the comment API. The API, its signature
# check, the seam, the session layer and the run's Postgres are real (`adapter-lib.sh` boots them).
# The API's own environment is the deployment's: `JIRA_WEBHOOK_SECRET` arms the route,
# `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN` point the write-back at the fake, and `TRIGGER_RULES`
# maps the `factory` label to this run's own repo.
#
# Env: API_PORT (or JIRA_API_PORT; 9424), JIRA_FAKE_PORT (9412), DATABASE_URL, JIRA_TRIGGER_REPO,
# EVIDENCE_DIR.
#
# What the fake cannot prove: that Jira Cloud accepts the ADF document, the Basic-auth header or the
# comment path as spelled, or signs `X-Hub-Signature` the way `verifyJiraSignature` reads it. The
# request shape is asserted in `packages/core/src/Jira.test.ts` from the documented API; the fake is
# only as right as that reading. See `docs/testing-third-parties.md`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT/.pi/skills/verify-api/adapter-lib.sh"
API_PORT="${JIRA_API_PORT:-${API_PORT:-9424}}"
FAKE_PORT="${JIRA_FAKE_PORT:-9412}"
API_URL="http://127.0.0.1:$API_PORT"
FAKE_URL="http://127.0.0.1:$FAKE_PORT"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-259}"
DRIVER="$ROOT/.pi/skills/verify-api/jira.ts"
SECRET="${JIRA_WEBHOOK_SECRET:-lob259-jira-webhook-secret}"
RUN_STAMP="$(date +%s)"
REPO="${JIRA_TRIGGER_REPO:-acme/verify-api-jira}-$RUN_STAMP"

mkdir -p "$EVIDENCE_DIR"
adapter_init jira
LEDGER="$RUN_DIR/jira-ledger.json"
rm -f "$LEDGER"
trap adapter_cleanup EXIT
adapter_check_ports "$API_PORT" "$FAKE_PORT"

adapter_start_fake jira "$LEDGER" "$ROOT/.pi/skills/verify-api/jira-fake.ts" \
  JIRA_FAKE_PORT="$FAKE_PORT" JIRA_FAKE_LEDGER="$LEDGER" JIRA_FAKE_FAIL_AFTER_WRITE=FAC-2 || exit 1

RULES="$(printf '[{"label":"factory","repo":"%s","baseRef":"main","prompt":"Work on {{title}}:\\n{{body}}"}]' "$REPO")"
status=0

drive() { # mode
  MODE="$1" API_URL="$API_URL" JIRA_FAKE_LEDGER="$LEDGER" JIRA_WEBHOOK_SECRET="$SECRET" \
    JIRA_TRIGGER_REPO="$REPO" JIRA_RUN_STAMP="$RUN_STAMP" EVIDENCE_DIR="$EVIDENCE_DIR" \
    DATABASE_URL="$DATABASE_URL" bun "$DRIVER" 2>&1 | tee "$EVIDENCE_DIR/jira-$1.log"
  return "${PIPESTATUS[0]}"
}

# --- configured: the route armed, the write-back pointed at the fake ------------------------------
adapter_start_api "$API_PORT" \
  TRIGGER_RULES="$RULES" JIRA_WEBHOOK_SECRET="$SECRET" \
  JIRA_BASE_URL="$FAKE_URL" JIRA_EMAIL="factory@example.com" JIRA_API_TOKEN="jira-drive-token" \
  JIRA_SESSION_URL_BASE="http://localhost:3000/sessions" || exit 1
drive configured || status=1
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/jira-api.log"
adapter_stop_api

# --- unconfigured: the same API with no secret: every delivery is refused ---------------------------
adapter_start_api "$API_PORT" TRIGGER_RULES="$RULES" JIRA_WEBHOOK_SECRET="" || exit 1
drive unconfigured || status=1
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/jira-api-unconfigured.log"

cp "$LEDGER" "$EVIDENCE_DIR/jira-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/jira.log" "$EVIDENCE_DIR/jira-fake.log" 2>/dev/null || true

echo
if [ "$status" -eq 0 ]; then
  echo "jira: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "jira: FAILURES — see $EVIDENCE_DIR/jira-*.log" >&2
fi
exit "$status"
