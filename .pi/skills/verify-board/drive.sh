#!/usr/bin/env bash
# Drive the board: add a card with `factory board add`, then `ls|show|move|start` in a real tmux terminal —
# the moves and the three refusals — then read the board back in the dashboard, capturing evidence.
#
# A command line is only proven by running it the way a person does: a real terminal, a real control
# plane, and the text it printed read back. Calling the RPC client from a test process would prove
# the client and nothing about the command — argument parsing, the lane ordering the human reads, the
# refusal message on stderr, and the exit code a script branches on all live outside the client.
#
# The card is made in the terminal (LOB-261): `board add` prints its id, revision 1 and the intake
# column; an unknown board is refused with the server's words and an empty title as `invalid_input`
# before any request, each with a non-zero exit.
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
# Before it asks, the specifying run declares the card's spec with the `spec` tool (LOB-238): its
# first attempt leaves out `gaps` and is refused naming the field, its retry is committed to its log
# and recorded on the card — `factory board show` prints it, `spec.ts` reads the log and
# `getTaskSpec`. The run after the answer declares the same spec with its gaps closed, and the card
# pane shows that one (`spec-pane.mjs`).
#
# After the dashboard reads the card back in `planning`, the drive takes it the rest of the way
# (LOB-86, docs/board.md B4, B5, B8): a person approves the plan (`planning → building`), a run in
# `building` makes a change, commits it and verifies it, the browser opens its PR (the card pane's
# run row, C7 — no `factory pr`) on the loopback GitHub fake, and the drive asserts a non-empty diff, a link the forge answered, and a body whose
# evidence section names the verify skill and its exit code. The run moves its card to `review`; a
# person's merge is refused naming `review_verdict` until a faux reviewer run — opened by the review
# trigger on a signed `pull_request` for the PR (`review.ts`, LOB-36) — records a pass on the PR's
# head (LOB-241); then the run's own `review → done` is refused at the merge gate, and the person's
# merge goes through. The PR is never assumed: with no GitHub path (./up.sh with
# BOARD_GITHUB=off) the control is refused with the missing credential's message, the drive prints
# that reason and exits non-zero, and the phases after it run on with the link empty rather than one
# the drive made up. The board holds the card too (LOB-240): `building` is left only with a
# committed change and a recorded PR, so the run's move on is refused naming `pr_link` before the PR
# is opened, and — with no GitHub path — after it.
#
# The CLI and the browser are one board (LOB-87): around the move to `planning` a browser page holds
# the card open (`both-ways.mjs`), follows the terminal's move without a reload and shows nothing of
# the run's refused one; the plan approval is then a person's click in that page, and the terminal's
# `factory board show` prints it. `./equivalence.sh` runs this drive after verify-cli's and
# verify-web's own, so the cross-check here does not repeat them.
#
# Requires the instance from ./up.sh (API on :9400, web on :3400, a seeded board in
# .verify/run/board.json). The card is the drive's own, added with `factory board add` in the pane
# (LOB-261; `add.ts` reads it back and compares a second one with what the dashboard's form sends), so
# the drive can run twice against one instance — after a failed drive too: the checks find this
# drive's card by id, not by being the only card in its lane.
set -uo pipefail

