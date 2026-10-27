#!/usr/bin/env bash
# Drive the board: create a card, then `factory board ls|show|move|start` in a real tmux terminal —
# the moves and the three refusals — then read the board back in the dashboard, capturing evidence.
#
# A command line is only proven by running it the way a person does: a real terminal, a real control
# plane, and the text it printed read back. Calling the RPC client from a test process would prove
# the client and nothing about the command — argument parsing, the lane ordering the human reads, the
# refusal message on stderr, and the exit code a script branches on all live outside the client.
#
# The three refusals (LOB-84) are the three ways a move is supposed to fail, each matched by the
# service's own words and a non-zero exit: an undeclared transition, a stale expected revision, and a
# run actor crossing a human gate. Every check is required; the drive exits non-zero on any miss.
#
# Between the run's start and the move to `planning` the card takes the question path (LOB-85,
# docs/board.md B7): the run in `specifying` asks and parks — not busy, the card blocked
# `needs_input` — a person answers with `board comment`, and the next run's recorded prompt quotes
# the answer verbatim. The two facts no command prints (is the run busy, what was it told) are
# `ask.ts`'s probes, as in ask.sh; everything a person reads is read back from the pane.
#
# After the dashboard reads the card back in `planning`, the drive takes it the rest of the way
# (LOB-86, docs/board.md B4, B5, B8): a person approves the plan (`planning → building`), a run in
# `building` makes a change, commits it and verifies it, `factory pr` opens its PR on the loopback
# GitHub fake, and the drive asserts a non-empty diff, a link the forge answered, and a body whose
# evidence section names the verify skill and its exit code. The run moves its card to `review`, a
# person records the verdict on the card, the run's own `review → done` is refused at the merge gate,
# and the person's merge goes through. The PR is never assumed: with no GitHub path (./up.sh with
# BOARD_GITHUB=off) `factory pr` fails, the drive prints that reason and exits non-zero, and the
# phases after it run on with the link empty rather than one the drive made up.
#
# Requires the instance from ./up.sh (API on :9400, web on :3400, a seeded board in
# .verify/run/board.json). The card is the drive's own, created through `createTask` (create.ts), so
# the drive can run twice against one instance — after a failed drive too: the checks find this
# drive's card by id, not by being the only card in its lane.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run"
WEB_PORT="${WEB_PORT:-$(cat "$RUN_DIR/web-port" 2>/dev/null || echo 3400)}"
WEB_URL="${WEB_URL:-http://localhost:$WEB_PORT}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
SOCK="$RUN_DIR/board-tmux.sock"
TERM_SESSION="verify-board"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
SKILL="$ROOT/.pi/skills/verify-board"
PROBE="$SKILL/ask.ts"
BUILD_PROBE="$SKILL/build.ts"
LEDGER="$RUN_DIR/github-ledger.json"
BOARD_REPO="$RUN_DIR/board-repo"
# The one path the builder's faux script writes (./up.sh's BUILD_CHANGE).
BUILD_CHANGED="apps/web/src/card.ts"

mkdir -p "$EVIDENCE_DIR"

if [ ! -s "$RUN_DIR/board.json" ]; then
  echo "no seeded board in $RUN_DIR/board.json — run ./up.sh first" >&2
  exit 1
fi

json() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$2"; }
BOARD_ID="$(json boardId "$RUN_DIR/board.json")"
BOARD_REPO_SLUG="$(json repo "$RUN_DIR/board.json")"
# The default pipeline of the seeded definition (0007_create_tasks.ts), in declaration order.
LANES="intake specifying planning building review done canceled"
# The question ./up.sh's faux script asks (FAUX_ASK), and the answer the drive types. The answer is
# two lines and an em dash, as in ask.sh: one trimmed, wrapped or re-encoded on its way into the next
# run's prompt would not be found verbatim. The pane types it as a `$'…'` word, so the shell hands
# the CLI one argument with the newline in it; ANSWER is the same bytes, for the probe.
QUESTION="$(cat "$RUN_DIR/faux-ask" 2>/dev/null)"
ANSWER_WORD="\$'Postgres 16.\\n  Keep port 5442 \\xe2\\x80\\x94 it is shared.'"
ANSWER="$(printf 'Postgres 16.\n  Keep port 5442 \xe2\x80\x94 it is shared.')"
if [ -z "$QUESTION" ]; then
  echo "no faux question in $RUN_DIR/faux-ask — run ./down.sh and ./up.sh again" >&2
  exit 1
