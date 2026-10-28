#!/usr/bin/env bash
# Prove a PR's review and checks reach its card (C21; docs/board.md B7, B11): a person's requested
# changes in GitHub, and a red CI run on the PR, become what the next run on the card is told.
#
# The card is walked into `building` the way requires.sh walks its card, and a builder run opens its
# PR on a loopback GitHub fake when it settles (C18). Then, the way a deployment's GitHub delivers
# them to `POST /webhooks/github` (`feedback.ts MODE=deliver`, signing with the instance's secret):
#
#   1. a `changes_requested` review lands on the card's thread once — its redelivery writes nothing,
#      an unsigned one is refused — and `factory board show` prints the card blocked
#      `changes_requested`, naming the reviewer and the PR, with the review verbatim on its thread
#   2. a failing `check_run` on the PR's head is a note on the same thread, and its `check_suite` is
#      the same failure, so nothing more lands; the check blocks nothing
#   3. `factory board attention --board` lists the card as a `review` row, with the reviewer's words
#   4. `factory board start` opens the next run on the card: the block lifts (`board show` prints
#      `blocked   -`), the run's recorded prompt quotes the review verbatim and the check
#      (`feedback.ts MODE=told`), and its settle pushes to the card's one PR (C19) — a card left
#      blocked would hold that push (C18), so the PR link on the new run is the proof it went
#
# Not ./up.sh's instance: this script starts and stops its own API on FEEDBACK_PORT (default 9405)
# and its own GitHub fake on FEEDBACK_GITHUB_PORT (default 9406), with its own session root and
# fixture repo, and leaves nothing running.
#
#   ./feedback.sh
#
# Env: FEEDBACK_PORT, FEEDBACK_GITHUB_PORT, DATABASE_URL, EVIDENCE_DIR. Evidence:
# .verify/evidence/latest/board/feedback-*.
set -uo pipefail

# Auth off (LOB-20), as requires.sh runs it: the clients here send no credential.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL="$ROOT/.pi/skills/verify-board"
PORT="${FEEDBACK_PORT:-9405}"
GITHUB_PORT="${FEEDBACK_GITHUB_PORT:-9406}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/feedback"
LEDGER="$RUN_DIR/github-ledger.json"
# The builder's change, as requires.sh's: one more numbered file than the branch holds, committed.
BUILD_CHANGE="mkdir -p apps/web/src && n=\$(ls apps/web/src/built-*.ts 2>/dev/null | wc -l | tr -d ' ') && n=\$((n+1)) && echo \"export const built\$n = \$n;\" > apps/web/src/built-\$n.ts && git add apps/web/src/built-\$n.ts && git -c user.email=builder@localhost -c user.name=builder commit -q -m \"build the card (\$n)\" && echo built"
FAUX_MODEL_SCRIPTS="$(BUILD_CHANGE="$BUILD_CHANGE" bun -e 'console.log(JSON.stringify({ builder: { command: process.env.BUILD_CHANGE, verify: false } }))')"
WEBHOOK_SECRET="verify-board-feedback-$(date +%s)$$"
# Two lines, an em dash and trailing spaces: a review trimmed or re-encoded on its way into the
# next run's prompt would not be found verbatim.
REVIEW_BODY="$(printf 'Split the migration out of this change.\n  Build the index CONCURRENTLY \xe2\x80\x94 the table is hot.  ')"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
PROBE_EVIDENCE="$EVIDENCE_DIR/feedback"
LOG="$RUN_DIR/api.log"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
REPO="$RUN_DIR/repo"
DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
export DATABASE_URL

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR" "$PROBE_EVIDENCE"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  local detail="${3//\"/\\\"}"
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$detail\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-66s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-66s %s\n' "$1" "$3"
  fi
}

write_checks() {
  local first=1
  local row
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n'
}

cli() { # evidence-file, args...
  local out="$EVIDENCE_DIR/$1"
  shift
  "${FACTORY[@]}" "$@" --api "$API_URL" > "$out" 2>&1
  echo $?
}

stop_pid() { # pidfile
  local pidfile="$1"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}
stop_api() {
  stop_pid "$RUN_DIR/api.pid"
  stop_pid "$RUN_DIR/github.pid"
}
trap 'stop_api' EXIT

for port in "$PORT" "$GITHUB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is taken; set FEEDBACK_PORT / FEEDBACK_GITHUB_PORT to free ones" >&2
    exit 1
  fi