# This suite runs its API with auth off (LOB-20): its clients send no credential, and it declares
# actors (a run's session id) that only an open control plane keeps. A token exported for the
# rest of the verify skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

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
# The spec ./up.sh's faux script declares once its `gaps`-less first attempt is refused (FAUX_SPEC).
EXPECT_SPEC="$(cat "$RUN_DIR/faux-spec" 2>/dev/null)"
SPEC_GAP="$(printf '%s' "$EXPECT_SPEC" | sed -n 's/.*"gaps":\["\([^"]*\)"\].*/\1/p')"
if [ -z "$EXPECT_SPEC" ] || [ -z "$SPEC_GAP" ]; then
  echo "no faux spec in $RUN_DIR/faux-spec — run ./down.sh and ./up.sh again" >&2
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

# Clear the pane and its history. The history is cleared only once the screen is: under a loaded
# machine the shell can take longer than a fixed pause to run `clear`, and history cleared before it
# does keeps the last command's output on screen, where the next capture reads it as this command's.
fresh() {
  t send-keys -t "$TERM_SESSION" "clear" Enter
  sleep 0.3
  for _ in $(seq 1 100); do
    t capture-pane -p -t "$TERM_SESSION" | grep -q '__done_' || break
    sleep 0.1
  done
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

# How many cards the board lists, over the same command a person reads them with.
cards_on_board() {
  $FACTORY board ls --board "$BOARD_ID" --api "$API_URL" 2>/dev/null | grep -c '^  tsk_'
}

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi

# --- add: the drive's card, through `factory board add` (LOB-261) --------------------------------
# A phase that dies before it writes its evidence must not leave an earlier run's passing file
# beside this run's failing `observed.json`.
rm -f "$EVIDENCE_DIR/add.json" "$EVIDENCE_DIR/web.json" \
  "$EVIDENCE_DIR/web-board.png" "$EVIDENCE_DIR/observed.json" \
  "$EVIDENCE_DIR"/add{,-pair,-unknown,-empty}.txt \
  "$EVIDENCE_DIR"/specify-{busy,parked,told}.json "$EVIDENCE_DIR"/build-{built,pr}.json \
  "$EVIDENCE_DIR/pr-body.md" "$EVIDENCE_DIR/review-drive.json" \
  "$EVIDENCE_DIR"/spec-{declared,closed}.json "$EVIDENCE_DIR"/spec-pane.{json,png} \
  "$EVIDENCE_DIR/both-ways.json" "$EVIDENCE_DIR"/both-ways-{cli,browser}.png \
  "$EVIDENCE_DIR"/pr-browser.{json,png} "$EVIDENCE_DIR/pr.txt" "$EVIDENCE_DIR"/{move,show}-building.txt "$EVIDENCE_DIR"/attention{,-board,-bad}.txt \
  "$EVIDENCE_DIR"/{runs,block,block-stale,block-again,unblock,unblock-stale}.txt \
  "$EVIDENCE_DIR"/show-{blocked,unblocked}.txt

t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -x 200 -y 60 -c "$ROOT"

# The drive's card names no repository and no priority: it inherits the board's repo (LOB-255) and
# opens `normal`. Its body is two lines, the second indented, typed as a `$'…'` word so the CLI is
# handed one argument with the newline in it; `show` prints it back. The title is unique per drive,
# so a second drive against one instance finds its own card by id.
TASK_TITLE="verify-board card $RANDOM$RANDOM"
CARD_BODY="$(printf 'Pin the Postgres major.\n  Keep port 5442.')"
CARD_BODY_WORD="\$'Pin the Postgres major.\\n  Keep port 5442.'"
fresh
run_cmd add "$FACTORY board add --board $BOARD_ID --title '$TASK_TITLE' --body $CARD_BODY_WORD --api $API_URL" || true
capture add.txt
ADD_LINE="$(grep -E '^task tsk_[0-9a-z]{26} revision [0-9]+ column [a-z]+$' "$EVIDENCE_DIR/add.txt" | tail -1)"
TASK_ID="$(echo "$ADD_LINE" | awk '{print $2}')"
REVISION="$(echo "$ADD_LINE" | awk '{print $4}')"
ADD_COLUMN="$(echo "$ADD_LINE" | awk '{print $6}')"
check "board add exits 0" "$([ "$(exit_code add)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code add)"
check "board add prints the id, revision 1 and the intake column" \
  "$([ -n "$TASK_ID" ] && [ "$REVISION" = "1" ] && [ "$ADD_COLUMN" = "intake" ] && echo 0 || echo 1)" \
  "${ADD_LINE:-no line}"
if [ -z "$TASK_ID" ]; then
  echo "drive: no card to drive — see $EVIDENCE_DIR/add.txt" >&2
  exit 1
fi

# A second card with every flag the command takes, the body from a file. It is compared in
# `add.ts` with one `createTask` makes from the same inputs — what the dashboard's form sends.
PAIR_TITLE="verify-board pair $RANDOM$RANDOM"
PAIR_BODY="$(printf '## Goal\n  keep 5442')"
PAIR_BASE_REF="main"
printf '%s' "$PAIR_BODY" > "$RUN_DIR/pair-body.md"
fresh
run_cmd pair "$FACTORY board add --board $BOARD_ID --title '$PAIR_TITLE' --body-file $RUN_DIR/pair-body.md --repo $BOARD_REPO_SLUG --priority urgent --base-ref $PAIR_BASE_REF --api $API_URL" || true
capture add-pair.txt
PAIR_ID="$(grep -oE '^task tsk_[0-9a-z]{26}' "$EVIDENCE_DIR/add-pair.txt" | tail -1 | awk '{print $2}')"
check "board add with every flag exits 0 and prints a card" \
  "$([ "$(exit_code pair)" = "0" ] && [ -n "$PAIR_ID" ] && echo 0 || echo 1)" \
  "exit=$(exit_code pair), card=${PAIR_ID:-none}"

# The two refusals. The unknown board is the server's, printed verbatim; the empty title is the
# CLI's own, and is refused before any request — the command is pointed at a port nothing listens
# on, so a request would end as a connection error, not as `invalid_input`.
CARDS_BEFORE="$(cards_on_board)"
UNKNOWN_BOARD="brd_00000000000000000000000000"
fresh
run_cmd unknown "$FACTORY board add --board $UNKNOWN_BOARD --title nothing --api $API_URL" || true
capture add-unknown.txt
check "an unknown board is refused with the server's own words" \
  "$(grep -qxF "error: board_not_found: no board $UNKNOWN_BOARD" "$EVIDENCE_DIR/add-unknown.txt" && echo 0 || echo 1)" \
  "message verbatim"
check "and the unknown-board refusal exits non-zero" \
  "$([ "$(exit_code unknown)" != "0" ] && [ -n "$(exit_code unknown)" ] && echo 0 || echo 1)" \
  "exit=$(exit_code unknown)"
fresh
run_cmd empty "$FACTORY board add --board $BOARD_ID --title '  ' --api http://127.0.0.1:1" || true
capture add-empty.txt
check "an empty title is refused as invalid_input before any request" \
  "$(grep -q '^error: invalid_input: ' "$EVIDENCE_DIR/add-empty.txt" && echo 0 || echo 1)" \
  "$(grep '^error:' "$EVIDENCE_DIR/add-empty.txt" | head -1)"
check "and the empty-title refusal exits non-zero" \
  "$([ "$(exit_code empty)" != "0" ] && [ -n "$(exit_code empty)" ] && echo 0 || echo 1)" \
  "exit=$(exit_code empty)"

API_URL="$API_URL" BOARD_ID="$BOARD_ID" EVIDENCE_DIR="$EVIDENCE_DIR" \
  TASK_ID="$TASK_ID" TITLE="$TASK_TITLE" BODY="$CARD_BODY" PAIR_ID="$PAIR_ID" \
  PAIR_TITLE="$PAIR_TITLE" PAIR_BODY="$PAIR_BODY" PAIR_PRIORITY=urgent PAIR_BASE_REF="$PAIR_BASE_REF" \
  CARDS_BEFORE="$CARDS_BEFORE" bun "$SKILL/add.ts" > "$RUN_DIR/add.log" 2>&1
ADD_RC=$?
cat "$RUN_DIR/add.log"
check "the cards read back as made (add.ts)" \
  "$([ "$ADD_RC" = "0" ] && echo 0 || echo 1)" \
  "exit=$ADD_RC, see add.json"

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
check "show prints the body board add was given, line by line" \
  "$(grep -qx 'body      2 lines' "$EVIDENCE_DIR/show.txt" && grep -qxF '    Pin the Postgres major.' "$EVIDENCE_DIR/show.txt" && grep -qxF '      Keep port 5442.' "$EVIDENCE_DIR/show.txt" && echo 0 || echo 1)" \
  "body of 2 lines"

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

# --- spec: the run declared the card's spec before it asked (LOB-238) ------------------------------
spec_probe() { # mode, session id
  env MODE="$1" API_URL="$API_URL" SESSION_ID="$2" TASK_ID="$TASK_ID" EXPECT_SPEC="$EXPECT_SPEC" \
    EVIDENCE_DIR="$EVIDENCE_DIR" bun "$SKILL/spec.ts" > "$RUN_DIR/spec-$1.log" 2>&1
  local rc=$?
  cat "$RUN_DIR/spec-$1.log"
  return "$rc"
}
spec_probe declared "${SESSION_ID:-}"
check "the run's spec is in its log and on the card, after a refusal naming gaps" "$?" "see spec-declared.json"

fresh
run_cmd asked "$FACTORY board show --task $TASK_ID --api $API_URL" || true
capture show-asked.txt
ASKED_REVISION="$(sed -n 's/^revision  \([0-9]*\)$/\1/p' "$EVIDENCE_DIR/show-asked.txt")"
check "the parked card is blocked needs_input from specifying" \
  "$([ "$(exit_code asked)" = "0" ] && grep -q '^blocked   needs_input from specifying since ' "$EVIDENCE_DIR/show-asked.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code asked), revision=${ASKED_REVISION:-?}"
