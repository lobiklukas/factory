#!/usr/bin/env bash
# Prove the boot warning for trigger rules whose repo has no local checkout (LOB-263).
#
#   ./no-checkout.sh
#
# Two boots of this skill's API over one `TRIGGER_RULES` with two rules, one per stamped repo:
#
#   1. nothing is registered, so the log names both rules (label and repo) and the command that fixes it;
#   2. after one repo is registered with a checkout (`no-checkout.ts`), the log names only the other.
#
# The rule that is still covered comes first in the rules, so its absence is proof: warnings are
# written in the rules' order in one pass, and the uncovered rule's line is the last of the pass.
# Evidence: .verify/evidence/lob-263/boot-1.log and boot-2.log (the API's own log of each boot).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-263}"
STAMP="${NO_CHECKOUT_STAMP:-$(date +%s)}"
COVERED="acme/verify-api-covered-$STAMP"
UNCOVERED="acme/verify-api-uncovered-$STAMP"
LOG="$ROOT/.verify/run/api.log"

TRIGGER_RULES="$(printf \
  '[{"label":"covered-rule","repo":"%s","prompt":"{{title}}"},{"label":"uncovered-rule","repo":"%s","prompt":"{{title}}"}]' \
  "$COVERED" "$UNCOVERED")"
export TRIGGER_RULES

mkdir -p "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api"

# Wait for a line in the API's log, up to 20 seconds: the check runs in a fork beside the server.
wait_for() {
  for _ in $(seq 1 40); do
    if grep -q -- "$1" "$LOG" 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  echo "FAIL: no log line matching: $1" >&2
  return 1
}

fail=0
check() {
  if "$@"; then echo "PASS $*" | cut -c1-110; else echo "FAIL $*" >&2; fail=1; fi
}

./down.sh >/dev/null 2>&1 || true
API_PORT="$API_PORT" ./up.sh

echo "--- boot 1: nothing registered"
wait_for "trigger rule \"uncovered-rule\" names $UNCOVERED" || fail=1
cp "$LOG" "$EVIDENCE_DIR/boot-1.log"
check grep -q "trigger rule \"covered-rule\" names $COVERED: repo $COVERED has no local checkout registered" "$EVIDENCE_DIR/boot-1.log"
check grep -q "factory repo add $UNCOVERED --path <dir>" "$EVIDENCE_DIR/boot-1.log"

API_URL="http://localhost:$API_PORT" NO_CHECKOUT_REPO="$COVERED" bun no-checkout.ts
./down.sh >/dev/null

echo "--- boot 2: $COVERED registered with a checkout"
API_PORT="$API_PORT" ./up.sh
wait_for "trigger rule \"uncovered-rule\" names $UNCOVERED" || fail=1
cp "$LOG" "$EVIDENCE_DIR/boot-2.log"
./down.sh >/dev/null
if grep -q "trigger rule \"covered-rule\"" "$EVIDENCE_DIR/boot-2.log"; then
  echo "FAIL: boot 2 still warns about the registered repo" >&2
  fail=1
else
  echo "PASS boot 2 does not name covered-rule"
fi

exit "$fail"
