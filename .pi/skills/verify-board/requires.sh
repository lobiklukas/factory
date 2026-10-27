#!/usr/bin/env bash
# Prove a column's `requires[]` refuses the move it gates, naming the requirement (LOB-80;
# docs/board.md B5, B8).
#
# The default pipeline's `building` declares `non_empty_diff` and `pr_link` (checked since LOB-240): a
# card leaves it only when its latest run's branch carries a committed change and that run recorded a
# PR. Its `review` declares `verified` from definition version 3: a card leaves it only when the card's
# latest verified change passed for every surface it touched. This script walks a card into
# `building` the way a person does, then proves both gates from the terminal:
#
#   0. building        with no run, `board move --to review` is refused naming "non_empty_diff"; a
#                      builder run commits a change on its branch, and the same move is refused
#                      naming "pr_link"; `factory pr` opens the run's PR on a loopback GitHub fake,
#                      and the move goes through
#   1. no evidence     `board move --to done` is refused: `requirement_unmet`, the words name
#                      "verified", the exit is non-zero, and the card is still in `review`
#   2. web, passing    a run (`board start`) changes apps/web and verifies it with the fixture's
#                      verify-web skill, exit 0
#   3. api, unverified a second run changes apps/api, which the fixture has no skill for: the move is
#                      refused again, naming "verified" and `api` — the passing `web` evidence from
#                      run 2 is a different surface and does not satisfy it
#   4. api, passing    a third run changes apps/api and adds a passing verify-api skill: the same move
#                      goes through
#
# Each review run's change is the fixture's `change.sh`, committed on `main` before the run starts, so
# the worktree the run is cut from carries it and FAUX_COMMAND stays one fixed `bash change.sh`. The
# builder run is the `builder` role's own faux model (`ROLE_MODELS=builder=faux/builder`, as ./up.sh
# does), whose script commits one file on the run's branch and calls no `verify` — so the review
# phases below start, as before, with no verification of the card's change. The runs are real
# sessions bound to the card (`task_runs`), their verification is the real `verify` tool, and its
# record is read back out of the run's log by `requires.ts`.
#
# Not ./up.sh's instance: this script starts and stops its own API on REQUIRES_PORT (default 9402)
# and its own GitHub fake on REQUIRES_GITHUB_PORT (default 9404), with its own session root and
# fixture repo, and leaves nothing running.
#
#   ./requires.sh
#
# Env: REQUIRES_PORT, REQUIRES_GITHUB_PORT, DATABASE_URL, EVIDENCE_DIR. Evidence:
# .verify/evidence/latest/board/requires-*.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${REQUIRES_PORT:-9402}"
GITHUB_PORT="${REQUIRES_GITHUB_PORT:-9404}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/requires"
LEDGER="$RUN_DIR/github-ledger.json"
# The builder's change: one file, committed on the run's own branch, so `non_empty_diff` has a diff
# to measure and the PR something to carry. No `verify` call (LOB-240; see the header).
BUILD_CHANGE="mkdir -p apps/web/src && echo 'export const built = 1;' > apps/web/src/built.ts && git add apps/web/src/built.ts && git -c user.email=builder@localhost -c user.name=builder commit -q -m 'build the card' && echo built"
FAUX_MODEL_SCRIPTS="$(BUILD_CHANGE="$BUILD_CHANGE" bun -e 'console.log(JSON.stringify({ builder: { command: process.env.BUILD_CHANGE, verify: false } }))')"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
LOG="$RUN_DIR/api.log"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
PROBE="$ROOT/.pi/skills/verify-board/requires.ts"
REPO="$RUN_DIR/repo"
DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
export DATABASE_URL

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

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

# Run the CLI, keep its stdout+stderr in an evidence file, and echo its exit code.
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

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is taken; set REQUIRES_PORT to a free one" >&2
  exit 1
fi
if lsof -nP -iTCP:"$GITHUB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $GITHUB_PORT is taken; set REQUIRES_GITHUB_PORT to a free one" >&2
  exit 1
fi

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# --- the fixture repo: a verify-web skill that passes, and the change script the runs execute --------
rm -rf "$REPO" "$RUN_DIR/sessions"
mkdir -p "$REPO/.pi/skills/verify-web" "$RUN_DIR/sessions"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email verify-board@localhost
git -C "$REPO" config user.name "verify-board"
printf '# verify-board requires fixture\n' > "$REPO/README.md"
printf 'echo "verify-web fixture: 2/2 checks passed (surface=$FACTORY_VERIFY_SURFACE)"\n' \
  > "$REPO/.pi/skills/verify-web/drive.sh"
