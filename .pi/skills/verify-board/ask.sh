#!/usr/bin/env bash
# Prove the ask on the task across two processes (LOB-73; docs/board.md B7).
#
# A run that needs a person must **end** — parked, not hanging — with its question on the card, and
# the next run must read the answer. The story only means something if it survives the control plane
# going away in the middle, so this script owns its API and kills it between the ask and the answer:
#
#   process 1  FAUX_COMMAND sleeps, so the run is provably busy first; then the faux script asks
#              (FAUX_ASK). The drive asserts the run is not busy after the ask, the card is blocked
#              `needs_input` from `specifying`, and `factory board show` prints the question.
#   SIGTERM    the API exits.
#   process 2  `factory board show` still prints the block and the question; `factory board comment`
#              answers it and lifts the block; `factory board start` opens the next run, and its
#              recorded prompt (the committed `pi.system` entry) quotes the answer verbatim.
#
# Every command a person types is run through the real CLI binary and its output and exit code read
# back. Two facts no command prints — "is the session busy" and "what was the run's prompt" — are
# probed by `ask.ts` (RPC `getSession`, and a reader over the run's log).
#
# Not ./up.sh's instance: this script starts and stops its own on ASK_PORT (default 9401) with its own
# session root, so it can run beside a ./drive.sh instance and leaves nothing running.
#
#   ./ask.sh
#
# Env: ASK_PORT, DATABASE_URL, EVIDENCE_DIR. Evidence: .verify/evidence/latest/board/ask-*.
set -uo pipefail

# This suite runs its API with auth off (LOB-20): its clients send no credential, and it declares
# actors (a run's session id) that only an open control plane keeps. A token exported for the
# rest of the verify skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${ASK_PORT:-9401}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/ask"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
LOG="$RUN_DIR/api.log"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
PROBE="$ROOT/.pi/skills/verify-board/ask.ts"
DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
export DATABASE_URL

QUESTION="Which Postgres major does this card target?"
# Two lines and an em dash: an answer trimmed, wrapped or re-encoded on its way into the prompt would
# not be found verbatim. The CLI receives it as one argument, newline included.
ANSWER="$(printf 'Postgres 16.\n  Keep port 5442 \xe2\x80\x94 it is shared.')"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-58s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-58s %s\n' "$1" "$3"
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

start_api() { # faux command
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      ALLOWED_ORIGINS="http://localhost:$PORT" \
      MODEL_BACKEND=faux \
      FAUX_COMMAND="$1" \
      FAUX_ASK="$QUESTION" \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      bun run src/index.ts ) >> "$LOG" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
}

wait_ready() {
  for _ in $(seq 1 60); do
    curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

stop_api() {
  local pidfile="$RUN_DIR/api.pid"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

trap 'stop_api' EXIT

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is taken; set ASK_PORT to a free one" >&2
  exit 1
fi

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# A throwaway session root whose `origin` is a local bare repository, as ./up.sh makes one.
SESSION_ROOT="$RUN_DIR/sessions"
if [ ! -d "$SESSION_ROOT/.git" ]; then
  rm -rf "$SESSION_ROOT" "$RUN_DIR/origin.git"
  mkdir -p "$SESSION_ROOT"
  git init -q -b main "$SESSION_ROOT"
  git -C "$SESSION_ROOT" config user.email verify-board@localhost
  git -C "$SESSION_ROOT" config user.name "verify-board"
  git -C "$SESSION_ROOT" commit -q --allow-empty -m "verify-board ask session root"
  git init -q -b main --bare "$RUN_DIR/origin.git"
  git -C "$SESSION_ROOT" remote add origin "$RUN_DIR/origin.git"
  git -C "$SESSION_ROOT" push -q origin main
fi

: > "$LOG"

# --- process 1: the run asks ------------------------------------------------------------------------
# The sleep holds the run's `bash` turn open, so the probe can see it busy before it asks: without
# that, "not busy after the ask" could not tell a parked run from a probe that never sees busy.
start_api "sleep 4; echo faux-ok"
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }
API1_PID="$(cat "$RUN_DIR/api.pid")"

if ! bun run "$ROOT/.pi/skills/verify-board/seed.ts" > "$RUN_DIR/board.json"; then
  echo "seed failed — see $RUN_DIR/board.json" >&2
  exit 1
fi
json() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$RUN_DIR/board.json"; }
TASK_ID="$(json taskId)"

rc="$(cli ask-move.txt board move --task "$TASK_ID" --to specifying --expect-revision 1)"
check "the card moves into specifying" \
  "$([ "$rc" = "0" ] && grep -q "moved $TASK_ID to specifying (revision 2)" "$EVIDENCE_DIR/ask-move.txt" && echo 0 || echo 1)" \
  "exit=$rc"

rc="$(cli ask-start.txt board start --task "$TASK_ID" --prompt "specify this card")"
SESSION_1="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/ask-start.txt" | head -1)"
check "board start opens the run and sends it the prompt" \
  "$([ "$rc" = "0" ] && [ -n "$SESSION_1" ] && grep -q '^sent    specify this card$' "$EVIDENCE_DIR/ask-start.txt" && echo 0 || echo 1)" \
  "exit=$rc session=${SESSION_1:-none}"