done

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# --- the fixture repo, the forge and the API ---------------------------------------------------------
rm -rf "$REPO" "$RUN_DIR/sessions"
mkdir -p "$REPO" "$RUN_DIR/sessions"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email verify-board@localhost
git -C "$REPO" config user.name "verify-board"
printf '# verify-board feedback fixture\n' > "$REPO/README.md"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "feedback fixture"

rm -f "$LEDGER"
( exec env GITHUB_FAKE_PORT="$GITHUB_PORT" GITHUB_FAKE_LEDGER="$LEDGER" \
    bun "$ROOT/.pi/skills/verify-api/github-fake.ts" ) > "$RUN_DIR/github.log" 2>&1 &
echo $! > "$RUN_DIR/github.pid"
for _ in $(seq 1 50); do
  grep -q "github-fake listening" "$RUN_DIR/github.log" 2>/dev/null && break
  sleep 0.1
done
grep -q "github-fake listening" "$RUN_DIR/github.log" 2>/dev/null ||
  { echo "the fake GitHub did not start on $GITHUB_PORT — see $RUN_DIR/github.log" >&2; exit 1; }

: > "$LOG"
( cd "$ROOT/apps/api" && exec env \
    -u GITHUB_TOKEN -u GITHUB_APP_ID -u GITHUB_APP_PRIVATE_KEY -u GITHUB_APP_INSTALLATION_ID \
    -u GITHUB_REVIEWER_TOKEN -u GITHUB_REVIEWER_APP_ID -u GITHUB_REVIEWER_APP_PRIVATE_KEY \
    -u GITHUB_REVIEWER_APP_INSTALLATION_ID \
    PORT="$PORT" \
    HOST="127.0.0.1" \
    ALLOWED_ORIGINS="http://localhost:$PORT" \
    MODEL_BACKEND=faux \
    FAUX_COMMAND="echo faux-ok" \
    ROLE_MODELS="builder=faux/builder" \
    FAUX_MODEL_SCRIPTS="$FAUX_MODEL_SCRIPTS" \
    GITHUB_API_URL="http://127.0.0.1:$GITHUB_PORT" \
    GITHUB_TOKEN="verify-board-fake-token" \
    GITHUB_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
    SESSION_ROOT="$RUN_DIR/sessions" \
    SESSION_IDLE_TIMEOUT_MS=600000 \
    bun run src/index.ts ) >> "$LOG" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" -eq 1 ] || { echo "api did not become ready — see $LOG" >&2; exit 1; }

if ! MODE=seed API_URL="$API_URL" REPO_ROOT="$REPO" bun "$SKILL/requires.ts" > "$RUN_DIR/board.json" 2>"$RUN_DIR/seed.err"; then
  echo "seed failed — see $RUN_DIR/board.json and $RUN_DIR/seed.err" >&2
  exit 1
fi
json() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$RUN_DIR/board.json"; }
TASK_ID="$(json taskId)"
BOARD_ID="$(json boardId)"

# --- walk the card into building, as a person, with its spec and plan --------------------------------
REVISION=1
move_to() { # column
  local to="$1"
  local rc; rc="$(cli "feedback-move-$to.txt" board move --task "$TASK_ID" --to "$to" --expect-revision "$REVISION")"
  if [ "$rc" = "0" ] && grep -q "moved $TASK_ID to $to (revision $((REVISION + 1)))" "$EVIDENCE_DIR/feedback-move-$to.txt"; then
    REVISION=$((REVISION + 1))
  else
    check "the card moves into $to" 1 "exit=$rc"
  fi
}
move_to specifying
TASK_ID="$TASK_ID" bun "$ROOT/.pi/skills/lib/seed-spec.ts" > "$RUN_DIR/spec.json" 2>"$RUN_DIR/spec.err"
REVISION="$(sed -n 's/.*"revision":\([0-9]*\).*/\1/p' "$RUN_DIR/spec.json")"
move_to planning
TASK_ID="$TASK_ID" bun "$ROOT/.pi/skills/lib/seed-plan.ts" > "$RUN_DIR/plan.json" 2>"$RUN_DIR/plan.err"
REVISION="$(sed -n 's/.*"revision":\([0-9]*\).*/\1/p' "$RUN_DIR/plan.json")"
move_to building
check "a person walks the card into building" "$([ "$REVISION" = "6" ] && echo 0 || echo 1)" "revision=$REVISION"

