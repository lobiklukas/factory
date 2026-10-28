#!/usr/bin/env bash
# Measure the reviewer on the factory's own merged pull requests (LOB-242): an opt-in check in the
# shape of `bun run m0`, never part of the gate.
#
#   REVIEW_EVAL=faux ./review-eval.sh     the proof: the faux provider, no key, no cost
#   REVIEW_EVAL=live ./review-eval.sh     the measurement: a real model, which spends money
#   bun run review-eval                   the same script, from the repo root
#
# What it does: clones this repository, builds the corpus's pull requests in the clone (six merged
# PRs with one bug seeded on top, six merged PRs as they merged — `packages/harness/src/
# reviewEvalCorpus.ts`), boots the API, and for each PR delivers a signed `pull_request` to
# `POST /webhooks/github` exactly as `review.sh` does. The reviewer runs on its ROLE_MODELS model and
# posts to a loopback forge — `GITHUB_API_URL` is the only GitHub the API is told about, and the tokens
# are fixed fakes, so nothing is ever written to github.com. It then writes, to EVIDENCE_DIR,
# `review-eval.md` (the table: detected, named the file, named the mechanism, false positive, cost),
# `review-eval.json`, the posted comment of each PR under `comments/`, and each run's transcript under
# `results/`.
#
# `faux` scripts the reviewer per PR (a miss, a right file for the wrong reason, a wrong file, a nit, a
# false alarm among the rest) and asserts the table says exactly that, so the table is shown to tell
# outcomes apart; the API is booted once per PR there, because the faux script is one per boot. `live`
# boots the API once on the real model: the process environment names the model (`MODEL_BACKEND` is
# forced to `anthropic`, so a missing credential fails the boot instead of falling back to the faux),
# and `ROLE_MODELS=reviewer=<provider>/<model>` picks the reviewer's. This script never reads a
# credential or an .env file; the API does, as it does for any run.
#
# Env: REVIEW_EVAL (`faux` or `live`; unset prints this and stops), API_PORT (9200 when unset),
# FORGE_PORT (API_PORT + 1), EVIDENCE_DIR (.verify/evidence/lob-242), REVIEW_EVAL_TIMEOUT_MS (per PR),
# DATABASE_URL (inherited by the API and the drive).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${REVIEW_EVAL:-}"
if [ "$MODE" != "faux" ] && [ "$MODE" != "live" ]; then
  sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//' >&2
  echo "review-eval: set REVIEW_EVAL=faux or REVIEW_EVAL=live" >&2
  exit 2
fi

API_PORT="${API_PORT:-9200}"
FORGE_PORT="${FORGE_PORT:-$((API_PORT + 1))}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-242}"
RUN_STAMP="$(date +%s)$$"
SECRET="review-eval-secret-$RUN_STAMP"
export REVIEW_EVAL_MODE="$MODE" EVIDENCE_DIR API_PORT FORGE_PORT
export REVIEW_EVAL_REPO="acme/eval-$RUN_STAMP"
export API_URL="http://localhost:$API_PORT"
export GITHUB_WEBHOOK_SECRET="$SECRET"

cd "$ROOT/.pi/skills/verify-api" || exit 1
trap './down.sh >/dev/null 2>&1 || true' EXIT

rm -rf "$EVIDENCE_DIR/results" "$EVIDENCE_DIR/comments"
mkdir -p "$EVIDENCE_DIR"
: >"$EVIDENCE_DIR/api.log"

bun review-eval.ts prepare || exit 1
IDS="$(bun review-eval.ts ids)"

# The environment every boot shares. The tokens are fakes and the forge is loopback in both modes.
boot() {
  ./down.sh >/dev/null 2>&1 || true
  if ! env "$@" \
    API_PORT="$API_PORT" \
    GITHUB_WEBHOOK_SECRET="$SECRET" \
    GITHUB_API_URL="http://127.0.0.1:$FORGE_PORT" \
    GITHUB_TOKEN="ghs-eval-worker" \
    GITHUB_REVIEWER_TOKEN="ghs-eval-reviewer" \
    ./up.sh >/dev/null; then
    echo "review-eval: the API did not boot" >&2
    cat "$ROOT/.verify/run/api.log" >>"$EVIDENCE_DIR/api.log" 2>/dev/null || true
    return 1
  fi
}
keep_log() { cat "$ROOT/.verify/run/api.log" >>"$EVIDENCE_DIR/api.log" 2>/dev/null || true; }

status=0
if [ "$MODE" = "faux" ]; then
  for id in $IDS; do
    boot \
      MODEL_BACKEND=faux \
      ROLE_MODELS="reviewer=faux/faux-review" \
      FAUX_COST="0.002" \
      FAUX_COMMAND="$(bun review-eval.ts faux-command "$id")" \
      FAUX_REVIEW="$(bun review-eval.ts faux-review "$id")" || exit 1
    bun review-eval.ts run "$id" 2>&1 | tee -a "$EVIDENCE_DIR/review-eval.log"
    [ "${PIPESTATUS[0]}" = "0" ] || status=1
    keep_log
  done
else
  echo "review-eval: LIVE. This runs the reviewer on a real model for $(echo "$IDS" | wc -l | tr -d ' ') pull requests and spends money." >&2
  boot \
    -u FAUX_COMMAND -u FAUX_REVIEW -u FAUX_COST -u FAUX_MODEL_SCRIPTS -u FAUX_EVERY_TURN \
    MODEL_BACKEND=anthropic || exit 1
  for id in $IDS; do
    bun review-eval.ts run "$id" 2>&1 | tee -a "$EVIDENCE_DIR/review-eval.log"
    [ "${PIPESTATUS[0]}" = "0" ] || status=1
  done
  keep_log
fi

bun review-eval.ts report 2>&1 | tee -a "$EVIDENCE_DIR/review-eval.log"
[ "${PIPESTATUS[0]}" = "0" ] || status=1

echo
if [ "$status" -eq 0 ]; then
  echo "review-eval ($MODE): done (evidence in $EVIDENCE_DIR)"
else
  echo "review-eval ($MODE): FAIL (evidence in $EVIDENCE_DIR)"
fi
exit "$status"
