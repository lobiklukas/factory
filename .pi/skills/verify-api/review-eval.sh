#!/usr/bin/env bash
# Measure the reviewer on the factory's own merged pull requests (LOB-242): an opt-in check in the
# shape of `bun run m0`, never part of the gate.
#
#   REVIEW_EVAL=faux ./review-eval.sh     the proof: the faux provider, no key, no cost
#   REVIEW_EVAL=live ./review-eval.sh     the measurement: a real model, which spends money
#   REVIEW_EVAL=live-check ./review-eval.sh   the live boot with a dummy key: no network, no model call
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
# `live-check` is the cheap guard on the live path: it boots the API exactly as `live` does, with a
# dummy credential and no model call, and checks the process serves the reviewer's model (so a role
# the anthropic catalog does not serve, which refuses the boot, cannot hide until the money is spent).
#
# The API's run directory is a fresh `mktemp -d` outside the repository, removed on exit (see below).
#
# Env: REVIEW_EVAL (`faux`, `live` or `live-check`; unset prints this and stops), API_PORT (9200 when unset),
# FORGE_PORT (API_PORT + 1), EVIDENCE_DIR (.verify/evidence/lob-242), REVIEW_EVAL_TIMEOUT_MS (per PR),
# DATABASE_URL (inherited by the API and the drive).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${REVIEW_EVAL:-}"
if [ "$MODE" != "faux" ] && [ "$MODE" != "live" ] && [ "$MODE" != "live-check" ]; then
  sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//' >&2
  echo "review-eval: set REVIEW_EVAL=faux, live or live-check" >&2
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

# The run directory (the API's session worktrees, its log, the scrubbed checkout) lives outside the
# repository: the reviewer's tools are real local processes, and this repository's working tree holds
# the corpus with every seed's answer. `VERIFY_RUN_DIR` is the one lever up.sh and down.sh read.
VERIFY_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/factory-review-eval.XXXXXX")"
export VERIFY_RUN_DIR
export REVIEW_EVAL_DIR="$VERIFY_RUN_DIR/review-eval"

cd "$ROOT/.pi/skills/verify-api" || exit 1
trap './down.sh >/dev/null 2>&1 || true; rm -rf "$VERIFY_RUN_DIR"' EXIT

mkdir -p "$EVIDENCE_DIR"
# live-check writes no per-PR evidence, so it must not delete what an earlier faux or live run left
# (the posted comments are what a person settles the mechanism column with): it keeps its own log.
if [ "$MODE" = "live-check" ]; then
  API_LOG_KEPT="$EVIDENCE_DIR/live-check.log"
else
  API_LOG_KEPT="$EVIDENCE_DIR/api.log"
  rm -rf "$EVIDENCE_DIR/results" "$EVIDENCE_DIR/comments"
fi
: >"$API_LOG_KEPT"

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
    cat "$VERIFY_RUN_DIR/api.log" >>"$API_LOG_KEPT" 2>/dev/null || true
    return 1
  fi
}
keep_log() { cat "$VERIFY_RUN_DIR/api.log" >>"$API_LOG_KEPT" 2>/dev/null || true; }

if [ "$MODE" = "live-check" ]; then
  # The live boot, a dummy credential, no model call: the process must come up serving the reviewer's
  # model. `up.sh` adds no faux row on this backend, so what is served is what ROLE_MODELS names.
  REVIEWER_ROLE="${ROLE_MODELS:-reviewer=anthropic/claude-sonnet-4-5}"
  boot \
    -u FAUX_COMMAND -u FAUX_REVIEW -u FAUX_COST -u FAUX_MODEL_SCRIPTS -u FAUX_EVERY_TURN \
    MODEL_BACKEND=anthropic ANTHROPIC_API_KEY=dummy-key-live-check ROLE_MODELS="$REVIEWER_ROLE" || exit 1
  LOG="$VERIFY_RUN_DIR/api.log"
  keep_log
  if grep -q "model backend: anthropic" "$LOG" && grep -q "role models: reviewer" "$LOG" \
    && ! grep -q "dummy-key-live-check" "$LOG"; then
    echo "review-eval (live-check): the live boot serves $REVIEWER_ROLE (no model was called)"
    exit 0
  fi
  echo "review-eval (live-check): FAIL, the boot log lacks the anthropic backend or the reviewer's role row" >&2
  exit 1
fi

bun review-eval.ts prepare || exit 1
IDS="$(bun review-eval.ts ids)"

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