printf 'echo "no change yet"\n' > "$REPO/change.sh"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "requires fixture"

# The next run's change, committed on `main` so the worktree `board start` cuts carries it.
next_change() { # script body
  printf '%s\n' "$1" > "$REPO/change.sh"
  git -C "$REPO" add change.sh
  git -C "$REPO" commit -q -m "next change"
}

# The forge: the loopback GitHub fake, its ledger on disk (LOB-179), as ./up.sh starts it.
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
    PORT="$PORT" \
    HOST="127.0.0.1" \
    ALLOWED_ORIGINS="http://localhost:$PORT" \
    MODEL_BACKEND=faux \
    FAUX_COMMAND="bash change.sh" \
    FAUX_VERIFY=true \
    ROLE_MODELS="builder=faux/builder" \
    FAUX_MODEL_SCRIPTS="$FAUX_MODEL_SCRIPTS" \
    GITHUB_API_URL="http://127.0.0.1:$GITHUB_PORT" \
    GITHUB_TOKEN="verify-board-fake-token" \
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

if ! MODE=seed API_URL="$API_URL" REPO_ROOT="$REPO" bun "$PROBE" > "$RUN_DIR/board.json" 2>"$RUN_DIR/seed.err"; then
  echo "seed failed — see $RUN_DIR/board.json and $RUN_DIR/seed.err" >&2
  exit 1
fi
json() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$RUN_DIR/board.json"; }
TASK_ID="$(json taskId)"
REQUIRES="$(json reviewRequires)"
VERSION="$(sed -n 's/.*"definitionVersion":\([0-9]*\).*/\1/p' "$RUN_DIR/board.json")"
check "the board binds a definition whose review requires verified" \
  "$(case ",$REQUIRES," in *,verified,*) echo 0 ;; *) echo 1 ;; esac)" \
  "default v$VERSION review requires [$REQUIRES]"

# --- walk the card into building, as a person --------------------------------------------------------
REVISION=1
for to in specifying planning building; do
  rc="$(cli "requires-move-$to.txt" board move --task "$TASK_ID" --to "$to" --expect-revision "$REVISION")"
  if [ "$rc" = "0" ] && grep -q "moved $TASK_ID to $to (revision $((REVISION + 1)))" "$EVIDENCE_DIR/requires-move-$to.txt"; then
    REVISION=$((REVISION + 1))
  else
    check "the card moves into $to" 1 "exit=$rc"
  fi
done
check "a person walks the card into building" "$([ "$REVISION" = "4" ] && echo 0 || echo 1)" "revision=$REVISION"

# --- 0. building: no change, then no PR, then the PR (LOB-240) ---------------------------------------
rc="$(cli requires-building-none.txt board move --task "$TASK_ID" --to review --expect-revision "$REVISION")"
check "with no run, building → review is refused naming non_empty_diff" \
  "$([ "$rc" != "0" ] && grep -qF 'error: requirement_unmet: the move building → review needs "non_empty_diff" (a non-empty diff), which is not met: the card has no runs, so no branch carries its change' "$EVIDENCE_DIR/requires-building-none.txt" && echo 0 || echo 1)" \
  "exit=$rc $(head -1 "$EVIDENCE_DIR/requires-building-none.txt" | cut -c1-100)"

rc="$(cli requires-start-build.txt board start --task "$TASK_ID" --prompt "build this card")"
BUILD_SESSION="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/requires-start-build.txt" | head -1)"
check "board start opens the builder run on the card" \
  "$([ "$rc" = "0" ] && [ -n "$BUILD_SESSION" ] && grep -q "task    $TASK_ID in building" "$EVIDENCE_DIR/requires-start-build.txt" && echo 0 || echo 1)" \
  "exit=$rc session=${BUILD_SESSION:-none}"
MODE=answered API_URL="$API_URL" SESSION_ID="$BUILD_SESSION" LABEL=build \
  EVIDENCE_DIR="$EVIDENCE_DIR" bun "$PROBE" > "$RUN_DIR/probe-build.log" 2>&1
