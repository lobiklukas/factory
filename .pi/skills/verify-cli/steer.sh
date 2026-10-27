#!/usr/bin/env bash
# Drive `factory send --when-busy steer` and `--when-busy reject` in a real tmux terminal (LOB-167):
# a steer sent while a run is in flight joins that run — the run answers it, once — and a reject
# sent while it is in flight is refused with `error: busy`, a non-zero exit, and nothing queued. The
# same reject on the idle session starts a run, so the refusal is about the session being busy.
#
# A message only arrives "while a run is in flight" if the run lasts longer than a `bun` process
# takes to start, and the stock faux turn does not. This script owns its own API instance — its own
# port, session root, log, pid file, and tmux server — with the sleeping faux script
# (`FAUX_SLEEP_MS`: the model naps before each step of a turn). It does not touch the instance
# ./up.sh started, and it leaves nothing running.
#
#   ./steer.sh                     # API on :9320 (STEER_PORT overrides it)
#
# Evidence: .verify/evidence/latest/cli/steer-*.txt (the raw panes) and steer.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${STEER_PORT:-9320}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-steer"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LOG="$RUN_DIR/api.log"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-steer"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
PROMPT="steer probe"
STEER="use the steer"
REJECTED="only if idle"
IDLE="now that you are idle"
# The model naps this long before calling bash and again before answering. Long enough that the
# steer, its queue reading, and the reject — each a fresh `bun` process of about a second — land
# inside the first nap, before the tool round places the steer.
SLEEP_MS="${STEER_SLEEP_MS:-8000}"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-60s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-60s %s\n' "$1" "$3"
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
      FAUX_SLEEP_MS="$SLEEP_MS" \
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
  echo "a steer API is already running (pid $(cat "$RUN_DIR/api.pid"))" >&2
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

# --- a run in flight: `factory run` follows it in its own window ----------------------------------
t send-keys -l -t "$RUN_WINDOW" "$FACTORY run \"$PROMPT\" --api $API_URL"
t send-keys -t "$RUN_WINDOW" Enter
t send-keys -l -t "$RUN_WINDOW" "printf '\\n__done_%s:%s\\n' run \$?"
t send-keys -t "$RUN_WINDOW" Enter

# The task's own user entry is on the stream once the run has it, which is when the model naps.
SESSION_ID=""
for _ in $(seq 1 200); do
  if pane "$RUN_WINDOW" | grep -qF "[user] $PROMPT"; then
    SESSION_ID="$(pane "$RUN_WINDOW" | grep -o 'ses_[0-9a-z]\{26\}' | head -1)"
    break
  fi
  sleep 0.1
done
check "factory run started a run to send into" \
  "$([ -n "$SESSION_ID" ] && echo 0 || echo 1)" "id=${SESSION_ID:-none}"

# --- steer: the message joins the running run ----------------------------------------------------
run_cmd "$CMD_WINDOW" steer "$FACTORY send $SESSION_ID \"$STEER\" --when-busy steer --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/steer-send.txt"
STEER_ID="$(grep -o '^submission [0-9]* placement steer$' "$EVIDENCE_DIR/steer-send.txt" | cut -d' ' -f2)"
check "factory send --when-busy steer answers placement steer" \
  "$([ "$(exit_code "$CMD_WINDOW" steer)" = "0" ] && [ -n "$STEER_ID" ] && echo 0 || echo 1)" \
  "submission=${STEER_ID:-none} exit=$(exit_code "$CMD_WINDOW" steer)"

# Until the tool round places it, the steer waits in the queue under its own mode.
shown=1
for _ in $(seq 1 50); do
  pane "$RUN_WINDOW" | grep -qx "\[queued:steer:$STEER_ID\] $STEER" && { shown=0; break; }
  sleep 0.1
done
check "the watcher shows the steer queued as a steer" "$shown" "[queued:steer:$STEER_ID] $STEER"

# --- reject: refused while the run is in flight ---------------------------------------------------
run_cmd "$CMD_WINDOW" reject "$FACTORY send $SESSION_ID \"$REJECTED\" --when-busy reject --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/steer-reject.txt"
check "factory send --when-busy reject on a busy session is error: busy" \
  "$(grep -q '^error: busy' "$EVIDENCE_DIR/steer-reject.txt" && [ "$(exit_code "$CMD_WINDOW" reject)" != "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code "$CMD_WINDOW" reject)"
