#!/usr/bin/env bash
# Drive `factory run --model` and the deployment's `DEFAULT_MODEL` in a real tmux terminal (LOB-274):
# a run with no `--model` prints `model <the deployment's default>`, a run named onto another served
# model prints that one and its requests go to it, a model the server does not serve is refused as
# `error: invalid_input` naming it before any session exists, and a `DEFAULT_MODEL` outside the
# catalog refuses the boot.
#
# The models are deployment settings, so this script owns its API instance — its own port, session
# root, log, pid file and tmux server — booted with `DEFAULT_MODEL=faux/faux-cheap` and
# `ROLE_MODELS=specifier=faux/faux-spec`, which is how a faux deployment publishes two extra models
# with no key. It does not touch the instance ./up.sh started, and it leaves nothing running.
#
#   ./model.sh                     # API on :9370 (MODEL_PORT), the refused boot on :9371
#
# Evidence: .verify/evidence/latest/cli/model-*.txt (the raw panes and the refused boot's log) and
# model.json.
#
# The harness below (check/write_checks, start_api/wait_ready/stop_api, the session root, run_cmd)
# is steer.sh's, copied, until the .pi driver cleanup (LOB-236) moves it into .pi/skills/lib/.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${MODEL_PORT:-9370}"
BAD_PORT="${MODEL_BAD_PORT:-$((PORT + 1))}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-model"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LOG="$RUN_DIR/api.log"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-model"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
PROMPT="model probe"
DEFAULT_MODEL="faux/faux-cheap"
PICKED="faux/faux-spec"
UNSERVED="faux/faux-unserved"

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
      DEFAULT_MODEL="$DEFAULT_MODEL" \
      ROLE_MODELS="specifier=$PICKED" \
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
  local pidfile
  for pidfile in "$RUN_DIR/api.pid" "$RUN_DIR/bad.pid"; do
    [ -f "$pidfile" ] || continue
    local pid; pid="$(cat "$pidfile")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  done
  tmux -S "$SOCK" kill-server 2>/dev/null || true
}

trap 'stop_api' EXIT

if [ -f "$RUN_DIR/api.pid" ] && kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null; then
  echo "a model API is already running (pid $(cat "$RUN_DIR/api.pid"))" >&2
  exit 1
fi

# Another API on either port would answer in place of this script's own.
for port in "$PORT" "$BAD_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set MODEL_PORT / MODEL_BAD_PORT to free ones" >&2
    exit 1
  fi
done

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
pane() { t capture-pane -p -J -t "$TERM_SESSION" -S -4000 | sed -e 's/[[:space:]]*$//'; }

# Type a command, wait for its sentinel, and leave the output there (drive.sh's pattern: the
# sentinel is a second typed line, so zsh's url-quote-magic cannot swallow it).
run_cmd() { # marker, command
  local marker="$1" cmd="$2"
  t send-keys -t "$TERM_SESSION" "clear" Enter
  sleep 0.3
  t clear-history -t "$TERM_SESSION" 2>/dev/null || true
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

# The models a session's requests went to, from its own `pi.usage` as `getSession` folds it: what
# the run did, read over the RPC rather than echoed by the command under test.
usage_models() { # session id
  curl -s -m 5 -X POST "$API_URL/rpc" -H 'content-type: application/ndjson' \
    --data-binary "{\"_tag\":\"Request\",\"id\":\"1\",\"tag\":\"getSession\",\"payload\":{\"sessionId\":\"$1\"},\"headers\":[]}
" | bun -e '
    const text = await Bun.stdin.text();
    for (const line of text.split("\n")) {
      if (!line.includes("\"Exit\"")) continue;
      const exit = JSON.parse(line).exit;
      console.log(exit.value.usage.models.map((entry) => entry.key).join(","));
    }
  '
}

t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -x 200 -y 50 -c "$ROOT"

# --- no --model: the deployment's DEFAULT_MODEL --------------------------------------------------
run_cmd default "$FACTORY run \"$PROMPT\" --api $API_URL" || true
pane > "$EVIDENCE_DIR/model-default.txt"
DEFAULT_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/model-default.txt" | head -1)"
check "factory run with no --model exits 0" \
  "$([ "$(exit_code default)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code default)"
check "it prints the model line: the deployment's DEFAULT_MODEL" \
  "$(grep -qx "model $DEFAULT_MODEL" "$EVIDENCE_DIR/model-default.txt" && echo 0 || echo 1)" \
  "$(grep -m1 '^model ' "$EVIDENCE_DIR/model-default.txt")"
