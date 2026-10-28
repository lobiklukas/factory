#!/usr/bin/env bash
# Board caps and WIP limits (LOB-71, docs/board.md B9), driven from the terminal the way a person
# starts runs: `factory board create|add|start|move` and `definition show` against the instance from
# ./up.sh, with every refusal read back verbatim and what it wrote counted in the database.
#
# A definition of the drive's own (`caps.ts MODE=define`, written as a migration writes one) has two
# versions: v1 caps board 2 · task 1 · repo 2 and gives `review` a WIP limit of 1; v2 caps board 3 ·
# task 1 · repo 3. Every run is started with `--idle` (C6: a start with no `--prompt` sends the
# card's default prompt, so the faux run would settle and give up its slot), so it stays in flight
# (it never ends its turn) and every count below is deterministic:
#
#   1. read       `definition show` prints v1's caps line and review's WIP limit
#   2. task       a second start on one card is refused at_capacity naming the task cap
#   3. board      the third start on a v1 board is refused naming the board cap; no run, no session
#   4. repo       a start on a second board over the same repository is refused naming the repo cap
#   5. column     a second run in `review` on another v1 board is refused naming the column
#   6. version    a v2 board takes three runs and refuses the fourth naming v2's board cap, while the
#                 v1 board still refuses its third naming v1's — the threshold is the pinned version's
#   7. freed      canceling a card frees its run's slot: the refused start then goes through
#
# Requires the instance from ./up.sh (API on API_PORT, default 9400) and DATABASE_URL naming its
# database (the definition is written and the rows are counted there). Exits non-zero on a failure.
set -uo pipefail

# The API runs with auth off (LOB-20), as every other board drive's.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
SKILL="$ROOT/.pi/skills/verify-board"

mkdir -p "$EVIDENCE_DIR" "$RUN_DIR"
rm -f "$EVIDENCE_DIR"/caps-*.txt "$EVIDENCE_DIR/caps.json"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL must name the instance's database (the drive's definition is written there)" >&2
  exit 1
fi
if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  local detail="${3//\\/\\\\}"
  detail="${detail//\"/\\\"}"
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$detail\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-66s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-66s %s\n' "$1" "$3"
  fi
}