MODE=busy API_URL="$API_URL" SESSION_ID="$SESSION_1" EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$PROBE" > "$RUN_DIR/probe-busy.log" 2>&1
check "the run is busy while its turn runs (the control)" "$?" "$(tail -1 "$RUN_DIR/probe-busy.log")"

MODE=parked API_URL="$API_URL" SESSION_ID="$SESSION_1" TASK_ID="$TASK_ID" QUESTION="$QUESTION" \
  EVIDENCE_DIR="$EVIDENCE_DIR" bun "$PROBE" > "$RUN_DIR/probe-parked.log" 2>&1
PARKED_RC=$?
cat "$RUN_DIR/probe-parked.log"
check "after the ask the run is parked, not busy (probe)" "$PARKED_RC" "see ask-parked.json"

rc="$(cli ask-show-asked.txt board show --task "$TASK_ID")"
check "board show prints the needs_input block and the column it blocked from" \
  "$([ "$rc" = "0" ] && grep -q '^blocked   needs_input from specifying since ' "$EVIDENCE_DIR/ask-show-asked.txt" && echo 0 || echo 1)" \
  "exit=$rc"
check "board show prints the question, by the run, verbatim" \
  "$(grep -qF "  [question] $SESSION_1 (revision 2)" "$EVIDENCE_DIR/ask-show-asked.txt" && grep -qxF "    $QUESTION" "$EVIDENCE_DIR/ask-show-asked.txt" && echo 0 || echo 1)" \
  "thread $(sed -n 's/^thread    //p' "$EVIDENCE_DIR/ask-show-asked.txt")"

# --- the restart --------------------------------------------------------------------------------------
stop_api
check "process 1 exits on SIGTERM" "$(kill -0 "$API1_PID" 2>/dev/null && echo 1 || echo 0)" "pid=$API1_PID"

start_api "echo faux-ok"
wait_ready || { echo "the restarted api did not become ready — see $LOG" >&2; exit 1; }
API2_PID="$(cat "$RUN_DIR/api.pid")"
check "process 2 is a different process" "$([ "$API2_PID" != "$API1_PID" ] && echo 0 || echo 1)" "pid=$API2_PID"

# --- process 2: the question survived; the answer --------------------------------------------------------
rc="$(cli ask-show-restarted.txt board show --task "$TASK_ID")"
REVISION="$(sed -n 's/^revision  \([0-9]*\)$/\1/p' "$EVIDENCE_DIR/ask-show-restarted.txt")"
check "after the restart the card is still blocked needs_input" \
  "$([ "$rc" = "0" ] && grep -q '^blocked   needs_input from specifying since ' "$EVIDENCE_DIR/ask-show-restarted.txt" && echo 0 || echo 1)" \
  "exit=$rc revision=${REVISION:-?}"
check "after the restart the question is still on the task" \
  "$(grep -qxF "    $QUESTION" "$EVIDENCE_DIR/ask-show-restarted.txt" && echo 0 || echo 1)" \
  "question verbatim"

rc="$(cli ask-comment.txt board comment --task "$TASK_ID" --expect-revision "${REVISION:-0}" --body "$ANSWER" --actor person:verify-board)"
check "board comment answers the question and lifts the block" \
  "$([ "$rc" = "0" ] && grep -q "^answered: $TASK_ID is no longer blocked (needs_input from specifying)$" "$EVIDENCE_DIR/ask-comment.txt" && echo 0 || echo 1)" \
  "exit=$rc"

rc="$(cli ask-show-answered.txt board show --task "$TASK_ID")"
check "board show prints the answer under the question, unblocked" \
  "$([ "$rc" = "0" ] && grep -q '^blocked   -$' "$EVIDENCE_DIR/ask-show-answered.txt" && grep -q '^thread    2$' "$EVIDENCE_DIR/ask-show-answered.txt" && grep -qF '  [answer] person:verify-board' "$EVIDENCE_DIR/ask-show-answered.txt" && echo 0 || echo 1)" \
  "exit=$rc"

rc="$(cli ask-start-next.txt board start --task "$TASK_ID" --prompt "go on")"
SESSION_2="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/ask-start-next.txt" | head -1)"
check "board start opens the next run" \
  "$([ "$rc" = "0" ] && [ -n "$SESSION_2" ] && [ "$SESSION_2" != "$SESSION_1" ] && echo 0 || echo 1)" \
  "exit=$rc session=${SESSION_2:-none}"

MODE=told API_URL="$API_URL" SESSION_ID="$SESSION_2" TASK_ID="$TASK_ID" QUESTION="$QUESTION" \
  ANSWER="$ANSWER" EVIDENCE_DIR="$EVIDENCE_DIR" bun "$PROBE" > "$RUN_DIR/probe-told.log" 2>&1
TOLD_RC=$?
cat "$RUN_DIR/probe-told.log"
check "the next run's recorded prompt quotes the answer (probe)" "$TOLD_RC" "see ask-told.json"

stop_api
cp "$LOG" "$EVIDENCE_DIR/ask-api.log"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "taskId": "%s",\n' "$TASK_ID"
  printf '  "askingRun": "%s",\n' "${SESSION_1:-}"
  printf '  "nextRun": "%s",\n' "${SESSION_2:-}"
  printf '  "processes": [%s, %s],\n' "$API1_PID" "${API2_PID:-0}"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/ask-observed.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "ask: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "ask: FAILURES — see $EVIDENCE_DIR/ask-observed.json" >&2
fi
exit "$failed"