# --- the builder run and its PR, opened when it settles (C18) ----------------------------------------
rc="$(cli feedback-start-build.txt board start --task "$TASK_ID" --prompt "build this card")"
BUILD_SESSION="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/feedback-start-build.txt" | head -1)"
check "board start opens the builder run on the card" \
  "$([ "$rc" = "0" ] && [ -n "$BUILD_SESSION" ] && echo 0 || echo 1)" "exit=$rc session=${BUILD_SESSION:-none}"
MODE=answered API_URL="$API_URL" SESSION_ID="$BUILD_SESSION" LABEL=feedback-build \
  EVIDENCE_DIR="$PROBE_EVIDENCE" bun "$SKILL/requires.ts" > "$RUN_DIR/probe-build.log" 2>&1
check "the builder run made its change and answered (probe)" "$?" "see feedback/requires-feedback-build.json"
MODE=settled API_URL="$API_URL" SESSION_ID="${BUILD_SESSION:-}" TASK_ID="$TASK_ID" \
  EVIDENCE_DIR="$PROBE_EVIDENCE" bun "$SKILL/build.ts" > "$EVIDENCE_DIR/feedback-settled.txt" 2>&1
settled_rc=$?
PR_URL="$(sed -n 's/^pr       \(https:\/\/[^ ]*\)$/\1/p' "$EVIDENCE_DIR/feedback-settled.txt" | head -1)"
check "the builder run's PR is opened on the fake forge when its run settles" \
  "$([ "$settled_rc" = "0" ] && [ -n "$PR_URL" ] && grep -qF "\"url\": \"$PR_URL\"" "$LEDGER" && echo 0 || echo 1)" \
  "exit=$settled_rc ${PR_URL:-no link}"
HEAD_SHA="$(git -C "$REPO" rev-parse "factory/${BUILD_SESSION:-none}" 2>/dev/null)"

# --- 1-2. the review and the failing check, as GitHub delivers them ----------------------------------
MODE=deliver API_URL="$API_URL" GITHUB_WEBHOOK_SECRET="$WEBHOOK_SECRET" PR_URL="$PR_URL" HEAD="$HEAD_SHA" \
  TASK_ID="$TASK_ID" REVIEW_BODY="$REVIEW_BODY" EVIDENCE_DIR="$PROBE_EVIDENCE" \
  bun "$SKILL/feedback.ts" > "$RUN_DIR/probe-deliver.log" 2>&1
deliver_rc=$?
cat "$RUN_DIR/probe-deliver.log"
check "the review lands once, the check once, the unsigned review not at all (feedback.ts)" "$deliver_rc" "see feedback/feedback-deliver.json"

rc="$(cli feedback-show-blocked.txt board show --task "$TASK_ID")"
check "board show prints the card blocked changes_requested from building" \
  "$([ "$rc" = "0" ] && grep -q "^blocked   changes_requested from building since " "$EVIDENCE_DIR/feedback-show-blocked.txt" && echo 0 || echo 1)" \
  "exit=$rc $(grep -m1 '^blocked' "$EVIDENCE_DIR/feedback-show-blocked.txt")"
check "and the block names the reviewer and the PR" \
  "$(grep -qF "@verify-reviewer requested changes on pull request #${PR_URL##*/} ($PR_URL#pullrequestreview-" "$EVIDENCE_DIR/feedback-show-blocked.txt" && echo 0 || echo 1)" \
  "PR ${PR_URL:-none}"
check "and its thread holds the review verbatim, then the failing check" \
  "$(grep -qx "thread    2" "$EVIDENCE_DIR/feedback-show-blocked.txt" && grep -qx '  \[note\] github:verify-reviewer (revision [0-9]*)' "$EVIDENCE_DIR/feedback-show-blocked.txt" && grep -qxF '    Split the migration out of this change.' "$EVIDENCE_DIR/feedback-show-blocked.txt" && grep -qx '  \[note\] github:checks (revision [0-9]*)' "$EVIDENCE_DIR/feedback-show-blocked.txt" && grep -qF '    Check "gate" failed (failure)' "$EVIDENCE_DIR/feedback-show-blocked.txt" && echo 0 || echo 1)" \
  "$(grep -m1 '^thread' "$EVIDENCE_DIR/feedback-show-blocked.txt")"