# The spec moved the card one revision (to REVISION + 2), so the question was written at that one.
check "show prints the run's spec, its gap under it" \
  "$(grep -qxF "spec      ${SESSION_ID:-ses_missing} from specifying (revision $((REVISION + 1)))" "$EVIDENCE_DIR/show-asked.txt" && grep -qx '  gaps: 1' "$EVIDENCE_DIR/show-asked.txt" && grep -qxF "    - $SPEC_GAP" "$EVIDENCE_DIR/show-asked.txt" && echo 0 || echo 1)" \
  "spec by ${SESSION_ID:-none}"
check "show prints the run's question verbatim" \
  "$(grep -qF "  [question] ${SESSION_ID:-ses_missing} (revision $((REVISION + 2)))" "$EVIDENCE_DIR/show-asked.txt" && grep -qxF "    $QUESTION" "$EVIDENCE_DIR/show-asked.txt" && echo 0 || echo 1)" \
  "question by ${SESSION_ID:-none}"

# --- attention: the parked card is what a person is asked for (LOB-264) -----------------------------
# `board attention` lists every card that waits on a person, on every board; other drives' cards may
# be there, so the check finds this drive's card by id. The row leads with its reason and carries the
# card id second; the question the run asked is on the line under it.
fresh
run_cmd attention "$FACTORY board attention --api $API_URL" || true
capture attention.txt
check "board attention lists the parked card as a question, with its card id and the run's question" \
  "$([ "$(exit_code attention)" = "0" ] && grep -qE "^question  $TASK_ID  " "$EVIDENCE_DIR/attention.txt" && grep -A1 "^question  $TASK_ID  " "$EVIDENCE_DIR/attention.txt" | grep -qF "blocked needs_input since " && grep -A1 "^question  $TASK_ID  " "$EVIDENCE_DIR/attention.txt" | grep -qF ": $QUESTION" && echo 0 || echo 1)" \
  "exit=$(exit_code attention)"
fresh
run_cmd attention-board "$FACTORY board attention --board $BOARD_ID --api $API_URL" || true
capture attention-board.txt
check "board attention --board narrows to the drive's board and still lists the card" \
  "$([ "$(exit_code attention-board)" = "0" ] && grep -qE "^question  $TASK_ID  " "$EVIDENCE_DIR/attention-board.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code attention-board)"
fresh
run_cmd attention-bad "$FACTORY board attention --board not-a-board --api $API_URL" || true
capture attention-bad.txt
check "a malformed --board is invalid_input, sent nowhere" \
  "$([ "$(exit_code attention-bad)" != "0" ] && [ -n "$(exit_code attention-bad)" ] && grep -qF 'error: invalid_input: --board "not-a-board" is not a board id (brd_…)' "$EVIDENCE_DIR/attention-bad.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code attention-bad)"

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