probe_rc=$?
cat "$RUN_DIR/probe-build.log"
check "the builder run answered, with no verify call (probe)" "$probe_rc" "see requires-build.json"
# The branch's diff, from git itself: what the board's non_empty_diff measures too.
git -C "$REPO" diff --numstat "main...factory/${BUILD_SESSION:-none}" > "$EVIDENCE_DIR/requires-build-diff.txt" 2>&1
check "the builder run's branch carries its committed change" \
  "$(grep -qE '^[0-9]+[[:space:]]+[0-9]+[[:space:]]+apps/web/src/built.ts$' "$EVIDENCE_DIR/requires-build-diff.txt" && echo 0 || echo 1)" \
  "$(head -1 "$EVIDENCE_DIR/requires-build-diff.txt" | tr '\t' ' ')"

rc="$(cli requires-building-no-pr.txt board move --task "$TASK_ID" --to review --expect-revision "$REVISION" --actor "${BUILD_SESSION:-ses_missing}")"
check "with the change but no PR, building → review is refused naming pr_link" \
  "$([ "$rc" != "0" ] && grep -qF 'error: requirement_unmet: the move building → review needs "pr_link" (a PR link), which is not met: the card'"'"'s latest run '"${BUILD_SESSION:-ses_missing}"' recorded no PR' "$EVIDENCE_DIR/requires-building-no-pr.txt" && echo 0 || echo 1)" \
  "exit=$rc"
rc="$(cli requires-show-building.txt board show --task "$TASK_ID")"
check "the refused card is still in building at the same revision" \
  "$([ "$rc" = "0" ] && grep -qx "column    building" "$EVIDENCE_DIR/requires-show-building.txt" && grep -qx "revision  $REVISION" "$EVIDENCE_DIR/requires-show-building.txt" && echo 0 || echo 1)" \
  "exit=$rc"

rc="$(cli requires-pr.txt pr "${BUILD_SESSION:-ses_missing}")"
PR_URL="$(sed -n 's/^pr       \(https:\/\/[^ ]*\)$/\1/p' "$EVIDENCE_DIR/requires-pr.txt" | head -1)"
check "factory pr opens the builder run's PR on the fake forge" \
  "$([ "$rc" = "0" ] && [ -n "$PR_URL" ] && grep -qF "\"url\": \"$PR_URL\"" "$LEDGER" && echo 0 || echo 1)" \
  "exit=$rc ${PR_URL:-no link}"

rc="$(cli requires-move-review.txt board move --task "$TASK_ID" --to review --expect-revision "$REVISION" --actor "${BUILD_SESSION:-ses_missing}")"
if [ "$rc" = "0" ] && grep -q "moved $TASK_ID to review (revision $((REVISION + 1)))" "$EVIDENCE_DIR/requires-move-review.txt"; then
  REVISION=$((REVISION + 1))
fi
check "with the change and its PR, the run's building → review goes through" \
  "$([ "$REVISION" = "5" ] && echo 0 || echo 1)" "exit=$rc revision=$REVISION"

# --- 1. no evidence: refused, naming the requirement -------------------------------------------------
rc="$(cli requires-refused-none.txt board move --task "$TASK_ID" --to done --expect-revision "$REVISION")"
check "with no evidence, review → done is refused as requirement_unmet" \
  "$(grep -qF 'error: requirement_unmet: the move review → done needs "verified"' "$EVIDENCE_DIR/requires-refused-none.txt" && echo 0 || echo 1)" \
  "$(head -1 "$EVIDENCE_DIR/requires-refused-none.txt" | cut -c1-120)"
check "and the refusal says what is missing, not just denied" \
  "$(grep -qF "which is not met: none of the card's 1 run(s) recorded a verify call over a change (0 call(s) recorded)" "$EVIDENCE_DIR/requires-refused-none.txt" && echo 0 || echo 1)" \
  "reason verbatim"
check "and it exits non-zero" "$([ "$rc" != "0" ] && echo 0 || echo 1)" "exit=$rc"
rc="$(cli requires-show-refused.txt board show --task "$TASK_ID")"
check "the refused card is still in review at the same revision" \
  "$([ "$rc" = "0" ] && grep -qx "column    review" "$EVIDENCE_DIR/requires-show-refused.txt" && grep -qx "revision  $REVISION" "$EVIDENCE_DIR/requires-show-refused.txt" && echo 0 || echo 1)" \
  "exit=$rc"

