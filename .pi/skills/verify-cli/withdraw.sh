#!/usr/bin/env bash
# Drive `factory send` and `factory withdraw` in a real tmux terminal (LOB-166): a message queued
# behind a running turn is withdrawn from the CLI, the watcher sees the queue shrink, and the message
# never reaches the transcript while the one left beside it does.
#
# A queue only exists while a run is in flight, and the faux turn is too fast to queue behind, so
# this script owns its own API instance — its own port, session root, log, pid file, and tmux
# server — with a faux command that sleeps. It does not touch the instance ./up.sh started, and it
# leaves nothing running.
#
#   ./withdraw.sh                  # API on :9310 (WITHDRAW_PORT overrides it)
#
# Evidence: .verify/evidence/latest/cli/withdraw-*.txt (the raw panes) and withdraw.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${WITHDRAW_PORT:-9310}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-withdraw"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LOG="$RUN_DIR/api.log"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-withdraw"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
PROMPT="withdraw probe"
# Long enough that two `factory send`s and three `factory withdraw`s land inside the first turn,
# each one a fresh `bun` process of about a second.
SLEEP_S="${WITHDRAW_SLEEP_S:-15}"
# A well-formed submission id no session of this instance has reached.
UNKNOWN_SUBMISSION="999999"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-56s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-56s %s\n' "$1" "$3"
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

start_api() {
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      ALLOWED_ORIGINS="http://localhost:$PORT" \
      MODEL_BACKEND=faux \
      FAUX_COMMAND="sleep $SLEEP_S && echo faux-ok" \
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
  if [ -f "$pidfile" ]; then
    local pid; pid="$(cat "$pidfile")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  fi
  tmux -S "$SOCK" kill-server 2>/dev/null || true
}

trap 'stop_api' EXIT

if [ -f "$RUN_DIR/api.pid" ] && kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null; then
  echo "a withdraw API is already running (pid $(cat "$RUN_DIR/api.pid"))" >&2
  exit 1
fi

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# The session root is a throwaway git repo whose `origin` is a local bare repository, as up.sh's is,
# so a scripted git command can never reach a real remote (LOB-94).
rm -rf "$RUN_DIR/sessions" "$RUN_DIR/origin.git"
mkdir -p "$RUN_DIR/sessions"
git init -q -b main "$RUN_DIR/sessions"
git -C "$RUN_DIR/sessions" config user.email verify-cli@localhost
git -C "$RUN_DIR/sessions" config user.name "verify-cli"
git -C "$RUN_DIR/sessions" commit -q --allow-empty -m "verify-cli session root"
git init -q -b main --bare "$RUN_DIR/origin.git"
git -C "$RUN_DIR/sessions" remote add origin "$RUN_DIR/origin.git"
git -C "$RUN_DIR/sessions" push -q origin main

: > "$LOG"
start_api
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

t() { tmux -S "$SOCK" "$@"; }
pane() { t capture-pane -p -J -t "$1" -S -4000 | sed -e 's/[[:space:]]*$//'; }

# Type a command into a window, wait for its sentinel, and leave the output there (drive.sh's
# pattern: the sentinel is a second typed line, so zsh's url-quote-magic cannot swallow it).
run_cmd() { # window, marker, command, [tries]
  local window="$1" marker="$2" cmd="$3" tries="${4:-300}"
  t send-keys -t "$window" "clear" Enter
  sleep 0.3
  t clear-history -t "$window" 2>/dev/null || true
  t send-keys -l -t "$window" "$cmd"
  t send-keys -t "$window" Enter
  t send-keys -l -t "$window" "printf '\\n__done_%s:%s\\n' $marker \$?"
  t send-keys -t "$window" Enter
  for _ in $(seq 1 "$tries"); do
    if pane "$window" | grep -q "^__done_$marker:[0-9]*$"; then
      sleep 0.2
      return 0
    fi
    sleep 0.1
  done
  return 1
}

exit_code() { pane "$1" | grep -o "__done_$2:[0-9]*" | tail -1 | cut -d: -f2; }