# --- spec: the next run, told the answer, declared the spec with its gaps closed (LOB-238) ----------
spec_probe closed "${NEXT_SESSION_ID:-}"
check "the next run's spec, gaps closed, is in its log and on the card" "$?" "see spec-closed.json"
fresh
run_cmd specified "$FACTORY board show --task $TASK_ID --api $API_URL" || true
capture show-specified.txt
SPECIFIED_REVISION="$(sed -n 's/^revision  \([0-9]*\)$/\1/p' "$EVIDENCE_DIR/show-specified.txt")"
check "show prints the newest spec, which declares no gaps" \
  "$([ "$(exit_code specified)" = "0" ] && grep -qxF "spec      ${NEXT_SESSION_ID:-ses_missing} from specifying (revision ${ANSWERED_REVISION:-?})" "$EVIDENCE_DIR/show-specified.txt" && grep -qx '  gaps: none' "$EVIDENCE_DIR/show-specified.txt" && [ "${SPECIFIED_REVISION:-0}" = "$((${ANSWERED_REVISION:-0} + 1))" ] && echo 0 || echo 1)" \
  "exit=$(exit_code specified), revision ${ANSWERED_REVISION:-?} → ${SPECIFIED_REVISION:-?}"
WEB_URL="$WEB_URL" API_URL="$API_URL" BOARD_ID="$BOARD_ID" TASK_ID="$TASK_ID" \
  EXPECT_SESSION="${NEXT_SESSION_ID:-}" EVIDENCE_DIR="$EVIDENCE_DIR" \
  node "$SKILL/spec-pane.mjs" > "$RUN_DIR/spec-pane.log" 2>&1
SPEC_PANE_RC=$?
cat "$RUN_DIR/spec-pane.log"
check "the card pane shows the card's spec (spec-pane.mjs)" \
  "$([ "$SPEC_PANE_RC" = "0" ] && echo 0 || echo 1)" \
  "exit=$SPEC_PANE_RC, see spec-pane.json"

# --- both ways: one page holds the card through the terminal's moves (LOB-87) ---------------------
# The CLI and the browser are one board. `both-ways.mjs` opens the card's pane in a browser page now,
# and keeps that page — never reloaded — while the terminal moves the card to `planning` and a run is
# refused the plan approval; the page must follow the move and show nothing from the refusal. Then
# the person's plan approval is made *in that page*, and `factory board show` in the pane below must
# print it. The halves take turns through signal files (see both-ways.mjs); a half that is gone or
# late is a failed check here, never a hang.
BOTH_DIR="$RUN_DIR/both-ways"
rm -rf "$BOTH_DIR"
mkdir -p "$BOTH_DIR"
WEB_URL="$WEB_URL" API_URL="$API_URL" BOARD_ID="$BOARD_ID" TASK_ID="$TASK_ID" \
  OPEN_COLUMN=specifying OPEN_REVISION="${SPECIFIED_REVISION:-}" SIGNAL_DIR="$BOTH_DIR" \
  EVIDENCE_DIR="$EVIDENCE_DIR" node "$SKILL/both-ways.mjs" > "$RUN_DIR/both-ways.log" 2>&1 &
BOTH_PID=$!
trap 'kill "$BOTH_PID" 2>/dev/null || true' EXIT
both_signal() { # name, body: written beside, then renamed, so the page never reads half of it
  printf '%s\n' "$2" > "$BOTH_DIR/$1.tmp" && mv "$BOTH_DIR/$1.tmp" "$BOTH_DIR/$1"
}
both_await() { # name, seconds: prints the page's signal; non-zero once the page is gone or late
  local _
  for _ in $(seq 1 $(($2 * 10))); do
    if [ -s "$BOTH_DIR/$1" ]; then
      cat "$BOTH_DIR/$1"
      return 0
    fi
    if ! kill -0 "$BOTH_PID" 2>/dev/null; then
      [ -s "$BOTH_DIR/$1" ] && cat "$BOTH_DIR/$1"
      return 1
    fi
    sleep 0.1
  done
  return 1
}
both_reap() { # seconds: the page's exit status; a page still alive after them is killed and fails
  local _
  for _ in $(seq 1 $(($1 * 10))); do
    if ! kill -0 "$BOTH_PID" 2>/dev/null; then
      wait "$BOTH_PID"
      return $?
    fi
    sleep 0.1
  done
  echo "drive: both-ways.mjs still running after its last signal — killing it" >&2
  kill "$BOTH_PID" 2>/dev/null || true
  wait "$BOTH_PID" 2>/dev/null || true
  return 124
}
BOTH_OPENED="$(both_await opened 60)"
check "a browser page holds the card before the terminal moves it" \
  "$([ "$BOTH_OPENED" = "specifying ${SPECIFIED_REVISION:-?}" ] && echo 0 || echo 1)" \
  "page: ${BOTH_OPENED:-never opened, see both-ways.log}"

# --- move: a person moves the card on to `planning`, the column before the plan approval gate -----
fresh
run_cmd planning "$FACTORY board move --task $TASK_ID --to planning --expect-revision ${SPECIFIED_REVISION:-0} --api $API_URL" || true
capture move-planning.txt
PLANNING_REVISION="$(sed -n "s/^moved $TASK_ID to planning (revision \([0-9]*\))$/\1/p" "$EVIDENCE_DIR/move-planning.txt")"
check "a person moves the card on to planning" \
  "$([ "$(exit_code planning)" = "0" ] && [ -n "$PLANNING_REVISION" ] && echo 0 || echo 1)" \
  "exit=$(exit_code planning), revision=${PLANNING_REVISION:-none}"