fi

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  # A detail can quote a server's refusal (the PR phase's reason), so it is escaped for the JSON.
  local detail="${3//\\/\\\\}"
  detail="${detail//\"/\\\"}"
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$detail\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-46s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-46s %s\n' "$1" "$3"
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

# A UTF-8 locale for the pane: the human-gate refusal names the move with `→`, and a pane that
# rendered it as `_` could not match the service's words.
export LANG="${LANG:-en_US.UTF-8}" LC_ALL="${LC_ALL:-en_US.UTF-8}"
t() { tmux -u -S "$SOCK" "$@"; }
pane() { t capture-pane -p -t "$TERM_SESSION" -S -4000 | sed -e 's/[[:space:]]*$//'; }
capture() { pane > "$EVIDENCE_DIR/$1"; }

fresh() {
  t send-keys -t "$TERM_SESSION" "clear" Enter
  sleep 0.3
  t clear-history -t "$TERM_SESSION" 2>/dev/null || true
}

# Type a command, wait for its sentinel, leave the output in the pane. The sentinel is a second
# typed line so the marker cannot match its own input, and `$?` still carries the command's code.
run_cmd() { # marker, command
  local marker="$1"
  local cmd="$2"
  t send-keys -l -t "$TERM_SESSION" "$cmd"
  t send-keys -t "$TERM_SESSION" Enter
  t send-keys -l -t "$TERM_SESSION" "printf '\\n__done_%s:%s\\n' $marker \$?"
  t send-keys -t "$TERM_SESSION" Enter
  for _ in $(seq 1 300); do
    if pane | grep -q "^__done_$marker:[0-9]*$"; then
      sleep 0.2
      return 0
    fi
    sleep 0.1
  done
  return 1
}

exit_code() { pane | grep -o "__done_$1:[0-9]*" | tail -1 | cut -d: -f2; }

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi

# --- create: a card through `createTask`, the door a trigger uses ---------------------------------
# A phase that dies before it writes its evidence must not leave an earlier run's passing file
# beside this run's failing `observed.json`.
rm -f "$RUN_DIR/card.json" "$EVIDENCE_DIR/create.json" "$EVIDENCE_DIR/web.json" \
  "$EVIDENCE_DIR/web-board.png" "$EVIDENCE_DIR/observed.json" \
  "$EVIDENCE_DIR"/specify-{busy,parked,told}.json "$EVIDENCE_DIR"/build-{built,pr}.json \
  "$EVIDENCE_DIR/pr-body.md"
API_URL="$API_URL" BOARD_ID="$BOARD_ID" EVIDENCE_DIR="$EVIDENCE_DIR" CARD_FILE="$RUN_DIR/card.json" \
  bun "$SKILL/create.ts" > "$RUN_DIR/create.log" 2>&1
CREATE_RC=$?
cat "$RUN_DIR/create.log"
check "createTask creates the drive's card (create.ts)" \
  "$([ "$CREATE_RC" = "0" ] && [ -s "$RUN_DIR/card.json" ] && echo 0 || echo 1)" \
  "exit=$CREATE_RC, see create.json"
if [ ! -s "$RUN_DIR/card.json" ]; then
  echo "drive: no card to drive — see $EVIDENCE_DIR/create.json and $RUN_DIR/create.log" >&2
  exit 1
fi
TASK_ID="$(json taskId "$RUN_DIR/card.json")"
TASK_TITLE="$(json title "$RUN_DIR/card.json")"
REVISION="$(sed -n 's/.*"revision":\([0-9]*\).*/\1/p' "$RUN_DIR/card.json")"

t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -x 200 -y 60 -c "$ROOT"