t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -n run -x 200 -y 60 -c "$ROOT"
t new-window -t "$TERM_SESSION" -n cmd -c "$ROOT"
RUN_WINDOW="$TERM_SESSION:run"
CMD_WINDOW="$TERM_SESSION:cmd"

# --- a turn in flight: `factory run` follows it in its own window ---------------------------------
t send-keys -l -t "$RUN_WINDOW" "$FACTORY run \"$PROMPT\" --api $API_URL"
t send-keys -t "$RUN_WINDOW" Enter
t send-keys -l -t "$RUN_WINDOW" "printf '\\n__done_%s:%s\\n' run \$?"
t send-keys -t "$RUN_WINDOW" Enter

# The task's own user entry is on the stream once the run has it, which is when a message queues.
SESSION_ID=""
for _ in $(seq 1 200); do
  if pane "$RUN_WINDOW" | grep -qF "[user] $PROMPT"; then
    SESSION_ID="$(pane "$RUN_WINDOW" | grep -o 'ses_[0-9a-z]\{26\}' | head -1)"
    break
  fi
  sleep 0.1
done
check "factory run started a turn to queue behind" \
  "$([ -n "$SESSION_ID" ] && echo 0 || echo 1)" "id=${SESSION_ID:-none}"

# --- send: two follow-ups queue behind the turn ---------------------------------------------------
run_cmd "$CMD_WINDOW" senddrop "$FACTORY send $SESSION_ID \"drop me\" --when-busy followUp --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/withdraw-send-drop.txt"
DROP_ID="$(grep -o '^submission [0-9]* placement followUp$' "$EVIDENCE_DIR/withdraw-send-drop.txt" | cut -d' ' -f2)"
check "factory send queues a follow-up behind the running turn" \
  "$([ "$(exit_code "$CMD_WINDOW" senddrop)" = "0" ] && [ -n "$DROP_ID" ] && echo 0 || echo 1)" \
  "submission=${DROP_ID:-none} exit=$(exit_code "$CMD_WINDOW" senddrop)"

run_cmd "$CMD_WINDOW" sendkeep "$FACTORY send $SESSION_ID \"keep me\" --when-busy followUp --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/withdraw-send-keep.txt"
KEEP_ID="$(grep -o '^submission [0-9]* placement followUp$' "$EVIDENCE_DIR/withdraw-send-keep.txt" | cut -d' ' -f2)"
check "a second follow-up queues beside it" \
  "$([ -n "$KEEP_ID" ] && [ "$KEEP_ID" != "$DROP_ID" ] && echo 0 || echo 1)" \
  "submission=${KEEP_ID:-none}"

# The watcher names each queued message by the id `withdraw` takes.
shown=1
for _ in $(seq 1 50); do
  pane "$RUN_WINDOW" | grep -qx "\[queued:followUp:$DROP_ID\] drop me" && { shown=0; break; }
  sleep 0.1
done
check "the watcher shows the queued message with its id" "$shown" "[queued:followUp:$DROP_ID] drop me"

# --- withdraw: the first follow-up leaves the queue ----------------------------------------------
run_cmd "$CMD_WINDOW" withdraw "$FACTORY withdraw $SESSION_ID $DROP_ID --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/withdraw-withdraw.txt"
check "factory withdraw exits 0" \
  "$([ "$(exit_code "$CMD_WINDOW" withdraw)" = "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code "$CMD_WINDOW" withdraw)"
check "and names the message it withdrew" \
  "$(grep -qx "withdrawn $DROP_ID" "$EVIDENCE_DIR/withdraw-withdraw.txt" && echo 0 || echo 1)" \
  "withdrawn $DROP_ID"

# The queue the watcher prints after the withdrawal holds only the message left in it: the last
# queued reading is the `keep me` line alone, not the pair it was a moment ago.
drained=1
for _ in $(seq 1 50); do
  last_two="$(pane "$RUN_WINDOW" | grep '^\[queued' | tail -2 | tr '\n' '|')"
  if [ "$last_two" = "[queued:followUp:$KEEP_ID] keep me|[queued:followUp:$KEEP_ID] keep me|" ]; then
    drained=0
    break
  fi
  sleep 0.1