both_signal cli-moved "planning ${PLANNING_REVISION:-}"
BOTH_FOLLOWED="$(both_await cli-followed 30)"
check "the terminal's move reaches the open page without a reload" \
  "$([ "$BOTH_FOLLOWED" = "pass" ] && echo 0 || echo 1)" \
  "page: ${BOTH_FOLLOWED:-no answer}, see both-ways.json"

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
# The approval is the both-ways phase's browser half: the page that followed the terminal makes it,
# and the terminal reads it back (LOB-87).
both_signal browser-move "${PLANNING_REVISION:-0}"
BROWSER_MOVED="$(both_await browser-moved 60)"
both_reap 15
BOTH_RC=$?
trap - EXIT
cat "$RUN_DIR/both-ways.log"
fresh
run_cmd building "$FACTORY board show --task $TASK_ID --api $API_URL" || true
capture show-building.txt
BUILDING_REVISION="$(sed -n 's/^revision  \([0-9]*\)$/\1/p' "$EVIDENCE_DIR/show-building.txt")"
check "a person approves the plan in the browser, and factory board show prints it" \
  "$([ "$(exit_code building)" = "0" ] && grep -qx "column    building" "$EVIDENCE_DIR/show-building.txt" && [ -n "$PLANNING_REVISION" ] && [ "${BUILDING_REVISION:-}" = "$((PLANNING_REVISION + 1))" ] && [ "${BROWSER_MOVED:-}" = "building $BUILDING_REVISION" ] && echo 0 || echo 1)" \
  "page: ${BROWSER_MOVED:-no answer}; show: $(grep -m1 '^column' "$EVIDENCE_DIR/show-building.txt" 2>/dev/null), revision ${BUILDING_REVISION:-none}"
check "the both-ways phase's browser checks pass (both-ways.mjs)" \
  "$([ "$BOTH_RC" = "0" ] && echo 0 || echo 1)" \
  "exit=$BOTH_RC, see both-ways.json"
# A browser that did not approve the plan has already failed the drive; the person approves it from
# the terminal instead, so the phases after this one still prove what they prove.
if ! grep -qx "column    building" "$EVIDENCE_DIR/show-building.txt"; then
  echo "drive: the browser did not approve the plan — approving it from the terminal" >&2
  fresh
  run_cmd building-cli "$FACTORY board move --task $TASK_ID --to building --expect-revision ${PLANNING_REVISION:-0} --actor person:verify-board --api $API_URL" || true
  capture move-building.txt
  BUILDING_REVISION="$(sed -n "s/^moved $TASK_ID to building (revision \([0-9]*\))$/\1/p" "$EVIDENCE_DIR/move-building.txt")"
fi

# --- both ways, a new card: the browser's New card is the terminal's card, and back (LOB-275) -------
# The same equivalence for a card being made rather than moved: card-create.sh's page makes a card
# from the board header's form (an empty title refused inline, a bad base ref refused by the server
# in a toast), `board ls` and `board show` list it, the terminal makes its twin with the same inputs
# (`factory board add`), the still-open page shows that one without a reload, and the server holds
# the two with the same title, body, repo, priority and base ref. Its own checks are in
# card-create.json; this folds its exit code in.
API_URL="$API_URL" WEB_URL="$WEB_URL" EVIDENCE_DIR="${EVIDENCE_DIR%/board}" \
  "$SKILL/card-create.sh" > "$RUN_DIR/card-create.log" 2>&1
CARD_CREATE_RC=$?
cat "$RUN_DIR/card-create.log"
check "a card made in the browser is the terminal's card, and back (card-create.sh)" \
  "$([ "$CARD_CREATE_RC" = "0" ] && echo 0 || echo 1)" \
  "exit=$CARD_CREATE_RC, see card-create.json"

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
build_probe built REPO="$BOARD_REPO_SLUG"
BUILT_RC=$?
check "the build run committed a change and verified it (build.ts)" "$BUILT_RC" "see build-built.json"

# The diff, from git itself rather than from anything the factory reports: the run's branch against
# the `main` it was cut from, in the fixture checkout the worktree is linked into.
DIFF="$(git -C "$BOARD_REPO" diff --numstat "main...factory/${BUILD_SESSION_ID:-none}" 2>&1)"
printf '%s\n' "$DIFF" > "$EVIDENCE_DIR/build-diff.txt"
check "the build run's branch has a non-empty diff against main" \
  "$(printf '%s\n' "$DIFF" | grep -qE "^[0-9]+[[:space:]]+[0-9]+[[:space:]]+$BUILD_CHANGED$" && echo 0 || echo 1)" \
  "$(printf '%s' "$DIFF" | head -1 | tr '\t' ' ')"

# --- the building gate: the change is there, the PR is not yet (LOB-240) ---------------------------
# `building` declares `non_empty_diff` and `pr_link`, and the service checks both on exit: the run's
# move on before its PR is opened is refused naming the PR, not the diff — the diff is the one above —
# and writes nothing, so the move after the PR is made at the same revision.
PR_LINK_MESSAGE="requirement_unmet: the move building → review needs \"pr_link\" (a PR link), which is not met: the card's latest run ${BUILD_SESSION_ID:-ses_missing} recorded no PR"
fresh
run_cmd review-early "$FACTORY board move --task $TASK_ID --to review --expect-revision ${BUILDING_REVISION:-0} --actor ${BUILD_SESSION_ID:-ses_missing} --api $API_URL" || true
capture move-review-no-pr.txt
check "before its PR, the run's building → review is refused naming pr_link" \
  "$([ -n "$BUILD_SESSION_ID" ] && [ "$(exit_code review-early)" != "0" ] && [ -n "$(exit_code review-early)" ] && grep -qF "$PR_LINK_MESSAGE" "$EVIDENCE_DIR/move-review-no-pr.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code review-early), $(grep -m1 -o 'needs "[a-z_]*"' "$EVIDENCE_DIR/move-review-no-pr.txt" 2>/dev/null)"