# --- ls: lanes in definition order, the card in its lane ------------------------------------------
fresh
run_cmd ls "$FACTORY board ls --board $BOARD_ID --api $API_URL" || true
capture ls.txt
OBSERVED_LANES="$(grep -E '^[a-z]+  (resting|working|terminal)  [0-9]+$' "$EVIDENCE_DIR/ls.txt" | awk '{print $1}' | tr '\n' ' ' | sed 's/ $//')"
# The lane a card line sits under: the indented lines after a lane line, up to the next lane line.
# The board is shared by every drive against this instance, and a drive that stopped before its
# first move leaves its card in `intake`, so the check finds *this* card under `intake` whatever the
# lane's count is, rather than assuming it is the only one there.
lane_of() { # task id, ls capture
  awk -v id="$1" '
    /^[a-z]+  (resting|working|terminal)  [0-9]+$/ { lane = $1; next }
    /^  / && lane != "" && index($0, id) > 0 { print lane; exit }
  ' "$2"
}
CARD_LANE="$(lane_of "$TASK_ID" "$EVIDENCE_DIR/ls.txt")"
check "the created card is at revision 1 in intake" \
  "$([ "$REVISION" = "1" ] && [ "$CARD_LANE" = "intake" ] && echo 0 || echo 1)" \
  "revision=$REVISION, lane=${CARD_LANE:-none}"
check "board ls exits 0" "$([ "$(exit_code ls)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code ls)"
check "ls prints every lane in definition order" \
  "$([ "$OBSERVED_LANES" = "$LANES" ] && echo 0 || echo 1)" \
  "lanes=[${OBSERVED_LANES}]"
check "the card sits in its own lane" \
  "$([ "$CARD_LANE" = "intake" ] && echo 0 || echo 1)" \
  "$TASK_ID under ${CARD_LANE:-no lane}"

# --- show: one card, as the server has it ----------------------------------------------------------
fresh
run_cmd show "$FACTORY board show --task $TASK_ID --api $API_URL" || true
capture show.txt
check "board show exits 0" "$([ "$(exit_code show)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code show)"
check "show prints the card's revision" \
  "$(grep -qx "revision  $REVISION" "$EVIDENCE_DIR/show.txt" && echo 0 || echo 1)" \
  "revision=$REVISION"
check "show prints the card's title" \
  "$(grep -qxF "title     $TASK_TITLE" "$EVIDENCE_DIR/show.txt" && echo 0 || echo 1)" \
  "title=$TASK_TITLE"

# --- move: a declared transition, at the revision read ---------------------------------------------
fresh
run_cmd move "$FACTORY board move --task $TASK_ID --to specifying --expect-revision $REVISION --api $API_URL" || true
capture move.txt
check "a declared move exits 0" "$([ "$(exit_code move)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code move)"
check "the move reports the column and the new revision" \
  "$(grep -q "moved $TASK_ID to specifying (revision $((REVISION + 1)))" "$EVIDENCE_DIR/move.txt" && echo 0 || echo 1)" \
  "revision $REVISION → $((REVISION + 1))"

# --- move: the stale revision is refused with the service's own message ----------------------------
fresh
run_cmd stale "$FACTORY board move --task $TASK_ID --to planning --expect-revision $REVISION --api $API_URL" || true
capture move-stale.txt
STALE_MESSAGE="task $TASK_ID is at revision $((REVISION + 1)), not $REVISION: someone moved it first"
check "a stale revision is refused, naming the revision it found" \
  "$(grep -qF "$STALE_MESSAGE" "$EVIDENCE_DIR/move-stale.txt" && echo 0 || echo 1)" \
  "message verbatim"
check "and the refusal exits non-zero" \
  "$([ "$(exit_code stale)" != "0" ] && [ -n "$(exit_code stale)" ] && echo 0 || echo 1)" \
  "exit=$(exit_code stale)"

# --- move: an undeclared transition is refused, naming both columns --------------------------------
fresh
run_cmd undeclared "$FACTORY board move --task $TASK_ID --to done --expect-revision $((REVISION + 1)) --api $API_URL" || true
capture move-undeclared.txt
check "an undeclared transition is refused, naming both columns" \
  "$(grep -qF 'column "specifying" declares no transition to "done"' "$EVIDENCE_DIR/move-undeclared.txt" && echo 0 || echo 1)" \
  "message verbatim"
check "and the undeclared refusal exits non-zero" \
  "$([ "$(exit_code undeclared)" != "0" ] && [ -n "$(exit_code undeclared)" ] && echo 0 || echo 1)" \
  "exit=$(exit_code undeclared)"

# --- start: a run bound to the card, sent a prompt so it takes a turn -----------------------------
fresh
run_cmd start "$FACTORY board start --task $TASK_ID --prompt 'specify this card' --api $API_URL" || true
capture start.txt
SESSION_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/start.txt" | head -1)"
check "board start exits 0" "$([ "$(exit_code start)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code start)"
check "start opens a session against the card" \
  "$([ -n "$SESSION_ID" ] && grep -q "task    $TASK_ID in specifying" "$EVIDENCE_DIR/start.txt" && echo 0 || echo 1)" \
  "session=${SESSION_ID:-none}"