rc=0
run() { # evidence name, args...
  local out="$EVIDENCE_DIR/caps-$1.txt"
  shift
  printf '$ factory %s\n' "$*" > "$out"
  "${FACTORY[@]}" "$@" --api "$API_URL" >> "$out" 2>&1
  rc=$?
}
has() { grep -qF -- "$2" "$EVIDENCE_DIR/caps-$1.txt"; }
yes_if() { "$@" && echo 0 || echo 1; }
probe() { # mode, extra env...
  local mode="$1"
  shift
  env MODE="$mode" "$@" bun "$SKILL/caps.ts" 2>>"$RUN_DIR/caps-probe.log"
}
board_of() { sed -n 's/^board  *//p' "$EVIDENCE_DIR/caps-$1.txt" | head -1; }
task_of() { grep -o 'tsk_[0-9a-z]\{26\}' "$EVIDENCE_DIR/caps-$1.txt" | head -1; }
session_of() { grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/caps-$1.txt" | head -1; }
# A start let through: exit 0 and a session id.
started() { [ "$rc" = "0" ] && [ -n "$(session_of "$1")" ]; }
# A start refused at_capacity, non-zero, naming what it counted and where the cap is configured.
refused() { # evidence name, scope phrase, source
  [ "$rc" != "0" ] && has "$1" "error: at_capacity: at capacity: at most" &&
    has "$1" "$2" && has "$1" "($3" && ! has "$1" "session ses_"
}

: > "$RUN_DIR/caps-probe.log"
HEX="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
DEF="$(probe define)"
check "a definition with two capped versions is written" \
  "$(yes_if [ -n "$DEF" ])" "${DEF:-none — see $RUN_DIR/caps-probe.log}"

# --- 1. read: the caps are definition data a person can see --------------------------------------
run show-v1 board definition show "${DEF:-missing}" --version 1
check "definition show prints v1's caps" \
  "$(yes_if has show-v1 "caps        board 2 · task 1 · repo 2 runs in flight")" "exit=$rc"
check "and review's WIP limit" \
  "$(yes_if has show-v1 "  wip       at most 1 run in flight")" "exit=$rc"
run show-v2 board definition show "${DEF:-missing}" --version 2
check "definition show prints v2's other caps, and no WIP limit" \
  "$(yes_if bash -c "grep -qF 'caps        board 3 · task 1 · repo 3 runs in flight' '$EVIDENCE_DIR/caps-show-v2.txt' && ! grep -q '  wip ' '$EVIDENCE_DIR/caps-show-v2.txt'")" \
  "exit=$rc"

# --- boards and cards ------------------------------------------------------------------------------
REPO_A="verify-caps/$HEX-a"
run board-a board create --repo "$REPO_A" --definition "${DEF:-missing}" --definition-version 1
BOARD_A="$(board_of board-a)"
run board-b board create --repo "verify-caps/$HEX-b" --definition "${DEF:-missing}" --definition-version 1
BOARD_B="$(board_of board-b)"
run board-c board create --repo "verify-caps/$HEX-c" --definition "${DEF:-missing}" --definition-version 2
BOARD_C="$(board_of board-c)"
check "three boards are made, two on v1 and one on v2" \
  "$(yes_if bash -c "[ -n '$BOARD_A' ] && [ -n '$BOARD_B' ] && [ -n '$BOARD_C' ] && grep -qF 'definition  $DEF v2' '$EVIDENCE_DIR/caps-board-c.txt'")" \
  "a=${BOARD_A:-none} b=${BOARD_B:-none} c=${BOARD_C:-none}"
BOARD_A2="$(probe second-board REPO="$REPO_A" DEFINITION_ID="${DEF:-missing}" VERSION=1)"
check "a second board over A's repository (caps.ts)" \
  "$(yes_if [ -n "$BOARD_A2" ])" "${BOARD_A2:-none}"

card() { # evidence name, board
  run "add-$1" board add --board "${2:-brd_missing}" --title "caps $1"
  task_of "add-$1"
}
A1="$(card a1 "$BOARD_A")"
A2="$(card a2 "$BOARD_A")"
A3="$(card a3 "$BOARD_A")"
X1="$(card x1 "$BOARD_A2")"
B1="$(card b1 "$BOARD_B")"
B2="$(card b2 "$BOARD_B")"
C1="$(card c1 "$BOARD_C")"
C2="$(card c2 "$BOARD_C")"
C3="$(card c3 "$BOARD_C")"
C4="$(card c4 "$BOARD_C")"
check "every card is added" \
  "$(yes_if bash -c "[ -n '$A1' ] && [ -n '$A2' ] && [ -n '$A3' ] && [ -n '$X1' ] && [ -n '$B1' ] && [ -n '$B2' ] && [ -n '$C1' ] && [ -n '$C2' ] && [ -n '$C3' ] && [ -n '$C4' ]")" \
  "a1=${A1:-none} x1=${X1:-none} c4=${C4:-none}"

# --- 2. task: one run in flight per card -----------------------------------------------------------
run start-a1 board start --task "${A1:-tsk_missing}" --idle
check "the first start on a1 goes through" "$(yes_if started start-a1)" "session=$(session_of start-a1)"
BEFORE="$(probe writes TASK_ID="${A1:-tsk_missing}")"
run start-a1-again board start --task "${A1:-tsk_missing}" --idle
AFTER="$(probe writes TASK_ID="${A1:-tsk_missing}")"
check "a second start on a1 is refused naming the task cap" \
  "$(yes_if refused start-a1-again "1 run may be in flight on task $A1" "definition $DEF v1 caps.task=1")" \
  "exit=$rc $(tail -1 "$EVIDENCE_DIR/caps-start-a1-again.txt" | cut -c1-110)"
check "and it wrote no run, no session and no log" \
  "$(yes_if [ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ])" "before=$BEFORE after=$AFTER"

# --- 3. board: two runs in flight per v1 board -----------------------------------------------------
run start-a2 board start --task "${A2:-tsk_missing}" --idle
check "a start on a2 goes through (two on board A)" "$(yes_if started start-a2)" "session=$(session_of start-a2)"
BEFORE="$(probe writes TASK_ID="${A3:-tsk_missing}")"
run start-a3 board start --task "${A3:-tsk_missing}" --idle
AFTER="$(probe writes TASK_ID="${A3:-tsk_missing}")"
check "the third start on board A is refused naming the board cap" \
  "$(yes_if refused start-a3 "2 runs may be in flight on board $BOARD_A" "definition $DEF v1 caps.board=2")" \
  "exit=$rc"
check "and names the two runs holding it" \
  "$(yes_if bash -c "grep -qF '$(session_of start-a1)' '$EVIDENCE_DIR/caps-start-a3.txt' && grep -qF '$(session_of start-a2)' '$EVIDENCE_DIR/caps-start-a3.txt'")" \
  "$(session_of start-a1) $(session_of start-a2)"
check "and it wrote no task_runs row, no session and no log" \
  "$(yes_if bash -c "[ -n '$BEFORE' ] && [ '$BEFORE' = '$AFTER' ] && printf '%s' '$AFTER' | grep -q '\"runs\":0'")" \
  "before=$BEFORE after=$AFTER"

# --- 4. repo: two runs in flight per repository, across its boards ---------------------------------
run start-x1 board start --task "${X1:-tsk_missing}" --idle
check "a start on the second board over A's repository is refused naming the repo cap" \
  "$(yes_if refused start-x1 "2 runs may be in flight in repository $REPO_A" "definition $DEF v1 caps.repo=2")" \
  "exit=$rc"

# --- 5. column: review's WIP limit of 1 on board B -------------------------------------------------
run start-b1 board start --task "${B1:-tsk_missing}" --column review --idle
check "a run in review on board B goes through" "$(yes_if started start-b1)" "session=$(session_of start-b1)"
run start-b2 board start --task "${B2:-tsk_missing}" --column review --idle
check "a second in-flight run in review is refused naming the column" \
  "$(yes_if refused start-b2 "1 run may be in flight in column review of board $BOARD_B" "definition $DEF v1 columns.review.wipLimit=1")" \
  "exit=$rc"
run start-b2-building board start --task "${B2:-tsk_missing}" --column building --idle
check "while a run in building, which declares no limit, goes through" \
  "$(yes_if started start-b2-building)" "session=$(session_of start-b2-building)"

# --- 6. version: v2's board cap is 3, and v1's cards keep 2 ----------------------------------------
for c in c1 c2 c3; do
  upper="$(printf '%s' "$c" | tr '[:lower:]' '[:upper:]')"
  run "start-$c" board start --task "${!upper:-tsk_missing}" --idle
  check "start on $c goes through on the v2 board" "$(yes_if started "start-$c")" "session=$(session_of "start-$c")"
done
run start-c4 board start --task "${C4:-tsk_missing}" --idle
check "the fourth start on the v2 board is refused naming v2's board cap of 3" \
  "$(yes_if refused start-c4 "3 runs may be in flight on board $BOARD_C" "definition $DEF v2 caps.board=3")" \
  "exit=$rc"
run start-a3-again board start --task "${A3:-tsk_missing}" --idle
check "and board A's cards, pinned to v1, still refuse a third at v1's 2" \
  "$(yes_if refused start-a3-again "2 runs may be in flight on board $BOARD_A" "definition $DEF v1 caps.board=2")" \
  "exit=$rc"

# --- 7. freed: a finished card's run holds no slot -------------------------------------------------
run cancel-a1 board move --task "${A1:-tsk_missing}" --to canceled --expect-revision 1
check "a person cancels a1" "$(yes_if bash -c "[ '$rc' = 0 ] && grep -qF 'to canceled' '$EVIDENCE_DIR/caps-cancel-a1.txt'")" "exit=$rc"
run start-a3-freed board start --task "${A3:-tsk_missing}" --idle
check "and the start a1's run blocked now goes through" "$(yes_if started start-a3-freed)" "session=$(session_of start-a3-freed)"

{
  printf '{\n  "apiUrl": "%s",\n  "definition": "%s",\n  "boards": {"a": "%s", "a2": "%s", "b": "%s", "c": "%s"},\n  "checks": {\n' \
    "$API_URL" "${DEF:-}" "${BOARD_A:-}" "${BOARD_A2:-}" "${BOARD_B:-}" "${BOARD_C:-}"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/caps.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "caps: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "caps: FAILURES — see $EVIDENCE_DIR/caps.json" >&2
fi
exit "$failed"