# --- 3. Needs a person ------------------------------------------------------------------------------
rc="$(cli feedback-attention.txt board attention --board "$BOARD_ID")"
check "board attention lists the card as a review row, with the reviewer's words" \
  "$([ "$rc" = "0" ] && grep -q "^review  $TASK_ID  " "$EVIDENCE_DIR/feedback-attention.txt" && grep -qF "  blocked changes_requested since " "$EVIDENCE_DIR/feedback-attention.txt" && grep -qF "@verify-reviewer requested changes on pull request #${PR_URL##*/}" "$EVIDENCE_DIR/feedback-attention.txt" && echo 0 || echo 1)" \
  "exit=$rc $(head -1 "$EVIDENCE_DIR/feedback-attention.txt" | cut -c1-80)"

# --- 4. the next run reads the review, and its start lifts the block ---------------------------------
rc="$(cli feedback-start-next.txt board start --task "$TASK_ID" --prompt "address the review")"
NEXT_SESSION="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/feedback-start-next.txt" | head -1)"
check "board start opens the next run on the card" \
  "$([ "$rc" = "0" ] && [ -n "$NEXT_SESSION" ] && [ "$NEXT_SESSION" != "$BUILD_SESSION" ] && echo 0 || echo 1)" \
  "exit=$rc session=${NEXT_SESSION:-none}"
rc="$(cli feedback-show-resumed.txt board show --task "$TASK_ID")"
check "its start lifted the block: board show prints blocked -" \
  "$([ "$rc" = "0" ] && grep -qx "blocked   -" "$EVIDENCE_DIR/feedback-show-resumed.txt" && echo 0 || echo 1)" \
  "exit=$rc $(grep -m1 '^blocked' "$EVIDENCE_DIR/feedback-show-resumed.txt")"
MODE=told API_URL="$API_URL" SESSION_ID="${NEXT_SESSION:-}" PR_URL="$PR_URL" REVIEW_BODY="$REVIEW_BODY" \
  EVIDENCE_DIR="$PROBE_EVIDENCE" bun "$SKILL/feedback.ts" > "$RUN_DIR/probe-told.log" 2>&1
told_rc=$?
cat "$RUN_DIR/probe-told.log"
check "the next run's prompt quotes the review verbatim and the failing check (feedback.ts)" "$told_rc" "see feedback/feedback-told.json"
MODE=settled API_URL="$API_URL" SESSION_ID="${NEXT_SESSION:-}" TASK_ID="$TASK_ID" \
  EVIDENCE_DIR="$PROBE_EVIDENCE" bun "$SKILL/build.ts" > "$EVIDENCE_DIR/feedback-settled-next.txt" 2>&1
settled_rc=$?
NEXT_PR="$(sed -n 's/^pr       \(https:\/\/[^ ]*\)$/\1/p' "$EVIDENCE_DIR/feedback-settled-next.txt" | head -1)"
CREATES="$(LEDGER="$LEDGER" bun -e 'const l = JSON.parse(require("node:fs").readFileSync(process.env.LEDGER, "utf8")); console.log(l.requests.filter((r) => r.method === "POST").length)')"
NEXT_HEAD="$(git -C "$REPO" rev-parse "factory/${BUILD_SESSION:-none}" 2>/dev/null)"
check "its settle pushed to the card's one PR: the block held nothing back" \
  "$([ "$settled_rc" = "0" ] && [ -n "$PR_URL" ] && [ "$NEXT_PR" = "$PR_URL" ] && [ "$CREATES" = "1" ] && [ -n "$NEXT_HEAD" ] && [ "$NEXT_HEAD" != "$HEAD_SHA" ] && echo 0 || echo 1)" \
  "exit=$settled_rc ${NEXT_PR:-no link} creates=$CREATES head ${HEAD_SHA:0:12} → ${NEXT_HEAD:0:12}"

stop_api
cp "$LOG" "$EVIDENCE_DIR/feedback-api.log"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "taskId": "%s",\n' "$TASK_ID"
  printf '  "runs": {"build": "%s", "next": "%s"},\n' "${BUILD_SESSION:-}" "${NEXT_SESSION:-}"
  printf '  "prUrl": "%s",\n' "${PR_URL:-}"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/feedback-observed.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "feedback: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "feedback: FAILURES — see $EVIDENCE_DIR/feedback-observed.json" >&2
fi
exit "$failed"