# A run on the card: open it with `board start`, then wait for its verify record and check it.
start_run() { # label, expect
  local label="$1"
  rc="$(cli "requires-start-$label.txt" board start --task "$TASK_ID" --prompt "make the change and verify it")"
  RUN_SESSION="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/requires-start-$label.txt" | head -1)"
  check "board start opens the $label run on the card" \
    "$([ "$rc" = "0" ] && [ -n "$RUN_SESSION" ] && grep -q "task    $TASK_ID in review" "$EVIDENCE_DIR/requires-start-$label.txt" && echo 0 || echo 1)" \
    "exit=$rc session=${RUN_SESSION:-none}"
  MODE=settled API_URL="$API_URL" SESSION_ID="$RUN_SESSION" LABEL="$label" EXPECT="$2" \
    EVIDENCE_DIR="$EVIDENCE_DIR" bun "$PROBE" > "$RUN_DIR/probe-$label.log" 2>&1
  local probe_rc=$?
  cat "$RUN_DIR/probe-$label.log"
  check "the $label run recorded $2 (probe)" "$probe_rc" "see requires-$label.json"
}

# --- 2. a passing verification of web ----------------------------------------------------------------
next_change 'mkdir -p apps/web/src && echo "export const page = 1;" > apps/web/src/page.ts && echo changed web'
start_run web "web:VerifyRan:0"
WEB_SESSION="$RUN_SESSION"

# --- 3. the change moves to api, which nothing verifies: web's evidence does not count ---------------
next_change 'mkdir -p apps/api/src && echo "export const feature = 1;" > apps/api/src/feature.ts && echo changed api'
start_run api-unverified "api:VerifyNoEvidence"
API_SESSION="$RUN_SESSION"
rc="$(cli requires-refused-surface.txt board move --task "$TASK_ID" --to done --expect-revision "$REVISION")"
check "evidence from a different surface (web) does not satisfy verified" \
  "$([ "$rc" != "0" ] && grep -qF 'error: requirement_unmet: the move review → done needs "verified"' "$EVIDENCE_DIR/requires-refused-surface.txt" && echo 0 || echo 1)" \
  "exit=$rc"
check "and the refusal names the surface the change touched, from the latest run" \
  "$(grep -qF "run $API_SESSION's latest verify call over the change: api: no verification (" "$EVIDENCE_DIR/requires-refused-surface.txt" && ! grep -qF "$WEB_SESSION" "$EVIDENCE_DIR/requires-refused-surface.txt" && echo 0 || echo 1)" \
  "names api in ${API_SESSION:-?}"
check "and the refusal names the remedy for a surface nothing can verify" \
  "$(grep -qF 'declare the repo'"'"'s verify command (commands.verify in .factory/config) or add a .pi/skills/verify-<surface>/ driver' "$EVIDENCE_DIR/requires-refused-surface.txt" && echo 0 || echo 1)" \
  "names commands.verify and verify-<surface>"

# --- 4. api verified: the same move goes through -----------------------------------------------------
next_change 'mkdir -p apps/api/src .pi/skills/verify-api && echo "export const feature = 2;" > apps/api/src/feature.ts && printf "echo \"verify-api fixture: 3/3 checks passed\"\n" > .pi/skills/verify-api/drive.sh && echo changed api with its skill'
start_run api-verified "api:VerifyRan:0"
rc="$(cli requires-done.txt board move --task "$TASK_ID" --to done --expect-revision "$REVISION")"
check "once the change's surface passed, the same review → done goes through" \
  "$([ "$rc" = "0" ] && grep -q "moved $TASK_ID to done (revision $((REVISION + 1)))" "$EVIDENCE_DIR/requires-done.txt" && echo 0 || echo 1)" \
  "exit=$rc"

stop_api
cp "$LOG" "$EVIDENCE_DIR/requires-api.log"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "taskId": "%s",\n' "$TASK_ID"
  printf '  "definitionVersion": "%s",\n' "$VERSION"
  printf '  "runs": {"build": "%s", "web": "%s", "apiUnverified": "%s", "apiVerified": "%s"},\n' "${BUILD_SESSION:-}" "${WEB_SESSION:-}" "${API_SESSION:-}" "${RUN_SESSION:-}"
  printf '  "prUrl": "%s",\n' "${PR_URL:-}"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/requires-observed.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "requires: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "requires: FAILURES — see $EVIDENCE_DIR/requires-observed.json" >&2
fi
exit "$failed"