# --- pr: the run's PR, opened in the browser; the link is read, never assumed ----------------------
# C7: a card driven from the browser leaves `building` without `factory pr`. The page that holds the
# card open offers "Open pull request" on the run's row, the drive presses it, and the link the
# forge answered appears on the row and in the run pane's header. `pr-browser.mjs` prints the same
# `pr       <url>` line the command did (or `error: <reason>`, the control's own words), so the checks
# below read the link and the reason as they always have.
fresh
WEB_URL="$WEB_URL" BOARD_ID="$BOARD_ID" TASK_ID="$TASK_ID" SESSION_ID="${BUILD_SESSION_ID:-}" \
  EVIDENCE_DIR="$EVIDENCE_DIR" node "$SKILL/pr-browser.mjs" > "$EVIDENCE_DIR/pr.txt" 2> "$RUN_DIR/pr-browser.log"
PR_RC=$?
cat "$RUN_DIR/pr-browser.log"
PR_URL="$(sed -n 's/^pr       \(https:\/\/[^ ]*\)$/\1/p' "$EVIDENCE_DIR/pr.txt" | head -1)"
PR_REASON="$(grep -m1 '^error: ' "$EVIDENCE_DIR/pr.txt" | cut -c1-200)"
check "the browser opens the build run's PR: its link is on the card pane's run row and the run pane's header" \
  "$([ "$PR_RC" = "0" ] && [ -n "$PR_URL" ] && echo 0 || echo 1)" \
  "${PR_URL:-no PR (exit=$PR_RC): ${PR_REASON:-no link and no reason printed}}"
if [ -z "$PR_URL" ]; then
  # The phase does not stop or substitute a link: every check below that needs one fails on its own.
  echo "drive: the PR path is missing — ${PR_REASON:-the page printed no link}" >&2
fi
build_probe pr PR_URL="$PR_URL" LEDGER="$LEDGER" REPO="$BOARD_REPO_SLUG"
PR_PROBE_RC=$?
check "the forge holds that PR, with the diff and the evidence in its body (build.ts)" "$PR_PROBE_RC" \
  "see build-pr.json and pr-body.md"

fresh
run_cmd ls-pr "$FACTORY ls --api $API_URL" || true
capture ls-pr.txt
check "factory ls shows the build run's PR link" \
  "$([ -n "$PR_URL" ] && [ -n "$BUILD_SESSION_ID" ] && grep "^$BUILD_SESSION_ID  " "$EVIDENCE_DIR/ls-pr.txt" | grep -qF "  $PR_URL  " && echo 0 || echo 1)" \
  "row for ${BUILD_SESSION_ID:-none}"

# --- runs: the card's runs, each with its session, column, status and PR (LOB-264) ----------------
# Newest run first: the build run (with the PR the browser opened), then the specifying runs — the
# second one `board start` opened after the answer, then the one that asked — each with `-` for a PR
# it never had. The status is the session's own, read through `getSession`: every run here is idle.
fresh
run_cmd runs "$FACTORY board runs --task $TASK_ID --api $API_URL" || true
capture runs.txt
run_row() { grep "^$1  " "$EVIDENCE_DIR/runs.txt" | head -1; }
check "board runs prints the header and one row per run, newest first" \
  "$([ "$(exit_code runs)" = "0" ] && grep -qx 'session  column  status  pr  started' "$EVIDENCE_DIR/runs.txt" && [ "$(grep -c '^ses_' "$EVIDENCE_DIR/runs.txt")" = "3" ] && [ "$(grep '^ses_' "$EVIDENCE_DIR/runs.txt" | awk '{print $1}' | tr '\n' ' ')" = "${BUILD_SESSION_ID:-none} ${NEXT_SESSION_ID:-none} ${SESSION_ID:-none} " ] && echo 0 || echo 1)" \
  "exit=$(exit_code runs), rows: $(grep '^ses_' "$EVIDENCE_DIR/runs.txt" | awk '{print $1}' | tr '\n' ' ')"
check "the build run's row names its column, status and the PR the forge opened" \
  "$([ -n "$PR_URL" ] && run_row "${BUILD_SESSION_ID:-none}" | grep -qE "^${BUILD_SESSION_ID:-none}  building  idle  $PR_URL  [0-9T:.Z-]+$" && echo 0 || echo 1)" \
  "$(run_row "${BUILD_SESSION_ID:-none}")"
check "a specifying run's row has no PR" \
  "$(run_row "${SESSION_ID:-none}" | grep -qE "^${SESSION_ID:-none}  specifying  idle  -  [0-9T:.Z-]+$" && echo 0 || echo 1)" \
  "$(run_row "${SESSION_ID:-none}")"

# --- block, unblock: a card parked for a reason and restored (LOB-264) -----------------------------
# A block at a revision the card has already left is the typed conflict and writes nothing; the
# block at the card's own revision parks it, a second is refused, the unblock at a stale revision is
# the conflict again, and the unblock at the right one restores the card to `building`. The card ends
# two revisions on, which the review move below is made at.
fresh
run_cmd block-stale "$FACTORY board block --task $TASK_ID --reason dependency --expect-revision $((${BUILDING_REVISION:-1} - 1)) --api $API_URL" || true
capture block-stale.txt
check "a block at a stale revision is the typed conflict, and non-zero" \
  "$([ "$(exit_code block-stale)" != "0" ] && [ -n "$(exit_code block-stale)" ] && grep -qF "error: stale_revision: task $TASK_ID is at revision ${BUILDING_REVISION:-?}, not $((${BUILDING_REVISION:-1} - 1)): someone moved it first" "$EVIDENCE_DIR/block-stale.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code block-stale)"
