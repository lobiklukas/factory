#!/usr/bin/env bash
# Drive the Linear adapter end to end (LOB-164): boot this skill's API instance with a label → repo
# rule and Linear's signing secret, post Linear-shaped issue webhooks at `/webhooks/linear`, and
# check that a labeled issue opens exactly one session on the rule's repo with the issue as its
# first message — however Linear redelivers it.
#
#   ./linear.sh
#
# Isolation is `up.sh`'s: its own port, its own session root, its own pid. The rule is per run (its
# repo carries a stamp), so the session count the drive asserts is this run's alone, and the API
# reads the rule once when it boots, which is why it is set here and not in the driver:
#
#   TRIGGER_RULES          [{label: "factory", repo: <stamped>, baseRef: "main", prompt: …},
#                           {label: "factory-later", repo: <stamped>-later, …}] — the second repo
#                           is registered mid-drive, to prove an unregistered-repo skip is reclaimed
#   LINEAR_WEBHOOK_SECRET  the secret the drive signs `Linear-Signature` with
#
# Nothing here reaches Linear: the deliveries are written from Linear's documented payload and
# signed the way Linear signs one (`hmac-sha256` of the raw body, hex). What that cannot prove is in
# `docs/testing-third-parties.md`'s Linear webhook row.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9415}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-164}"
RUN_STAMP="${LINEAR_RUN_STAMP:-$(date +%s)}"

export LINEAR_TRIGGER_REPO="${LINEAR_TRIGGER_REPO:-acme/verify-api-linear}-$RUN_STAMP"
export LINEAR_LATER_REPO="$LINEAR_TRIGGER_REPO-later"
export LINEAR_WEBHOOK_SECRET="${LINEAR_WEBHOOK_SECRET:-verify-api-linear-secret}"
TRIGGER_RULES="$(printf \
  '[{"label":"factory","repo":"%s","baseRef":"main","prompt":"Linear issue {{key}}: {{title}}\\n\\n{{body}}"},{"label":"factory-later","repo":"%s","prompt":"{{title}}"}]' \
  "$LINEAR_TRIGGER_REPO" "$LINEAR_LATER_REPO")"
export TRIGGER_RULES

mkdir -p "$EVIDENCE_DIR"

cd "$ROOT/.pi/skills/verify-api"
./down.sh >/dev/null 2>&1 || true
API_PORT="$API_PORT" ./up.sh

status=0
API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  LINEAR_RUN_STAMP="$RUN_STAMP" \
  bun linear.ts 2>&1 | tee "$EVIDENCE_DIR/linear.log" || status=$?

cp "$ROOT/.verify/run/api.log" "$EVIDENCE_DIR/api.log" 2>/dev/null || true
./down.sh
exit "$status"
