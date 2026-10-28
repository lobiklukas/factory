#!/usr/bin/env bash
# Drive `factory replay` in a real tmux terminal (LOB-200): a recorded session's task is run again on
# another model and the CLI prints the comparison — both model names, the result, turns and cost per
# side, and the delta. Also the refusals: an unknown model is a typed error naming the allowed list
# (and replays nothing), a session bound to no repo prints the server's refusal, an unknown id is
# `not_found`.
#
# A replay needs a session bound to a repo with a checkout and a second model to run on, so this
# script owns its own API instance — its own port, session root, checkout, log, pid file and tmux
# server. Under faux a model *is* a script: `ROLE_MODELS=builder=faux/faux-alt` publishes a second
# model beside `faux/faux-1`, `FAUX_MODEL_SCRIPTS` gives it an answer of its own (`alt-ok`) and
# `FAUX_COST` charges every answer so the cost delta is a number rather than zero. It does not touch
# the instance ./up.sh started, and it leaves nothing running.
#
#   ./replay.sh                    # API on :9360 (REPLAY_PORT overrides it)
#
# Evidence: .verify/evidence/latest/cli/replay-*.txt (the raw panes) and replay.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${REPLAY_PORT:-9360}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-replay"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LOG="$RUN_DIR/api.log"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-replay"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
CHECKOUT="$RUN_DIR/checkout"
# A slug this run owns: a slug another drive registered would hand the session that drive's checkout.
REPO="lobiklukas/factory-replay-$(date +%s)$$"
UNKNOWN="ses_00000000000000000000000000"
OTHER_MODEL="faux/faux-alt"
DEFAULT_MODEL="faux/faux-1"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-62s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-62s %s\n' "$1" "$3"
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
      FAUX_COMMAND="echo faux-ok" \
      FAUX_COST=0.01 \
      ROLE_MODELS="builder=$OTHER_MODEL" \
      FAUX_MODEL_SCRIPTS='{"faux-alt":{"command":"echo alt-ok"}}' \
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

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — set REPLAY_PORT to a free one" >&2
  exit 1
fi

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# The checkout the sessions' worktrees are cut from: a real repository with one commit on main.
rm -rf "$RUN_DIR/sessions" "$CHECKOUT"
mkdir -p "$RUN_DIR/sessions"
git init -q -b main "$CHECKOUT"
git -C "$CHECKOUT" -c user.email=verify-cli@localhost -c user.name=verify-cli \
  commit -q --allow-empty -m "replay checkout"

: > "$LOG"
start_api
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

# No CLI verb registers a checkout in this drive, so the repo is registered over the RPC the CLI
# speaks. The request line keeps its newline (NDJSON), so it is piped rather than substituted.
printf '{"_tag":"Request","id":"1","tag":"registerRepo","payload":{"repo":"%s","localPath":"%s"},"headers":[]}\n' \
  "$REPO" "$CHECKOUT" |
  curl -s -m 10 -H 'content-type: application/ndjson' --data-binary @- "$API_URL/rpc" \
    > "$EVIDENCE_DIR/replay-register.txt" 2>&1
check "the repo is registered with its checkout" \
  "$(grep -q '"_tag":"Success"' "$EVIDENCE_DIR/replay-register.txt" && echo 0 || echo 1)" "$REPO"

t() { tmux -S "$SOCK" "$@"; }
pane() { t capture-pane -p -J -t "$1" -S -4000 | sed -e 's/[[:space:]]*$//'; }

# Type a command, wait for its sentinel, and leave the output there (drive.sh's pattern).
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
t new-session -d -s "$TERM_SESSION" -n cmd -x 200 -y 60 -c "$ROOT"
W="$TERM_SESSION:cmd"

# --- the recorded session: a run on the repo, then a follow-up so the source has more turns --------
run_cmd "$W" run "$FACTORY run \"replay probe\" --repo $REPO --base-ref main --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-run.txt"
SOURCE_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/replay-run.txt" | head -1)"
check "factory run opened the source session on the repo" \
  "$([ "$(exit_code "$W" run)" = "0" ] && [ -n "$SOURCE_ID" ] && grep -q 'answer: faux-ok' "$EVIDENCE_DIR/replay-run.txt" && echo 0 || echo 1)" \
  "id=${SOURCE_ID:-none} exit=$(exit_code "$W" run)"