done
pane "$RUN_WINDOW" > "$EVIDENCE_DIR/withdraw-run-after.txt"
check "the watcher sees the queue shrink to the message left in it" "$drained" \
  "last=$(pane "$RUN_WINDOW" | grep '^\[queued' | tail -1)"

# --- refusals: a script branches on the word, and the exit is non-zero ---------------------------
run_cmd "$CMD_WINDOW" again "$FACTORY withdraw $SESSION_ID $DROP_ID --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/withdraw-again.txt"
check "withdrawing it again answers that it is settled" \
  "$(grep -q '^error: settled' "$EVIDENCE_DIR/withdraw-again.txt" && [ "$(exit_code "$CMD_WINDOW" again)" != "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code "$CMD_WINDOW" again)"

run_cmd "$CMD_WINDOW" unknown "$FACTORY withdraw $SESSION_ID $UNKNOWN_SUBMISSION --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/withdraw-unknown.txt"
check "an id the session never admitted is not_found" \
  "$(grep -q '^error: not_found' "$EVIDENCE_DIR/withdraw-unknown.txt" && [ "$(exit_code "$CMD_WINDOW" unknown)" != "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code "$CMD_WINDOW" unknown)"

# --- the transcript: the kept message ran, the withdrawn one never did ----------------------------
# `run` ends when the session first settles; `watch` is then re-read until the follow-up's own turn
# is in the transcript and the session is idle again, so the assertion is on the finished log.
for _ in $(seq 1 $((SLEEP_S * 10 + 300))); do
  pane "$RUN_WINDOW" | grep -q "^__done_run:[0-9]*$" && break
  sleep 0.1
done
pane "$RUN_WINDOW" > "$EVIDENCE_DIR/withdraw-run.txt"
check "factory run exits 0 once the turn settles" \
  "$([ "$(exit_code "$RUN_WINDOW" run)" = "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code "$RUN_WINDOW" run)"

settled=1
for attempt in $(seq 1 20); do
  run_cmd "$CMD_WINDOW" "watch$attempt" "$FACTORY watch $SESSION_ID --api $API_URL" 600 || true
  pane "$CMD_WINDOW" > "$EVIDENCE_DIR/withdraw-watch.txt"
  if grep -qx '\[user\] keep me' "$EVIDENCE_DIR/withdraw-watch.txt" &&
    grep -q '^answer: ' "$EVIDENCE_DIR/withdraw-watch.txt" &&
    [ "$(grep -x '\[user\] keep me' -A 50 "$EVIDENCE_DIR/withdraw-watch.txt" | grep -c '^\[assistant\]')" -gt 0 ]; then
    settled=0
    break
  fi
  sleep 1
done
check "the message left in the queue ran" "$settled" "[user] keep me, then an answer"
check "the withdrawn message never reached the transcript" \
  "$(grep -q '^\[user\] drop me' "$EVIDENCE_DIR/withdraw-watch.txt" && echo 1 || echo 0)" \
  "no [user] drop me"

run_cmd "$CMD_WINDOW" late "$FACTORY withdraw $SESSION_ID $KEEP_ID --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/withdraw-late.txt"
check "a message that already ran cannot be withdrawn" \
  "$(grep -q '^error: settled' "$EVIDENCE_DIR/withdraw-late.txt" && [ "$(exit_code "$CMD_WINDOW" late)" != "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code "$CMD_WINDOW" late)"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "withdrawn": "%s",\n' "$DROP_ID"
  printf '  "kept": "%s",\n' "$KEEP_ID"
  printf '  "fauxSleepSeconds": %s,\n' "$SLEEP_S"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/withdraw.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "withdraw: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "withdraw: FAILURES — see $EVIDENCE_DIR/withdraw.json and $LOG" >&2
fi
exit "$failed"