check "and sends the run its prompt" \
  "$(grep -qx 'sent    specify this card' "$EVIDENCE_DIR/start.txt" && echo 0 || echo 1)" \
  "prompt verbatim"

# --- specify: the run asks and parks (LOB-85) -------------------------------------------------------
# up.sh's FAUX_COMMAND sleeps, so the run is busy first: without that control, "not busy after the
# ask" could not tell a parked run from a probe that never saw it busy.
probe() { # mode, extra env...
  local mode="$1"
  shift
  env MODE="$mode" API_URL="$API_URL" TASK_ID="$TASK_ID" QUESTION="$QUESTION" ANSWER="$ANSWER" \
    EVIDENCE_DIR="$EVIDENCE_DIR" EVIDENCE_PREFIX=specify "$@" bun "$PROBE" > "$RUN_DIR/specify-$mode.log" 2>&1
  local rc=$?
  cat "$RUN_DIR/specify-$mode.log"
  return "$rc"
}
probe busy SESSION_ID="${SESSION_ID:-}"
check "the run is busy while its turn runs (the control)" "$?" "see specify-busy.json"
probe parked SESSION_ID="${SESSION_ID:-}"
check "after the ask the run is parked, not busy" "$?" "see specify-parked.json"

fresh
run_cmd asked "$FACTORY board show --task $TASK_ID --api $API_URL" || true
capture show-asked.txt
ASKED_REVISION="$(sed -n 's/^revision  \([0-9]*\)$/\1/p' "$EVIDENCE_DIR/show-asked.txt")"
check "the parked card is blocked needs_input from specifying" \
  "$([ "$(exit_code asked)" = "0" ] && grep -q '^blocked   needs_input from specifying since ' "$EVIDENCE_DIR/show-asked.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code asked), revision=${ASKED_REVISION:-?}"
check "show prints the run's question verbatim" \
  "$(grep -qF "  [question] ${SESSION_ID:-ses_missing} (revision $((REVISION + 1)))" "$EVIDENCE_DIR/show-asked.txt" && grep -qxF "    $QUESTION" "$EVIDENCE_DIR/show-asked.txt" && echo 0 || echo 1)" \
  "question by ${SESSION_ID:-none}"

# --- answer: a person's comment on the blocked card lifts the block ---------------------------------
fresh
run_cmd answer "$FACTORY board comment --task $TASK_ID --expect-revision ${ASKED_REVISION:-0} --body $ANSWER_WORD --actor person:verify-board --api $API_URL" || true
capture comment.txt
check "board comment answers the question and lifts the block" \
  "$([ "$(exit_code answer)" = "0" ] && grep -qx "answered: $TASK_ID is no longer blocked (needs_input from specifying)" "$EVIDENCE_DIR/comment.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code answer)"

fresh
run_cmd answered "$FACTORY board show --task $TASK_ID --api $API_URL" || true
capture show-answered.txt
ANSWERED_REVISION="$(sed -n 's/^revision  \([0-9]*\)$/\1/p' "$EVIDENCE_DIR/show-answered.txt")"
# The answer is printed indented under its header, one pane line per line of the body.
check "after the answer the card is unblocked, the answer under the question" \
  "$([ "$(exit_code answered)" = "0" ] && grep -qx 'blocked   -' "$EVIDENCE_DIR/show-answered.txt" && grep -qx 'thread    2' "$EVIDENCE_DIR/show-answered.txt" && grep -qF '  [answer] person:verify-board' "$EVIDENCE_DIR/show-answered.txt" && grep -qxF '      Keep port 5442 — it is shared.' "$EVIDENCE_DIR/show-answered.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code answered), revision=${ANSWERED_REVISION:-?}"

# --- the next run: told the answer ------------------------------------------------------------------
fresh
run_cmd next "$FACTORY board start --task $TASK_ID --prompt 'go on' --api $API_URL" || true
capture start-next.txt
NEXT_SESSION_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/start-next.txt" | head -1)"
check "board start opens the next run on the answered card" \
  "$([ "$(exit_code next)" = "0" ] && [ -n "$NEXT_SESSION_ID" ] && [ "$NEXT_SESSION_ID" != "$SESSION_ID" ] && echo 0 || echo 1)" \
  "exit=$(exit_code next), session=${NEXT_SESSION_ID:-none}"