fresh
run_cmd block "$FACTORY board block --task $TASK_ID --reason dependency --note 'waiting on the schema PR' --expect-revision ${BUILDING_REVISION:-0} --api $API_URL" || true
capture block.txt
check "board block parks the card at the revision it expected" \
  "$([ "$(exit_code block)" = "0" ] && grep -qx "blocked $TASK_ID (revision $((${BUILDING_REVISION:-0} + 1))): dependency in building" "$EVIDENCE_DIR/block.txt" && grep -qx 'note    waiting on the schema PR' "$EVIDENCE_DIR/block.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code block)"
fresh
run_cmd blocked-show "$FACTORY board show --task $TASK_ID --api $API_URL" || true
capture show-blocked.txt
check "show prints the block: its reason and the column it blocked from" \
  "$([ "$(exit_code blocked-show)" = "0" ] && grep -q '^blocked   dependency from building since ' "$EVIDENCE_DIR/show-blocked.txt" && grep -qx "revision  $((${BUILDING_REVISION:-0} + 1))" "$EVIDENCE_DIR/show-blocked.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code blocked-show)"
fresh
run_cmd block-again "$FACTORY board block --task $TASK_ID --reason capability --api $API_URL" || true
capture block-again.txt
check "a second block is refused as already_blocked" \
  "$([ "$(exit_code block-again)" != "0" ] && [ -n "$(exit_code block-again)" ] && grep -qF "error: already_blocked: task $TASK_ID is already blocked (dependency)" "$EVIDENCE_DIR/block-again.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code block-again)"
fresh
run_cmd unblock-stale "$FACTORY board unblock --task $TASK_ID --expect-revision ${BUILDING_REVISION:-0} --api $API_URL" || true
capture unblock-stale.txt
check "an unblock at a stale revision is the typed conflict, and the card stays blocked" \
  "$([ "$(exit_code unblock-stale)" != "0" ] && [ -n "$(exit_code unblock-stale)" ] && grep -qF "error: stale_revision: " "$EVIDENCE_DIR/unblock-stale.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code unblock-stale)"
fresh
run_cmd unblock "$FACTORY board unblock --task $TASK_ID --api $API_URL" || true
capture unblock.txt
UNBLOCKED_REVISION="$(sed -n "s/^unblocked $TASK_ID (revision \([0-9]*\)).*/\1/p" "$EVIDENCE_DIR/unblock.txt")"
check "board unblock restores the card to the column it blocked from" \
  "$([ "$(exit_code unblock)" = "0" ] && [ "${UNBLOCKED_REVISION:-0}" = "$((${BUILDING_REVISION:-0} + 2))" ] && grep -q "^unblocked $TASK_ID (revision ${UNBLOCKED_REVISION}): back in building (was dependency since " "$EVIDENCE_DIR/unblock.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code unblock), revision=${UNBLOCKED_REVISION:-none}"
fresh
run_cmd unblocked-show "$FACTORY board show --task $TASK_ID --api $API_URL" || true
capture show-unblocked.txt
check "show prints the card unblocked, in building" \
  "$([ "$(exit_code unblocked-show)" = "0" ] && grep -qx 'blocked   -' "$EVIDENCE_DIR/show-unblocked.txt" && grep -qx 'column    building' "$EVIDENCE_DIR/show-unblocked.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code unblocked-show)"
BUILDING_REVISION="${UNBLOCKED_REVISION:-$BUILDING_REVISION}"

# --- review: the run moves its card on ------------------------------------------------------------
# `building → review` crosses no gate, so the run that built the change may make it (B5); the drive
# makes it with that run's id to show the difference from the merge, below. With no PR (BOARD_GITHUB=
# off) the board refuses it naming `pr_link` (LOB-240): the check fails with that refusal as its
# detail, the card stays in `building`, and every phase after it fails on its own.
fresh
run_cmd review "$FACTORY board move --task $TASK_ID --to review --expect-revision ${BUILDING_REVISION:-0} --actor ${BUILD_SESSION_ID:-ses_missing} --api $API_URL" || true
capture move-review.txt
REVIEW_REVISION="$(sed -n "s/^moved $TASK_ID to review (revision \([0-9]*\))$/\1/p" "$EVIDENCE_DIR/move-review.txt")"
check "the build run moves its card on to review (no gate on that move)" \
  "$([ "$(exit_code review)" = "0" ] && [ -n "$REVIEW_REVISION" ] && echo 0 || echo 1)" \
  "exit=$(exit_code review), revision=${REVIEW_REVISION:-none}$(grep -m1 -o ' requirement_unmet: .* needs "[a-z_]*"' "$EVIDENCE_DIR/move-review.txt" 2>/dev/null)"
if [ -z "$PR_URL" ]; then
  # The gate is the board's, not the drive's: with no PR the card is held in building.
  check "with no PR, the board holds the card in building, naming pr_link" \
    "$([ "$(exit_code review)" != "0" ] && grep -qF "$PR_LINK_MESSAGE" "$EVIDENCE_DIR/move-review.txt" && echo 0 || echo 1)" \
    "exit=$(exit_code review)"
fi