run_cmd "$W" send "$FACTORY send $SOURCE_ID \"one more thing\" --api $API_URL" || true
run_cmd "$W" settle "$FACTORY watch $SOURCE_ID --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-source-watch.txt"
check "the source took the follow-up, so it ran more turns than a replay will" \
  "$([ "$(exit_code "$W" settle)" = "0" ] && grep -c '^\[user\]' "$EVIDENCE_DIR/replay-source-watch.txt" | grep -qx 2 && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" settle)"

run_cmd "$W" lsbefore "$FACTORY ls --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-ls-before.txt"

# --- replay on another model: the comparison, with both model names -----------------------------------
run_cmd "$W" replay "$FACTORY replay $SOURCE_ID --model $OTHER_MODEL --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-replay.txt"
REPLAY_ID="$(grep -o '^replay ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/replay-replay.txt" | head -1 | cut -d' ' -f2)"
check "factory replay exits 0 and names the replay's own session" \
  "$([ "$(exit_code "$W" replay)" = "0" ] && [ -n "$REPLAY_ID" ] && [ "$REPLAY_ID" != "$SOURCE_ID" ] && grep -qx "replay $REPLAY_ID of $SOURCE_ID" "$EVIDENCE_DIR/replay-replay.txt" && echo 0 || echo 1)" \
  "replay=${REPLAY_ID:-none} exit=$(exit_code "$W" replay)"
check "the replay ran on the other model: its own script's answer" \
  "$(grep -qx 'answer: alt-ok.*' "$EVIDENCE_DIR/replay-replay.txt" && echo 0 || echo 1)" "alt-ok"
check "the comparison header has the source, replay and delta columns" \
  "$(grep -Eq '^ +source +replay +delta$' "$EVIDENCE_DIR/replay-replay.txt" && echo 0 || echo 1)" "header"
check "the session row names both sessions" \
  "$(grep -Eq "^session +$SOURCE_ID +$REPLAY_ID\$" "$EVIDENCE_DIR/replay-replay.txt" && echo 0 || echo 1)" "$SOURCE_ID $REPLAY_ID"
check "the model row names both models" \
  "$(grep -Eq "^model +$DEFAULT_MODEL +$OTHER_MODEL\$" "$EVIDENCE_DIR/replay-replay.txt" && echo 0 || echo 1)" "$DEFAULT_MODEL vs $OTHER_MODEL"
check "the result row says both sides answered" \
  "$(grep -Eq '^result +answered +answered$' "$EVIDENCE_DIR/replay-replay.txt" && echo 0 || echo 1)" "answered"
# The source ran the prompt and the follow-up, the replay only the prompt: fewer turns, less spend.
TURNS_ROW="$(grep -E '^turns +[0-9]+ +[0-9]+ +-[0-9]+$' "$EVIDENCE_DIR/replay-replay.txt" | head -1)"
check "the turns row has the replay below the source, with a negative delta" \
  "$([ -n "$TURNS_ROW" ] && echo 0 || echo 1)" "${TURNS_ROW:-none}"
COST_ROW="$(grep -E '^cost +\$[0-9.]+ +\$[0-9.]+ +-\$[0-9.]+$' "$EVIDENCE_DIR/replay-replay.txt" | head -1)"
check "the cost row prints dollars per side and a negative delta" \
  "$([ -n "$COST_ROW" ] && echo 0 || echo 1)" "${COST_ROW:-none}"

# The delta is the stored one: it is the replay's minus the source's, whatever this client could
# subtract. Read the cells back and check the arithmetic the table claims.
if [ -n "$TURNS_ROW" ]; then
  read -r _ S_TURNS R_TURNS D_TURNS <<< "$TURNS_ROW"
  check "turns delta is the replay's turns minus the source's" \
    "$([ "$((R_TURNS - S_TURNS))" = "$D_TURNS" ] && echo 0 || echo 1)" "$R_TURNS - $S_TURNS = $D_TURNS"
fi