probe told SESSION_ID="${NEXT_SESSION_ID:-}"
check "the next run's recorded prompt contains the answer verbatim" "$?" "see specify-told.json"

# --- move: a person moves the card on to `planning`, the column before the plan approval gate -----
fresh
run_cmd planning "$FACTORY board move --task $TASK_ID --to planning --expect-revision ${ANSWERED_REVISION:-0} --api $API_URL" || true
capture move-planning.txt
PLANNING_REVISION="$(sed -n "s/^moved $TASK_ID to planning (revision \([0-9]*\))$/\1/p" "$EVIDENCE_DIR/move-planning.txt")"
check "a person moves the card on to planning" \
  "$([ "$(exit_code planning)" = "0" ] && [ -n "$PLANNING_REVISION" ] && echo 0 || echo 1)" \
  "exit=$(exit_code planning), revision=${PLANNING_REVISION:-none}"

# --- move: the run crossing a human gate is refused, naming the gate -------------------------------
# The actor is the session `board start` opened, so the drive does not invent an id. The service
# only checks that the actor is a well-formed session id (TaskService's `isRunActor`), not that the
# session exists. `planning → building` is B5's plan approval gate.
fresh
run_cmd gate "$FACTORY board move --task $TASK_ID --to building --expect-revision ${PLANNING_REVISION:-0} --actor ${SESSION_ID:-ses_missing} --api $API_URL" || true
capture move-gate.txt
GATE_MESSAGE="human_gate_required: the move planning → building crosses the plan approval gate, which only a person can make"
check "a run crossing the plan approval gate is refused, naming the gate" \
  "$([ -n "$SESSION_ID" ] && grep -qF "$GATE_MESSAGE" "$EVIDENCE_DIR/move-gate.txt" && echo 0 || echo 1)" \
  "actor=${SESSION_ID:-none}, message verbatim"
check "and the gate refusal exits non-zero" \
  "$([ "$(exit_code gate)" != "0" ] && [ -n "$(exit_code gate)" ] && echo 0 || echo 1)" \
  "exit=$(exit_code gate)"

# --- show: the refusals wrote nothing -------------------------------------------------------------
fresh
run_cmd after "$FACTORY board show --task $TASK_ID --api $API_URL" || true
capture show-after.txt
check "after the refusals the card is where the last accepted move put it" \
  "$([ "$(exit_code after)" = "0" ] && grep -qx "column    planning" "$EVIDENCE_DIR/show-after.txt" && grep -qx "revision  ${PLANNING_REVISION:-none}" "$EVIDENCE_DIR/show-after.txt" && echo 0 || echo 1)" \
  "planning at revision ${PLANNING_REVISION:-none}"

# --- web: the dashboard reads the same card -------------------------------------------------------
# EXPECT_REVISION is the revision the last accepted move returned, so a refusal that bumped the
# revision reddens the web phase too, not only the `show` above.
WEB_URL="$WEB_URL" API_URL="$API_URL" BOARD_ID="$BOARD_ID" TASK_ID="$TASK_ID" EXPECT_COLUMN=planning \
  EXPECT_REVISION="${PLANNING_REVISION:-}" EVIDENCE_DIR="$EVIDENCE_DIR" node "$SKILL/web.mjs" > "$RUN_DIR/web-phase.log" 2>&1
WEB_RC=$?
cat "$RUN_DIR/web-phase.log"
check "the dashboard agrees with the server after the refusals (web.mjs)" \
  "$([ "$WEB_RC" = "0" ] && echo 0 || echo 1)" \
  "exit=$WEB_RC, see web.json"

# --- build: a person approves the plan, and a run in `building` makes the change (LOB-86) ---------
fresh
run_cmd building "$FACTORY board move --task $TASK_ID --to building --expect-revision ${PLANNING_REVISION:-0} --actor person:verify-board --api $API_URL" || true
capture move-building.txt
BUILDING_REVISION="$(sed -n "s/^moved $TASK_ID to building (revision \([0-9]*\))$/\1/p" "$EVIDENCE_DIR/move-building.txt")"
check "a person approves the plan: planning → building" \
  "$([ "$(exit_code building)" = "0" ] && [ -n "$BUILDING_REVISION" ] && echo 0 || echo 1)" \
  "exit=$(exit_code building), revision=${BUILDING_REVISION:-none}"