DEFAULT_USAGE="$([ -n "$DEFAULT_ID" ] && usage_models "$DEFAULT_ID")"
check "and its requests went to the default" \
  "$([ "$DEFAULT_USAGE" = "$DEFAULT_MODEL" ] && echo 0 || echo 1)" "usage=${DEFAULT_USAGE:-none}"

# --- --model: a served model, published by ROLE_MODELS -------------------------------------------
run_cmd picked "$FACTORY run \"$PROMPT\" --model $PICKED --api $API_URL" || true
pane > "$EVIDENCE_DIR/model-picked.txt"
PICKED_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/model-picked.txt" | head -1)"
check "factory run --model $PICKED exits 0" \
  "$([ "$(exit_code picked)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code picked)"
check "it prints the model line: the model it was named onto" \
  "$(grep -qx "model $PICKED" "$EVIDENCE_DIR/model-picked.txt" && echo 0 || echo 1)" \
  "$(grep -m1 '^model ' "$EVIDENCE_DIR/model-picked.txt")"
check "it runs offline to the answer" \
  "$(grep -qF "answer: faux-ok (re: $PROMPT)" "$EVIDENCE_DIR/model-picked.txt" && echo 0 || echo 1)" \
  "$(grep -m1 '^answer: ' "$EVIDENCE_DIR/model-picked.txt")"
PICKED_USAGE="$([ -n "$PICKED_ID" ] && usage_models "$PICKED_ID")"
check "and every request went to it, not the default" \
  "$([ "$PICKED_USAGE" = "$PICKED" ] && echo 0 || echo 1)" "usage=${PICKED_USAGE:-none}"

# --- --model: a model the server does not serve ---------------------------------------------------
run_cmd unserved "$FACTORY run \"$PROMPT\" --model $UNSERVED --api $API_URL" || true
pane > "$EVIDENCE_DIR/model-unserved.txt"
check "factory run --model <unserved> is error: invalid_input naming it" \
  "$(grep -qF "error: invalid_input: model $UNSERVED is not one this process serves" "$EVIDENCE_DIR/model-unserved.txt" && [ "$(exit_code unserved)" != "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code unserved)"
check "and no session was created" \
  "$(grep -q 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/model-unserved.txt" && echo 1 || echo 0)" \
  "no session id printed"

# --- a DEFAULT_MODEL outside the catalog refuses the boot -----------------------------------------
BAD_LOG="$EVIDENCE_DIR/model-bad-boot.txt"
( cd "$ROOT/apps/api" && exec env \
    PORT="$BAD_PORT" \
    HOST="127.0.0.1" \
    MODEL_BACKEND=faux \
    DEFAULT_MODEL="anthropic/claude-haiku-4-5" \
    SESSION_ROOT="$RUN_DIR/sessions-bad" \
    bun run src/index.ts ) > "$BAD_LOG" 2>&1 &
echo $! > "$RUN_DIR/bad.pid"
BAD_PID="$(cat "$RUN_DIR/bad.pid")"
for _ in $(seq 1 300); do kill -0 "$BAD_PID" 2>/dev/null || break; sleep 0.1; done
BAD_EXIT=running
if ! kill -0 "$BAD_PID" 2>/dev/null; then
  wait "$BAD_PID" 2>/dev/null
  BAD_EXIT=$?
  rm -f "$RUN_DIR/bad.pid"
fi
check "DEFAULT_MODEL outside the catalog: the API exits non-zero" \
  "$([ "$BAD_EXIT" != "running" ] && [ "$BAD_EXIT" != "0" ] && echo 0 || echo 1)" "exit=$BAD_EXIT"
check "and its log names the refusal and the model" \
  "$(grep -q 'InvalidDefaultModel' "$BAD_LOG" && grep -qF 'DEFAULT_MODEL names model anthropic/claude-haiku-4-5' "$BAD_LOG" && echo 0 || echo 1)" \
  "InvalidDefaultModel in $(basename "$BAD_LOG")"
check "and it never listened" \
  "$(grep -q 'Listening on' "$BAD_LOG" && echo 1 || echo 0)" "no Listening on"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "defaultModel": "%s",\n' "$DEFAULT_MODEL"
  printf '  "picked": "%s",\n' "$PICKED"
  printf '  "defaultSession": "%s",\n' "$DEFAULT_ID"
  printf '  "pickedSession": "%s",\n' "$PICKED_ID"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n'
  printf '}\n'
} > "$EVIDENCE_DIR/model.json"
cp "$LOG" "$EVIDENCE_DIR/model-api.log" 2>/dev/null || true

echo
if [ "$failed" -eq 0 ]; then
  echo "model: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "model: FAILURES — see $EVIDENCE_DIR/model.json" >&2
fi
exit "$failed"