check "and admits nothing: no submission is printed" \
  "$(grep -q '^submission ' "$EVIDENCE_DIR/steer-reject.txt" && echo 1 || echo 0)" \
  "no submission line"
# The refusal is the server's answer about this run, so the run must still be the one in flight.
check "the refusal landed while the run was still in flight" \
  "$(pane "$RUN_WINDOW" | grep -q "^__done_run:[0-9]*$" && echo 1 || echo 0)" \
  "factory run had not exited"

# --- the run: it took the steer, and answered once -------------------------------------------------
for _ in $(seq 1 $((SLEEP_MS / 100 * 2 + 300))); do
  pane "$RUN_WINDOW" | grep -q "^__done_run:[0-9]*$" && break
  sleep 0.1
done
pane "$RUN_WINDOW" > "$EVIDENCE_DIR/steer-run.txt"
check "factory run exits 0 once the run settles" \
  "$([ "$(exit_code "$RUN_WINDOW" run)" = "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code "$RUN_WINDOW" run)"
# The faux answer names the newest user message: a run that took the steer answers it. A follow-up
# would have let this run answer the prompt and settle first, so `run` would print that answer.
check "the run answers the steer" \
  "$(grep -qxF "answer: faux-ok (re: $STEER)" "$EVIDENCE_DIR/steer-run.txt" && echo 0 || echo 1)" \
  "$(grep '^answer: ' "$EVIDENCE_DIR/steer-run.txt" | tail -1)"
# Steers are placed after the tool round: the steer's entry follows the bash result.
check "the steer joined after the tool round" \
  "$(grep -x '\[tool:bash\].*' -A 50 "$EVIDENCE_DIR/steer-run.txt" | grep -qxF "[user] $STEER" && echo 0 || echo 1)" \
  "[tool:bash], then [user] $STEER"

# The finished log, read back: one run, one answer, and no trace of the refused message.
run_cmd "$CMD_WINDOW" watch "$FACTORY watch $SESSION_ID --api $API_URL" 600 || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/steer-watch.txt"
ANSWERS="$(grep -c '^\[assistant\] faux-ok' "$EVIDENCE_DIR/steer-watch.txt")"
check "the transcript holds one answer, and it is the steer's" \
  "$([ "$ANSWERS" = "1" ] && grep -qxF "[assistant] faux-ok (re: $STEER)" "$EVIDENCE_DIR/steer-watch.txt" && echo 0 || echo 1)" \
  "answers=$ANSWERS"
check "the one bash call ran once" \
  "$([ "$(grep -c '^\[tool:bash\]' "$EVIDENCE_DIR/steer-watch.txt")" = "1" ] && echo 0 || echo 1)" \
  "tool results=$(grep -c '^\[tool:bash\]' "$EVIDENCE_DIR/steer-watch.txt")"
check "the rejected message never reached the transcript" \
  "$(grep -qF "[user] $REJECTED" "$EVIDENCE_DIR/steer-watch.txt" && echo 1 || echo 0)" \
  "no [user] $REJECTED"

# --- the control: reject on the idle session starts a run -----------------------------------------
run_cmd "$CMD_WINDOW" idle "$FACTORY send $SESSION_ID \"$IDLE\" --when-busy reject --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/steer-idle.txt"
check "factory send --when-busy reject on an idle session starts a run" \
  "$(grep -q '^submission [0-9]* placement run$' "$EVIDENCE_DIR/steer-idle.txt" && [ "$(exit_code "$CMD_WINDOW" idle)" = "0" ] && echo 0 || echo 1)" \
  "$(grep '^submission \|^error: ' "$EVIDENCE_DIR/steer-idle.txt" | head -1) exit=$(exit_code "$CMD_WINDOW" idle)"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "steer": "%s",\n' "$STEER_ID"
  printf '  "fauxSleepMs": %s,\n' "$SLEEP_MS"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/steer.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "steer: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "steer: FAILURES — see $EVIDENCE_DIR/steer.json and $LOG" >&2
fi
exit "$failed"
