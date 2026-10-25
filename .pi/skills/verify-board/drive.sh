#!/usr/bin/env bash
# Drive `factory board ls|show|move|start` in a real tmux terminal and capture the evidence.
#
# A command line is only proven by running it the way a person does: a real terminal, a real control
# plane, and the text it printed read back. Calling the RPC client from a test process would prove
# the client and nothing about the command — argument parsing, the lane ordering the human reads, the
# refusal message on stderr, and the exit code a script branches on all live outside the client.
#
# Requires the instance from ./up.sh (API on :9400, a seeded board and card in .verify/run/board.json).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
SOCK="$RUN_DIR/board-tmux.sock"
TERM_SESSION="verify-board"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"

mkdir -p "$EVIDENCE_DIR"

if [ ! -s "$RUN_DIR/board.json" ]; then
  echo "no seeded board in $RUN_DIR/board.json — run ./up.sh first" >&2
  exit 1
fi

json() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$RUN_DIR/board.json"; }
BOARD_ID="$(json boardId)"
TASK_ID="$(json taskId)"
TASK_TITLE="$(json title)"
REVISION="$(sed -n 's/.*"revision":\([0-9]*\).*/\1/p' "$RUN_DIR/board.json")"
# The default pipeline of the seeded definition (0007_create_tasks.ts), in declaration order.
LANES="intake specifying planning building review done canceled"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
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

t() { tmux -S "$SOCK" "$@"; }
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

t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -x 200 -y 60 -c "$ROOT"

# --- ls: lanes in definition order, the card in its lane ------------------------------------------
fresh
run_cmd ls "$FACTORY board ls --board $BOARD_ID --api $API_URL" || true
capture ls.txt
OBSERVED_LANES="$(grep -E '^[a-z]+  (resting|working|terminal)  [0-9]+$' "$EVIDENCE_DIR/ls.txt" | awk '{print $1}' | tr '\n' ' ' | sed 's/ $//')"
check "the seed created the card at revision 1 in intake" \
  "$([ "$REVISION" = "1" ] && grep -q '^intake  resting  1$' "$EVIDENCE_DIR/ls.txt" && echo 0 || echo 1)" \
  "revision=$REVISION, lane=intake"
check "board ls exits 0" "$([ "$(exit_code ls)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code ls)"
check "ls prints every lane in definition order" \
  "$([ "$OBSERVED_LANES" = "$LANES" ] && echo 0 || echo 1)" \
  "lanes=[${OBSERVED_LANES}]"
check "the card sits in its own lane" \
  "$(awk -v id="$TASK_ID" '$1 == "intake" && $3 == "1" { getline; if (index($0, id) > 0) found = 1 } END { print (found ? 0 : 1) }' "$EVIDENCE_DIR/ls.txt")" \
  "$TASK_ID under intake"

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

# --- start: a run bound to the card -----------------------------------------------------------------
fresh
run_cmd start "$FACTORY board start --task $TASK_ID --api $API_URL" || true
capture start.txt
SESSION_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/start.txt" | head -1)"
check "board start exits 0" "$([ "$(exit_code start)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code start)"
check "start opens a session against the card" \
  "$([ -n "$SESSION_ID" ] && grep -q "task    $TASK_ID in specifying" "$EVIDENCE_DIR/start.txt" && echo 0 || echo 1)" \
  "session=${SESSION_ID:-none}"

# --- evidence --------------------------------------------------------------------------------------
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "boardId": "%s",\n' "$BOARD_ID"
  printf '  "taskId": "%s",\n' "$TASK_ID"
  printf '  "sessionId": "%s",\n' "${SESSION_ID:-}"
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
