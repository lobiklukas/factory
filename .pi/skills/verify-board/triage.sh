#!/usr/bin/env bash
# Drive `factory board attention` over the two reasons the instance can produce without a gated
# deployment (LOB-264): a card blocked `needs_input` (a question) and an idle run at a human gate.
# drive.sh proves the question a run asked, in a terminal; this adds the gate, the block a person
# makes by hand (`board block --reason needs_input`), and the order the server answered — questions
# before gates — which the command must print as it got it.
#
# An approval entry needs a gated call, which is a deployment setting (`APPROVAL_REQUIRED`), so it is
# proven where a gated API already runs: `.pi/skills/verify-cli/approve.sh` parks one, and
# `attentionLines` is unit-tested for its row. Plain subprocesses, as board-create.sh: what is
# asserted is stdout, stderr and the exit code.
#
# Requires the instance from ./up.sh (API on API_PORT, default 9400, a seeded board in
# .verify/run/board.json).
set -uo pipefail

# This suite runs its API with auth off (LOB-20): its clients send no credential, and it declares
# actors (a run's session id) that only an open control plane keeps. A token exported for the
# rest of the verify skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
SKILL="$ROOT/.pi/skills/verify-board"

mkdir -p "$EVIDENCE_DIR" "$RUN_DIR"
rm -f "$EVIDENCE_DIR"/triage-*.txt "$EVIDENCE_DIR/triage.json"

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi
if [ ! -s "$RUN_DIR/board.json" ]; then
  echo "no seeded board in $RUN_DIR/board.json — run ./up.sh first" >&2
  exit 1
fi
BOARD_ID="$(sed -n 's/.*"boardId":"\([^"]*\)".*/\1/p' "$RUN_DIR/board.json")"

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
    printf 'PASS  %-62s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-62s %s\n' "$1" "$3"
  fi
}

rc=0
run() { # evidence name, args...
  local out="$EVIDENCE_DIR/triage-$1.txt"
  shift
  printf '$ factory %s\n' "$*" > "$out"
  "${FACTORY[@]}" "$@" >> "$out" 2>&1
  rc=$?
}
has() { grep -qF -- "$2" "$EVIDENCE_DIR/triage-$1.txt"; }
yes_if() { "$@" && echo 0 || echo 1; }

new_card() { # name: prints the card's task id
  local file="$RUN_DIR/triage-$1.json"
  rm -f "$file"
  API_URL="$API_URL" BOARD_ID="$BOARD_ID" EVIDENCE_DIR="$RUN_DIR/triage-$1" CARD_FILE="$file" \
    bun "$SKILL/create.ts" > "$RUN_DIR/triage-$1.log" 2>&1 || return 1
  sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p' "$file"
}

# --- two cards: one asked by a person's block, one waiting at the plan approval gate ---------------
ASKED="$(new_card asked)"
GATED="$(new_card gated)"
check "two cards were created through createTask (create.ts)" \
  "$([ -n "$ASKED" ] && [ -n "$GATED" ] && [ "$ASKED" != "$GATED" ] && echo 0 || echo 1)" \
  "asked=${ASKED:-none} gated=${GATED:-none}"

# The question card: blocked needs_input by hand, with no revision named — the command reads it.
run asked-block board block --task "${ASKED:-tsk_missing}" --reason needs_input \
  --note "Which Postgres major?" --api "$API_URL"
check "board block --reason needs_input parks the card with no revision named" \
  "$([ "$rc" = "0" ] && has asked-block "blocked $ASKED (revision 2): needs_input in intake" && has asked-block "note    Which Postgres major?" && echo 0 || echo 1)" \
  "exit=$rc"

# The gate card: in planning with an idle run started there (--idle: the run opens and waits; a
# bare `board start` sends the card's prompt since C6, which would leave the run busy).
run gated-move1 board move --task "${GATED:-tsk_missing}" --to specifying --expect-revision 1 --api "$API_URL"
run gated-move2 board move --task "${GATED:-tsk_missing}" --to planning --expect-revision 2 --api "$API_URL"
check "the gate card is moved on to planning" \
  "$([ "$rc" = "0" ] && has gated-move2 "to planning (revision 3)" && echo 0 || echo 1)" "exit=$rc"
run gated-start board start --task "${GATED:-tsk_missing}" --idle --api "$API_URL"
GATE_SESSION="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/triage-gated-start.txt" | head -1)"
check "a run is started in planning and left idle" \
  "$([ "$rc" = "0" ] && [ -n "$GATE_SESSION" ] && echo 0 || echo 1)" "session=${GATE_SESSION:-none}"