fresh
run_cmd build "$FACTORY board start --task $TASK_ID --prompt 'build this card' --api $API_URL" || true
capture start-build.txt
BUILD_SESSION_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/start-build.txt" | head -1)"
check "board start opens the build run in building" \
  "$([ "$(exit_code build)" = "0" ] && [ -n "$BUILD_SESSION_ID" ] && grep -q "task    $TASK_ID in building" "$EVIDENCE_DIR/start-build.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code build), session=${BUILD_SESSION_ID:-none}"

build_probe() { # mode, extra env...
  local mode="$1"
  shift
  env MODE="$mode" API_URL="$API_URL" SESSION_ID="${BUILD_SESSION_ID:-}" CHANGED="$BUILD_CHANGED" \
    EVIDENCE_DIR="$EVIDENCE_DIR" "$@" bun "$BUILD_PROBE" > "$RUN_DIR/build-$mode.log" 2>&1
  local rc=$?
  cat "$RUN_DIR/build-$mode.log"
  return "$rc"
}
build_probe built
check "the build run committed a change and verified it (build.ts)" "$?" "see build-built.json"

# The diff, from git itself rather than from anything the factory reports: the run's branch against
# the `main` it was cut from, in the fixture checkout the worktree is linked into.
DIFF="$(git -C "$BOARD_REPO" diff --numstat "main...factory/${BUILD_SESSION_ID:-none}" 2>&1)"
printf '%s\n' "$DIFF" > "$EVIDENCE_DIR/build-diff.txt"
check "the build run's branch has a non-empty diff against main" \
  "$(printf '%s\n' "$DIFF" | grep -qE "^[0-9]+[[:space:]]+[0-9]+[[:space:]]+$BUILD_CHANGED$" && echo 0 || echo 1)" \
  "$(printf '%s' "$DIFF" | head -1 | tr '\t' ' ')"

# --- pr: the run's PR, opened from the terminal; the link is read, never assumed -------------------
fresh
run_cmd pr "$FACTORY pr ${BUILD_SESSION_ID:-ses_missing} --api $API_URL" || true
capture pr.txt
PR_URL="$(sed -n 's/^pr       \(https:\/\/[^ ]*\)$/\1/p' "$EVIDENCE_DIR/pr.txt" | head -1)"
PR_REASON="$(grep -m1 '^error: ' "$EVIDENCE_DIR/pr.txt" | cut -c1-200)"
check "factory pr opens the build run's PR and prints its link" \
  "$([ "$(exit_code pr)" = "0" ] && [ -n "$PR_URL" ] && echo 0 || echo 1)" \
  "${PR_URL:-no PR (exit=$(exit_code pr)): ${PR_REASON:-no link and no reason printed}}"
if [ -z "$PR_URL" ]; then
  # The phase does not stop or substitute a link: every check below that needs one fails on its own.
  echo "drive: the PR path is missing — ${PR_REASON:-factory pr printed no link}" >&2
fi
build_probe pr PR_URL="$PR_URL" LEDGER="$LEDGER" REPO="$BOARD_REPO_SLUG"
check "the forge holds that PR, with the diff and the evidence in its body (build.ts)" "$?" \
  "see build-pr.json and pr-body.md"

fresh
run_cmd ls-pr "$FACTORY ls --api $API_URL" || true
capture ls-pr.txt
check "factory ls shows the build run's PR link" \
  "$([ -n "$PR_URL" ] && [ -n "$BUILD_SESSION_ID" ] && grep "^$BUILD_SESSION_ID  " "$EVIDENCE_DIR/ls-pr.txt" | grep -qF "  $PR_URL  " && echo 0 || echo 1)" \
  "row for ${BUILD_SESSION_ID:-none}"

