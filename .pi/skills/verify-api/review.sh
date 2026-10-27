#!/usr/bin/env bash
# Prove the review agent over HTTP (LOB-36): a booted API takes a signed `pull_request` on
# `POST /webhooks/github`, runs a read-only reviewer on the PR's card at its head, and posts one review
# comment on a loopback GitHub as the reviewer's own identity — then reviews a push again.
#
#   ./review.sh
#
# `packages/core/src/ReviewTrigger.test.ts` proves the same handler in-process; this proves what a
# deployment adds: the route that hands a `pull_request` to both the Linear mirror and the review, the
# boot that selects the reviewer's identity (`GITHUB_REVIEWER_TOKEN`, distinct from `GITHUB_TOKEN`),
# the poster against `GITHUB_API_URL`, and `ROLE_MODELS`' reviewer row.
#
# The checkout is a throwaway git repository: `main`, a `feature` head that seeds a bug in
# `src/sum.ts`, and a second commit on it for the push. The faux reviewer runs `git diff` there and
# files the seeded bug (`FAUX_REVIEW`); the forge is `review.ts`'s own `Bun.serve` on `FORGE_PORT`.
#
# Env: API_PORT (9200 when unset), FORGE_PORT (API_PORT + 1 when unset), EVIDENCE_DIR,
# DATABASE_URL (inherited by the API and the drive).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
FORGE_PORT="${FORGE_PORT:-$((API_PORT + 1))}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-36}"
RUN_STAMP="$(date +%s)$$"
SECRET="verify-api-review-secret-$RUN_STAMP"
REPO="acme/verify-review-$RUN_STAMP"

mkdir -p "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api" || exit 1
trap './down.sh >/dev/null 2>&1 || true' EXIT

CHECKOUT="$ROOT/.verify/run/review-checkout-$RUN_STAMP"
rm -rf "$CHECKOUT"
mkdir -p "$CHECKOUT/src"
g() { git -C "$CHECKOUT" -c user.email=verify-api@localhost -c user.name=verify-api "$@"; }
g init -q -b main
printf 'export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n' >"$CHECKOUT/src/sum.ts"
g add . && g commit -q -m base
BASE_SHA="$(g rev-parse HEAD)"
g checkout -q -b feature
printf 'export const sum = (xs: number[]) => xs.slice(1).reduce((a, b) => a + b, 0);\n' >"$CHECKOUT/src/sum.ts"
g commit -q -am "skip the first element"
HEAD_SHA="$(g rev-parse HEAD)"
printf '// a test, later\n' >"$CHECKOUT/src/sum.test.ts"
g add . && g commit -q -m "add a test file"
PUSHED_SHA="$(g rev-parse HEAD)"
g checkout -q main

FAUX_REVIEW='[{"summary":"Changes how sum folds its input.","dimensions":{"correctness":{"verdict":"fail","findings":[{"severity":"P0","file":"src/sum.ts","line":1,"mechanism":"`xs.slice(1)` drops the first element before summing, so sum([5]) is 0 and every total is short by xs[0]"}]},"security":{"verdict":"pass","findings":[]},"tests":{"verdict":"pass","findings":[]},"performance":{"verdict":"pass","findings":[]}}}]'

./down.sh >/dev/null 2>&1 || true
if ! env \
  API_PORT="$API_PORT" \
  GITHUB_WEBHOOK_SECRET="$SECRET" \
  GITHUB_API_URL="http://127.0.0.1:$FORGE_PORT" \
  GITHUB_TOKEN="ghs-verify-worker" \
  GITHUB_REVIEWER_TOKEN="ghs-verify-reviewer" \
  ROLE_MODELS="reviewer=faux/faux-review" \
  FAUX_COMMAND="git diff --stat main...HEAD" \
  FAUX_REVIEW="$FAUX_REVIEW" \
  ./up.sh; then
  echo "review: the API did not boot" >&2
  cp "$ROOT/.verify/run/api.log" "$EVIDENCE_DIR/api.log" 2>/dev/null || true
  exit 1
fi

status=0
env \
  API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  GITHUB_WEBHOOK_SECRET="$SECRET" \
  REVIEW_REPO="$REPO" \
  REVIEW_CHECKOUT="$CHECKOUT" \
  REVIEW_BASE="$BASE_SHA" \
  REVIEW_HEAD="$HEAD_SHA" \
  REVIEW_PUSHED="$PUSHED_SHA" \
  FORGE_PORT="$FORGE_PORT" \
  bun review.ts 2>&1 | tee "$EVIDENCE_DIR/review.log"
[ "${PIPESTATUS[0]}" = "0" ] || status=1
cp "$ROOT/.verify/run/api.log" "$EVIDENCE_DIR/api.log" 2>/dev/null || true

# The boot's own word for whose identity reviews are posted as.
if grep -q "reviewer identity: its own token (GITHUB_REVIEWER_TOKEN)" "$EVIDENCE_DIR/api.log" 2>/dev/null; then
  echo "PASS  the boot names the reviewer's own identity"
else
  echo "FAIL  the boot names the reviewer's own identity"
  status=1
fi

echo
if [ "$status" -eq 0 ]; then
  echo "review: PASS (evidence in $EVIDENCE_DIR)"
else
  echo "review: FAIL (evidence in $EVIDENCE_DIR)"
fi
exit "$status"
