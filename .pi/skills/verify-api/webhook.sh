#!/usr/bin/env bash
# Drive the inbound trigger seam (LOB-188) end to end: boot this skill's API instance with a
# trigger config, post signed deliveries at it, and check what the seam did.
#
#   ./webhook.sh
#
# Isolation is `up.sh`'s: its own port, its own session root, its own pid. What this script adds is
# the trigger configuration, which has to exist *before* the API boots because the routes read it
# once when they are built:
#
#   TRIGGER_RULES           the mapping rules, as JSON — three rules on this run's own repo:
#                           `factory`; a `docs` rule that admits `push` and `schedule` the way
#                           `docsTriggerRules` does; and a `release` rule that admits `release`. The
#                           drive proves the generic adapter refuses an action either rule admits
#                           before the rule could admit it (LOB-235)
#   TRIGGER_SECRET          the generic adapter's shared secret
#   LINEAR_WEBHOOK_SECRET   the Linear adapter's, so the drive can sign a Linear delivery too
#   TRIGGER_MAX_BODY_BYTES  2 KiB, so the drive's 4 KiB body proves the trigger cap and not the
#                           1 MiB transport cap underneath it
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-188}"

export TRIGGER_REPO="${TRIGGER_REPO:-acme/verify-api-trigger}"
export TRIGGER_SECRET="${TRIGGER_SECRET:-verify-api-trigger-secret}"
export LINEAR_WEBHOOK_SECRET="${LINEAR_WEBHOOK_SECRET:-verify-api-linear-secret}"
export TRIGGER_MAX_BODY_BYTES="${TRIGGER_MAX_BODY_BYTES:-2048}"
TRIGGER_RULES="$(printf \
  '[{"label":"factory","repo":"%s","baseRef":"main","prompt":"Work on {{title}}: {{body}}"},{"label":"docs","repo":"%s","baseRef":"main","prompt":"Document {{title}}: {{body}}","startsWorkFor":["push","schedule"]},{"label":"release","repo":"%s","baseRef":"main","prompt":"Release {{title}}","startsWorkFor":["release"]}]' \
  "$TRIGGER_REPO" "$TRIGGER_REPO" "$TRIGGER_REPO")"
export TRIGGER_RULES

mkdir -p "$EVIDENCE_DIR"

cd "$ROOT/.pi/skills/verify-api"
./down.sh >/dev/null 2>&1 || true
API_PORT="$API_PORT" ./up.sh

status=0
API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  TRIGGER_REPO="$TRIGGER_REPO" \
  TRIGGER_SECRET="$TRIGGER_SECRET" \
  LINEAR_WEBHOOK_SECRET="$LINEAR_WEBHOOK_SECRET" \
  bun webhook.ts 2>&1 | tee "$EVIDENCE_DIR/webhook.log" || status=$?

./down.sh
exit "$status"