# --- review: the run moves its card on, and a person records the verdict --------------------------
# `building → review` crosses no gate, so the run that built the change may make it (B5); the drive
# makes it with that run's id to show the difference from the merge, below.
fresh
run_cmd review "$FACTORY board move --task $TASK_ID --to review --expect-revision ${BUILDING_REVISION:-0} --actor ${BUILD_SESSION_ID:-ses_missing} --api $API_URL" || true
capture move-review.txt
REVIEW_REVISION="$(sed -n "s/^moved $TASK_ID to review (revision \([0-9]*\))$/\1/p" "$EVIDENCE_DIR/move-review.txt")"
check "the build run moves its card on to review (no gate on that move)" \
  "$([ "$(exit_code review)" = "0" ] && [ -n "$REVIEW_REVISION" ] && echo 0 || echo 1)" \
  "exit=$(exit_code review), revision=${REVIEW_REVISION:-none}"

VERDICT="verdict: approve ${PR_URL:-(no PR)} — verify-web exit 0"
fresh
run_cmd verdict "$FACTORY board comment --task $TASK_ID --expect-revision ${REVIEW_REVISION:-0} --body '$VERDICT' --actor person:reviewer --api $API_URL" || true
capture verdict.txt
VERDICT_EXIT="$(exit_code verdict)"
VERDICT_REVISION="$(sed -n "s/^commented on $TASK_ID (revision \([0-9]*\))$/\1/p" "$EVIDENCE_DIR/verdict.txt")"
fresh
run_cmd verdict-show "$FACTORY board show --task $TASK_ID --api $API_URL" || true
capture show-verdict.txt
# A comment is stamped with the revision it was written against; the card moves one past it.
check "a person's verdict is recorded on the card's thread" \
  "$([ "$VERDICT_EXIT" = "0" ] && [ -n "$VERDICT_REVISION" ] && grep -qF "  [note] person:reviewer (revision $REVIEW_REVISION)" "$EVIDENCE_DIR/show-verdict.txt" && grep -qxF "    $VERDICT" "$EVIDENCE_DIR/show-verdict.txt" && echo 0 || echo 1)" \
  "exit=${VERDICT_EXIT:-none}, revision=${VERDICT_REVISION:-none}"

# --- merge: the run is refused at the merge gate; the person's move reaches done -------------------
fresh
run_cmd merge-run "$FACTORY board move --task $TASK_ID --to done --expect-revision ${VERDICT_REVISION:-0} --actor ${BUILD_SESSION_ID:-ses_missing} --api $API_URL" || true
capture move-merge-run.txt
MERGE_MESSAGE="human_gate_required: the move review → done crosses the merge gate, which only a person can make"
check "the run's review → done is refused at the merge gate" \
  "$([ -n "$BUILD_SESSION_ID" ] && [ "$(exit_code merge-run)" != "0" ] && [ -n "$(exit_code merge-run)" ] && grep -qF "$MERGE_MESSAGE" "$EVIDENCE_DIR/move-merge-run.txt" && echo 0 || echo 1)" \
  "actor=${BUILD_SESSION_ID:-none}, exit=$(exit_code merge-run), message verbatim"

fresh
run_cmd merge "$FACTORY board move --task $TASK_ID --to done --expect-revision ${VERDICT_REVISION:-0} --actor person:reviewer --api $API_URL" || true
capture move-merge.txt
check "a person's review → done goes through, at the revision the refusal left" \
  "$([ "$(exit_code merge)" = "0" ] && [ -n "$VERDICT_REVISION" ] && grep -qx "moved $TASK_ID to done (revision $((VERDICT_REVISION + 1)))" "$EVIDENCE_DIR/move-merge.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code merge)"

fresh
run_cmd done "$FACTORY board show --task $TASK_ID --api $API_URL" || true
capture show-done.txt
check "the card is done" \
  "$([ "$(exit_code done)" = "0" ] && grep -qx "column    done" "$EVIDENCE_DIR/show-done.txt" && echo 0 || echo 1)" \
  "$(grep -m1 '^column' "$EVIDENCE_DIR/show-done.txt" 2>/dev/null)"

# --- evidence --------------------------------------------------------------------------------------
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "webUrl": "%s",\n' "$WEB_URL"
  printf '  "boardId": "%s",\n' "$BOARD_ID"
  printf '  "taskId": "%s",\n' "$TASK_ID"
  printf '  "sessionId": "%s",\n' "${SESSION_ID:-}"
  printf '  "nextSessionId": "%s",\n' "${NEXT_SESSION_ID:-}"
  printf '  "buildSessionId": "%s",\n' "${BUILD_SESSION_ID:-}"
  printf '  "prUrl": "%s",\n' "${PR_URL:-}"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/observed.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "drive: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "drive: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$failed"
