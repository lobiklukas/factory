#!/usr/bin/env bash
# Drive `factory interrupt` in a real tmux terminal (C8): an interrupt sent while a run is in flight
# stops it — `factory interrupt` prints `interrupted <id>: idle` and exits 0, the `factory run`
# following it settles with no answer and never prints `faux-ok`, and the transcript ends the turn
# with an `[interrupted]` line. A follow-up `factory send` then runs normally. On the idle session the
# same command prints `not running` and exits 0, and an unknown id is `error: not_found` with a
# non-zero exit.
#
# An interrupt only lands "while a run is in flight" if the run lasts longer than a `bun` process
# takes to start, and the stock faux turn does not. This script owns its own API instance — its own
# port, session root, log, pid file, and tmux server — with the sleeping faux script
# (`FAUX_SLEEP_MS`: the model naps before each step of a turn). It does not touch the instance
# ./up.sh started, and it leaves nothing running.
#
#   ./interrupt.sh                 # API on :9380 (INTERRUPT_PORT overrides it)
#
# Evidence: .verify/evidence/latest/cli/interrupt-*.txt (the raw panes) and interrupt.json.
#
# The harness below (check/write_checks, start_api/wait_ready/stop_api, the session root, run_cmd)
# is steer.sh's, copied; moving it into .pi/skills/lib/ is left to the .pi driver cleanup (LOB-236),
# so a fix to one belongs in the others until then.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${INTERRUPT_PORT:-9380}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-interrupt"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LOG="$RUN_DIR/api.log"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-interrupt"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
PROMPT="interrupt probe"
FOLLOW_UP="now finish"
UNKNOWN="ses_00000000000000000000000000"
# The model naps this long before calling bash and again before answering. Long enough that the
# interrupt — a fresh `bun` process, a second on an idle machine and several on a loaded one —
# lands inside the first nap, before `bash` could print anything. At 8s, on a machine deep in swap,
# it once landed in the second nap, after `bash` had printed.
SLEEP_MS="${INTERRUPT_SLEEP_MS:-15000}"

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
  echo "an interrupt API is already running (pid $(cat "$RUN_DIR/api.pid"))" >&2
  exit 1
fi

# Another API on this port would answer /readyz in place of this script's own, which then fails to
# bind — and every check would run against an instance without FAUX_SLEEP_MS, its own DB, and its
# own session root.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — set INTERRUPT_PORT to a free one" >&2
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
check "factory run started a run to interrupt" \
  "$([ -n "$SESSION_ID" ] && echo 0 || echo 1)" "id=${SESSION_ID:-none}"

# --- interrupt: the run stops, and the command prints the settled status --------------------------
run_cmd "$CMD_WINDOW" stop "$FACTORY interrupt $SESSION_ID --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/interrupt-stop.txt"
check "factory interrupt on a busy session prints interrupted and the settled status" \
  "$(grep -qxF "interrupted $SESSION_ID: idle" "$EVIDENCE_DIR/interrupt-stop.txt" && [ "$(exit_code "$CMD_WINDOW" stop)" = "0" ] && echo 0 || echo 1)" \
  "$(grep '^interrupted \|^not running\|^error: ' "$EVIDENCE_DIR/interrupt-stop.txt" | head -1) exit=$(exit_code "$CMD_WINDOW" stop)"

# The run `factory run` follows settles: it exits, and well before a missed run would have answered.
for _ in $(seq 1 100); do
  pane "$RUN_WINDOW" | grep -q "^__done_run:[0-9]*$" && break
  sleep 0.1
done
check "the followed run settles once interrupted" \
  "$(pane "$RUN_WINDOW" | grep -q "^__done_run:0$" && echo 0 || echo 1)" \
  "exit=$(exit_code "$RUN_WINDOW" run)"
# Both naps over: a run the interrupt missed would have printed by now.
sleep $(( SLEEP_MS * 2 / 1000 + 1 ))
pane "$RUN_WINDOW" > "$EVIDENCE_DIR/interrupt-run.txt"
check "the run never printed faux-ok" \
  "$(grep -q 'faux-ok' "$EVIDENCE_DIR/interrupt-run.txt" && echo 1 || echo 0)" \
  "$(grep '^answer: ' "$EVIDENCE_DIR/interrupt-run.txt" | tail -1)"