# --- the reviewer's verdict: a faux reviewer run on the PR's head, not a person's comment (LOB-241) --
# `review` declares `review_verdict`, so until a review run of the card records a pass on the PR's
# head, a person's merge is refused naming it — the evidence (`verified`) is met by now, so the refusal
# is about the review alone. The review comes the way a deployment gets one: GitHub tells the API
# about the PR (`POST /webhooks/github`, signed with the instance's GITHUB_WEBHOOK_SECRET, which
# `review.ts` sends since the loopback fake sends no webhooks), the review trigger opens a reviewer
# run of the card at the PR's head (LOB-36), and its faux model (./up.sh's `faux/reviewer`) reads the
# diff and records a clean pass in its log's `factory.review`.
fresh
run_cmd merge-unreviewed "$FACTORY board move --task $TASK_ID --to done --expect-revision ${REVIEW_REVISION:-0} --actor person:reviewer --api $API_URL" || true
capture move-merge-unreviewed.txt
UNREVIEWED_MESSAGE='requirement_unmet: the move review → done needs "review_verdict" (a review verdict), which is not met: no review ran: '
check "with no review run, a person's review → done is refused naming review_verdict" \
  "$([ "$(exit_code merge-unreviewed)" != "0" ] && [ -n "$(exit_code merge-unreviewed)" ] && grep -qF "$UNREVIEWED_MESSAGE" "$EVIDENCE_DIR/move-merge-unreviewed.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code merge-unreviewed), $(grep -m1 -o 'needs "[a-z_]*"' "$EVIDENCE_DIR/move-merge-unreviewed.txt" 2>/dev/null)"

PR_HEAD="$(git -C "$BOARD_REPO" rev-parse "factory/${BUILD_SESSION_ID:-none}" 2>/dev/null)"
PR_BASE="$(git -C "$BOARD_REPO" rev-parse main 2>/dev/null)"
if [ -n "$PR_URL" ] && [ -n "$PR_HEAD" ]; then
  env MODE=review API_URL="$API_URL" GITHUB_WEBHOOK_SECRET="$(cat "$RUN_DIR/webhook-secret" 2>/dev/null)" \
    REPO="$BOARD_REPO_SLUG" PR_URL="$PR_URL" PR_NUMBER="${PR_URL##*/}" ACTION=opened \
    HEAD="$PR_HEAD" HEAD_REF="factory/$BUILD_SESSION_ID" BASE_SHA="$PR_BASE" EXPECT=pass \
    LABEL=drive EVIDENCE_DIR="$EVIDENCE_DIR" bun "$SKILL/review.ts" > "$RUN_DIR/review-drive.log" 2>&1
  REVIEW_RC=$?
else
  echo "drive: no PR to review — the review phase has nothing to deliver" > "$RUN_DIR/review-drive.log"
  REVIEW_RC=1
fi
cat "$RUN_DIR/review-drive.log"
REVIEWER_SESSION_ID="$(sed -n 's/^reviewer \(ses_[0-9a-z]\{26\}\)$/\1/p' "$RUN_DIR/review-drive.log" | head -1)"
check "the PR's opened starts a reviewer run that records a pass on its head (review.ts)" "$REVIEW_RC" \
  "reviewer=${REVIEWER_SESSION_ID:-none} head=${PR_HEAD:-none}, see review-drive.json"
fresh
run_cmd runs-reviewed "$FACTORY board runs --task $TASK_ID --api $API_URL" || true
capture runs-reviewed.txt
check "board runs lists the reviewer as the card's newest run, in review" \
  "$([ "$(exit_code runs-reviewed)" = "0" ] && [ -n "$REVIEWER_SESSION_ID" ] && grep '^ses_' "$EVIDENCE_DIR/runs-reviewed.txt" | head -1 | grep -qE "^$REVIEWER_SESSION_ID  review  idle  " && echo 0 || echo 1)" \
  "$(grep '^ses_' "$EVIDENCE_DIR/runs-reviewed.txt" 2>/dev/null | head -1)"
# The refusals wrote nothing: the merge is made at the revision the move into review left.
MERGE_REVISION="${REVIEW_REVISION:-}"

# --- merge: the run is refused at the merge gate; the person's move reaches done -------------------
fresh
run_cmd merge-run "$FACTORY board move --task $TASK_ID --to done --expect-revision ${MERGE_REVISION:-0} --actor ${BUILD_SESSION_ID:-ses_missing} --api $API_URL" || true
capture move-merge-run.txt
MERGE_MESSAGE="human_gate_required: the move review → done crosses the merge gate, which only a person can make"
check "the run's review → done is refused at the merge gate" \
  "$([ -n "$BUILD_SESSION_ID" ] && [ "$(exit_code merge-run)" != "0" ] && [ -n "$(exit_code merge-run)" ] && grep -qF "$MERGE_MESSAGE" "$EVIDENCE_DIR/move-merge-run.txt" && echo 0 || echo 1)" \
  "actor=${BUILD_SESSION_ID:-none}, exit=$(exit_code merge-run), message verbatim"

fresh
run_cmd merge "$FACTORY board move --task $TASK_ID --to done --expect-revision ${MERGE_REVISION:-0} --actor person:reviewer --api $API_URL" || true
capture move-merge.txt
check "with the reviewer's pass, a person's review → done goes through, at the revision the refusals left" \
  "$([ "$(exit_code merge)" = "0" ] && [ -n "$MERGE_REVISION" ] && grep -qx "moved $TASK_ID to done (revision $((MERGE_REVISION + 1)))" "$EVIDENCE_DIR/move-merge.txt" && echo 0 || echo 1)" \
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
  printf '  "reviewerSessionId": "%s",\n' "${REVIEWER_SESSION_ID:-}"
  printf '  "prHead": "%s",\n' "${PR_HEAD:-}"
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
