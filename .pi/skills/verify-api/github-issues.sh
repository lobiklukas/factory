#!/usr/bin/env bash
# Drive the GitHub issues adapter over HTTP (LOB-190, served by LOB-259): a signed `issues` delivery
# carrying the `factory` label, posted at `POST /webhooks/github` of a booted API, opens one session
# and one issue comment; GitHub's `labeled` twin and a redelivery open none; an `@factory` comment is
# the same ask; and the same API booted with `GITHUB_WEBHOOK_SECRET` unset answers 503.
#
#   ./github-issues.sh
#   API_PORT=9580 GITHUB_ISSUES_PORT=9584 ./github-issues.sh        # another pair of ports
#
# Only GitHub is fake: the loopback `github-issues-fake.ts` answers the issue-comment API, and the
# API's `GITHUB_API_URL` points at it. The API, its signature check, the seam, the session layer and
# the run's Postgres are real (`adapter-lib.sh` boots them). `TRIGGER_RULES` names a decoy repo for
# the labels on purpose: the repo a session runs in is the payload's own.
#
# Env: API_PORT (or GITHUB_ISSUES_API_PORT; 9426), GITHUB_ISSUES_PORT (9413), DATABASE_URL,
# GITHUB_TRIGGER_REPO, GITHUB_WEBHOOK_SECRET, EVIDENCE_DIR.
#
# What the fake cannot prove: that GitHub accepts the comment path, the token or `X-GitHub-Api-Version`
# as spelled, that GitHub signs a delivery the way `refuseGitHubDelivery` reads it, or that creating
# an issue with a label really emits both the `opened` and the `labeled` delivery the idempotency key
# collapses. The request shape is asserted in `packages/core/src/GitHub.test.ts` from the documented
# API; the fake is only as right as that reading. See `docs/testing-third-parties.md`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT/.pi/skills/verify-api/adapter-lib.sh"
API_PORT="${GITHUB_ISSUES_API_PORT:-${API_PORT:-9426}}"
FAKE_PORT="${GITHUB_ISSUES_PORT:-9413}"
API_URL="http://127.0.0.1:$API_PORT"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-259}"
DRIVER="$ROOT/.pi/skills/verify-api/github-issues.ts"
SECRET="${GITHUB_WEBHOOK_SECRET:-lob259-github-webhook-secret}"
RUN_STAMP="$(date +%s)"
REPO="${GITHUB_TRIGGER_REPO:-acme/verify-api-github}-$RUN_STAMP"

mkdir -p "$EVIDENCE_DIR"
adapter_init github-issues
LEDGER="$RUN_DIR/github-issues-ledger.json"
rm -f "$LEDGER"
trap adapter_cleanup EXIT
adapter_check_ports "$API_PORT" "$FAKE_PORT"

adapter_start_fake github "$LEDGER" "$ROOT/.pi/skills/verify-api/github-issues-fake.ts" \
  GITHUB_ISSUES_FAKE_PORT="$FAKE_PORT" GITHUB_ISSUES_FAKE_LEDGER="$LEDGER" \
  GITHUB_ISSUES_FAKE_FAIL_AFTER_WRITE="#9" || exit 1

# Both rules name the decoy: a session that opened in it would be a mapping that read the rule's repo.
DECOY="$REPO-decoy"
RULES="$(printf '[{"label":"factory","repo":"%s","baseRef":"main","prompt":"Work on {{title}}:\\n{{body}}"},{"label":"deploy","repo":"%s","prompt":"Deploy {{title}}"}]' "$DECOY" "$DECOY")"
status=0

drive() { # mode
  MODE="$1" API_URL="$API_URL" GITHUB_ISSUES_FAKE_LEDGER="$LEDGER" GITHUB_TRIGGER_REPO="$REPO" \
    GITHUB_WEBHOOK_SECRET="$SECRET" GITHUB_RUN_STAMP="$RUN_STAMP" EVIDENCE_DIR="$EVIDENCE_DIR" \
    DATABASE_URL="$DATABASE_URL" bun "$DRIVER" 2>&1 | tee "$EVIDENCE_DIR/github-issues-$1.log"
  return "${PIPESTATUS[0]}"
}

# --- configured: the route armed, the comment API at the fake -------------------------------------
adapter_start_api "$API_PORT" \
  TRIGGER_RULES="$RULES" GITHUB_WEBHOOK_SECRET="$SECRET" \
  GITHUB_API_URL="http://127.0.0.1:$FAKE_PORT" GITHUB_TOKEN="ghs-drive-token" \
  GITHUB_SESSION_URL_BASE="http://localhost:3000/sessions" || exit 1
drive configured || status=1
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/github-issues-api.log"
adapter_stop_api

# --- unconfigured: the same API with no secret: every delivery is refused ---------------------------
adapter_start_api "$API_PORT" TRIGGER_RULES="$RULES" GITHUB_WEBHOOK_SECRET="" || exit 1
drive unconfigured || status=1
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/github-issues-api-unconfigured.log"

cp "$LEDGER" "$EVIDENCE_DIR/github-issues-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/github.log" "$EVIDENCE_DIR/github-issues-fake.log" 2>/dev/null || true

echo
if [ "$status" -eq 0 ]; then
  echo "github-issues: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "github-issues: FAILURES — see $EVIDENCE_DIR/github-issues-*.log" >&2
fi
exit "$status"