# The cost cells are dollars to 4 places, so the replay's minus the source's must equal the delta
# to 4 places (the stored delta is a float subtraction, which can differ from the rounded cells
# by one in the last place).
if [ -n "$COST_ROW" ]; then
  read -r _ S_COST R_COST D_COST <<< "$COST_ROW"
  check "cost delta is the replay's cost minus the source's, to 4 places" \
    "$(awk -v s="${S_COST#\$}" -v r="${R_COST#\$}" -v d="${D_COST/\$/}" 'BEGIN { diff = r - s; gap = diff - d; if (gap < 0) gap = -gap; exit !(gap < 0.00015) }' && echo 0 || echo 1)" \
    "$R_COST - $S_COST = $D_COST"
fi

# --- a replay is a new session; the source was only read -----------------------------------------------
run_cmd "$W" lsafter "$FACTORY ls --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-ls-after.txt"
check "the replay is a new row in factory ls" \
  "$(! grep -q "^$REPLAY_ID" "$EVIDENCE_DIR/replay-ls-before.txt" && grep -q "^$REPLAY_ID" "$EVIDENCE_DIR/replay-ls-after.txt" && echo 0 || echo 1)" \
  "$REPLAY_ID absent before, listed after"

# --- a replay with no --model runs on the control plane's own model ------------------------------------
run_cmd "$W" same "$FACTORY replay $SOURCE_ID --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-same.txt"
check "without --model the replay runs on the server's model, named on both sides" \
  "$([ "$(exit_code "$W" same)" = "0" ] && grep -Eq "^model +$DEFAULT_MODEL +$DEFAULT_MODEL\$" "$EVIDENCE_DIR/replay-same.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" same)"

# --- an unknown model is a typed error naming the allowed list, and replays nothing ---------------------
run_cmd "$W" lsmid "$FACTORY ls --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-ls-mid.txt"
run_cmd "$W" badmodel "$FACTORY replay $SOURCE_ID --model nope/not-a-model --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-badmodel.txt"
check "an unknown model is error: unknown_replay_model, non-zero" \
  "$([ "$(exit_code "$W" badmodel)" != "0" ] && grep -q '^error: unknown_replay_model: ' "$EVIDENCE_DIR/replay-badmodel.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" badmodel)"
check "the error names the model it refused and the allowed list" \
  "$(grep -q 'nope/not-a-model' "$EVIDENCE_DIR/replay-badmodel.txt" && grep -q "allowed: $DEFAULT_MODEL, $OTHER_MODEL" "$EVIDENCE_DIR/replay-badmodel.txt" && echo 0 || echo 1)" \
  "allowed: $DEFAULT_MODEL, $OTHER_MODEL"
run_cmd "$W" lsend "$FACTORY ls --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-ls-end.txt"
ids() { grep -o '^ses_[0-9a-z]\{26\}' "$1" | sort -u; }
check "the refused replay opened no session" \
  "$([ "$(ids "$EVIDENCE_DIR/replay-ls-mid.txt")" = "$(ids "$EVIDENCE_DIR/replay-ls-end.txt")" ] && echo 0 || echo 1)" \
  "$(ids "$EVIDENCE_DIR/replay-ls-end.txt" | wc -l | tr -d ' ') distinct ids before and after the refusal"

# --- a session with no repo binding cannot be replayed: the refusal reason is printed -------------------
run_cmd "$W" scratch "$FACTORY run \"scratch probe\" --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-scratch.txt"
SCRATCH_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/replay-scratch.txt" | head -1)"
run_cmd "$W" norepo "$FACTORY replay $SCRATCH_ID --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-norepo.txt"
check "a session bound to no repo prints the server's refusal, non-zero" \
  "$([ "$(exit_code "$W" norepo)" != "0" ] && grep -q '^error: invalid_input: this session is bound to no repo, so it has nowhere to replay into' "$EVIDENCE_DIR/replay-norepo.txt" && echo 0 || echo 1)" \
  "scratch=${SCRATCH_ID:-none} exit=$(exit_code "$W" norepo)"
check "and no comparison table was printed for it" \
  "$(grep -Eq '^ +source +replay +delta$' "$EVIDENCE_DIR/replay-norepo.txt" && echo 1 || echo 0)" "no table"

# --- an unknown id is a typed error ---------------------------------------------------------------------
run_cmd "$W" unknown "$FACTORY replay $UNKNOWN --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/replay-unknown.txt"
check "replaying an unknown id is error: not_found, non-zero" \
  "$([ "$(exit_code "$W" unknown)" != "0" ] && grep -q '^error: not_found' "$EVIDENCE_DIR/replay-unknown.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" unknown)"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "source": "%s",\n' "$SOURCE_ID"
  printf '  "replay": "%s",\n' "$REPLAY_ID"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/replay.json"
cp "$LOG" "$EVIDENCE_DIR/replay-api.log"

if [ "$failed" -eq 0 ]; then
  echo "replay: all checks passed"
else
  echo "replay: some checks failed — see $EVIDENCE_DIR" >&2
fi
exit "$failed"