check "factory run shows the interrupted turn" \
  "$(grep -q '^\[interrupted\] interrupted: ' "$EVIDENCE_DIR/interrupt-run.txt" && echo 0 || echo 1)" \
  "$(grep '^\[interrupted\]' "$EVIDENCE_DIR/interrupt-run.txt" | head -1)"

# The finished log, read back: the prompt, then the marker, and no bash call.
run_cmd "$CMD_WINDOW" watch "$FACTORY watch $SESSION_ID --api $API_URL" 600 || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/interrupt-watch.txt"
check "the transcript ends the turn with the interrupted line, and no tool ran" \
  "$(grep -xF "[user] $PROMPT" -A 20 "$EVIDENCE_DIR/interrupt-watch.txt" | grep -q '^\[interrupted\] ' && ! grep -q '^\[tool:bash\]' "$EVIDENCE_DIR/interrupt-watch.txt" && echo 0 || echo 1)" \
  "$(grep -c '^\[interrupted\]' "$EVIDENCE_DIR/interrupt-watch.txt") interrupted line(s)"

# --- idle: nothing to stop ---------------------------------------------------------------------------
run_cmd "$CMD_WINDOW" idle "$FACTORY interrupt $SESSION_ID --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/interrupt-idle.txt"
check "factory interrupt on an idle session prints not running and exits 0" \
  "$(grep -q '^not running' "$EVIDENCE_DIR/interrupt-idle.txt" && [ "$(exit_code "$CMD_WINDOW" idle)" = "0" ] && echo 0 || echo 1)" \
  "$(grep '^interrupted \|^not running\|^error: ' "$EVIDENCE_DIR/interrupt-idle.txt" | head -1) exit=$(exit_code "$CMD_WINDOW" idle)"

# --- unknown: not_found -------------------------------------------------------------------------------
run_cmd "$CMD_WINDOW" unknown "$FACTORY interrupt $UNKNOWN --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/interrupt-unknown.txt"
check "factory interrupt on an unknown id is error: not_found, non-zero" \
  "$(grep -q '^error: not_found' "$EVIDENCE_DIR/interrupt-unknown.txt" && [ "$(exit_code "$CMD_WINDOW" unknown)" != "0" ] && echo 0 || echo 1)" \
  "$(grep '^error: ' "$EVIDENCE_DIR/interrupt-unknown.txt" | head -1) exit=$(exit_code "$CMD_WINDOW" unknown)"

# --- follow-up: the next message runs normally ---------------------------------------------------
run_cmd "$CMD_WINDOW" send "$FACTORY send $SESSION_ID \"$FOLLOW_UP\" --api $API_URL" || true
pane "$CMD_WINDOW" > "$EVIDENCE_DIR/interrupt-send.txt"
check "factory send after the interrupt starts a run" \
  "$(grep -q '^submission [0-9]* placement run$' "$EVIDENCE_DIR/interrupt-send.txt" && [ "$(exit_code "$CMD_WINDOW" send)" = "0" ] && echo 0 || echo 1)" \
  "$(grep '^submission \|^error: ' "$EVIDENCE_DIR/interrupt-send.txt" | head -1)"
# `watch` follows a live session until it settles; one taken before the run is on the stream reads
# it idle and ends at once, so it is read again until the follow-up has answered (or tries run out).
for attempt in 1 2 3 4 5; do
  run_cmd "$CMD_WINDOW" "after$attempt" "$FACTORY watch $SESSION_ID --api $API_URL" $((SLEEP_MS / 100 * 3 + 600)) || true
  pane "$CMD_WINDOW" > "$EVIDENCE_DIR/interrupt-after.txt"
  grep -qxF "[assistant] faux-ok (re: $FOLLOW_UP)" "$EVIDENCE_DIR/interrupt-after.txt" && break
  sleep 1
done
check "the follow-up runs normally: bash runs and the run answers it" \
  "$(grep -q '^\[tool:bash\] faux-ok' "$EVIDENCE_DIR/interrupt-after.txt" && grep -qxF "[assistant] faux-ok (re: $FOLLOW_UP)" "$EVIDENCE_DIR/interrupt-after.txt" && echo 0 || echo 1)" \
  "$(grep '^\[assistant\] faux-ok' "$EVIDENCE_DIR/interrupt-after.txt" | tail -1)"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "fauxSleepMs": %s,\n' "$SLEEP_MS"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/interrupt.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "interrupt: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "interrupt: FAILURES — see $EVIDENCE_DIR/interrupt.json and $LOG" >&2
fi
exit "$failed"