# --- attention: both entries, each with its card id, questions before gates ------------------------
run attention board attention --board "$BOARD_ID" --api "$API_URL"
ATT="$EVIDENCE_DIR/triage-attention.txt"
check "board attention exits 0" "$([ "$rc" = "0" ] && echo 0 || echo 1)" "exit=$rc"
check "the blocked card is a question row, its note on the line under it" \
  "$(grep -A1 -E "^question  $ASKED  " "$ATT" | grep -qF "blocked needs_input since " && grep -A1 -E "^question  $ASKED  " "$ATT" | grep -qF ": Which Postgres major?" && echo 0 || echo 1)" \
  "$(grep -E "^question  $ASKED  " "$ATT" | cut -c1-120)"
check "the idle run's card is a gate row naming the gate, the run and the next column" \
  "$(grep -A1 -E "^gate  $GATED  " "$ATT" | grep -qF "  plan approval: ${GATE_SESSION:-none} is idle; planning → building is a person's" && echo 0 || echo 1)" \
  "$(grep -E "^gate  $GATED  " "$ATT" | cut -c1-120)"
Q_LINE="$(grep -nE "^question  $ASKED  " "$ATT" | head -1 | cut -d: -f1)"
G_LINE="$(grep -nE "^gate  $GATED  " "$ATT" | head -1 | cut -d: -f1)"
check "the order is the server's: every question before this gate" \
  "$([ -n "$Q_LINE" ] && [ -n "$G_LINE" ] && [ "$Q_LINE" -lt "$G_LINE" ] && ! awk '/^question  /{q=NR} /^gate  /{if(!g)g=NR} END{exit !(q>g && g)}' "$ATT" && echo 0 || echo 1)" \
  "question at line ${Q_LINE:-?}, gate at line ${G_LINE:-?}"

# --- the unblock takes the card off the list ---------------------------------------------------------
run asked-unblock board unblock --task "${ASKED:-tsk_missing}" --api "$API_URL"
check "board unblock lifts the person's block" \
  "$([ "$rc" = "0" ] && has asked-unblock "unblocked $ASKED (revision 3): back in intake" && echo 0 || echo 1)" "exit=$rc"
run attention-after board attention --board "$BOARD_ID" --api "$API_URL"
check "the card is no longer listed as a question, and the gate still is" \
  "$(! grep -qE "^question  $ASKED  " "$EVIDENCE_DIR/triage-attention-after.txt" && grep -qE "^gate  $GATED  " "$EVIDENCE_DIR/triage-attention-after.txt" && echo 0 || echo 1)" \
  "exit=$rc"

# --- refusals ---------------------------------------------------------------------------------------
run bad-reason board block --task "${ASKED:-tsk_missing}" --reason sleepy --api "$API_URL"
check "an unknown --reason is refused by the CLI, non-zero" \
  "$([ "$rc" != "0" ] && echo 0 || echo 1)" "exit=$rc: $(tail -1 "$EVIDENCE_DIR/triage-bad-reason.txt" | cut -c1-100)"
run bad-task board block --task nope --reason dependency --api "$API_URL"
check "a malformed --task is invalid_input, sent nowhere" \
  "$([ "$rc" != "0" ] && has bad-task 'error: invalid_input: --task "nope" is not a task id (tsk_…)' && echo 0 || echo 1)" "exit=$rc"
run not-blocked board unblock --task "${ASKED:-tsk_missing}" --api "$API_URL"
check "unblocking a card that is not blocked is the typed refusal" \
  "$([ "$rc" != "0" ] && has not-blocked "error: not_blocked: task $ASKED is not blocked" && echo 0 || echo 1)" "exit=$rc"
run empty-runs board runs --task "${ASKED:-tsk_missing}" --api "$API_URL"
check "board runs on a card with no run says so" \
  "$([ "$rc" = "0" ] && has empty-runs "no runs" && echo 0 || echo 1)" "exit=$rc"

# --- the gate card's run holds a slot: cancel the card to free it (LOB-71) -------------------------
# The shared board pins the newest default version, which caps runs in flight (2 per board, 1 per
# task). The gate run never gets a prompt, so it is in flight until its card is finished; left there,
# two triage runs would fill the board and refuse every later drive's start on it.
run gated-cancel board move --task "${GATED:-tsk_missing}" --to canceled --expect-revision 3 --api "$API_URL"
check "the gate card is canceled, freeing its run's slot on the shared board" \
  "$([ "$rc" = "0" ] && has gated-cancel "to canceled (revision 4)" && echo 0 || echo 1)" "exit=$rc"

{
  printf '{\n  "apiUrl": "%s",\n  "askedTask": "%s",\n  "gatedTask": "%s",\n  "gateSession": "%s",\n  "checks": {\n' \
    "$API_URL" "${ASKED:-}" "${GATED:-}" "${GATE_SESSION:-}"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/triage.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "triage: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "triage: FAILURES — see $EVIDENCE_DIR/triage.json" >&2
fi
exit "$failed"
