#!/usr/bin/env bash
# Drive `factory discard` in a real tmux terminal (LOB-268): an operator's discard removes the
# session's worktree and branch, a repeat exits 0 and names the first release, the discarded session
# refuses a new message, and an unknown id is a typed error.
#
# The session needs a real linked worktree for the discard to remove, so this script owns its own
# API instance — its own port, session root, checkout, log, pid file and tmux server — and registers
# a repo whose checkout it creates. It does not touch the instance ./up.sh started, and it leaves
# nothing running.
#
#   ./discard.sh                   # API on :9340 (DISCARD_PORT overrides it)
#
# Evidence: .verify/evidence/latest/cli/discard-*.txt (the raw panes) and discard.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${DISCARD_PORT:-9340}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-discard"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LOG="$RUN_DIR/api.log"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-discard"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
CHECKOUT="$RUN_DIR/checkout"
# A slug this run owns: a slug another drive registered would hand the session that drive's checkout.
REPO="lobiklukas/factory-discard-$(date +%s)$$"
UNKNOWN="ses_00000000000000000000000000"

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
      FAUX_COMMAND="echo faux-ok" \
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
  echo "port $PORT is already in use — set DISCARD_PORT to a free one" >&2
  exit 1
fi

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# The checkout the session's worktree is cut from: a real repository with one commit on main, so
# the session gets a linked worktree on `factory/<id>` this script can read before and after.
rm -rf "$RUN_DIR/sessions" "$CHECKOUT"
mkdir -p "$RUN_DIR/sessions"
git init -q -b main "$CHECKOUT"
git -C "$CHECKOUT" -c user.email=verify-cli@localhost -c user.name=verify-cli \
  commit -q --allow-empty -m "discard checkout"

: > "$LOG"
start_api
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

# No CLI verb registers a checkout yet, so the repo is registered over the RPC the CLI speaks.
# The request line keeps its newline (NDJSON), so it is piped rather than substituted.
printf '{"_tag":"Request","id":"1","tag":"registerRepo","payload":{"repo":"%s","localPath":"%s"},"headers":[]}\n' \
  "$REPO" "$CHECKOUT" |
  curl -s -m 10 -H 'content-type: application/ndjson' --data-binary @- "$API_URL/rpc" \
    > "$EVIDENCE_DIR/discard-register.txt" 2>&1
check "the repo is registered with its checkout" \
  "$(grep -q '"_tag":"Success"' "$EVIDENCE_DIR/discard-register.txt" && echo 0 || echo 1)" "$REPO"

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

# --- a run on the repo: a session with a worktree and a branch --------------------------------------
run_cmd "$W" run "$FACTORY run \"discard probe\" --repo $REPO --base-ref main --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/discard-run.txt"
SESSION_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/discard-run.txt" | head -1)"
WORKTREE="$(grep -o '^workspace .*' "$EVIDENCE_DIR/discard-run.txt" | head -1 | cut -d' ' -f2-)"
BRANCH="factory/$SESSION_ID"
check "factory run opened a session on the repo" \
  "$([ "$(exit_code "$W" run)" = "0" ] && [ -n "$SESSION_ID" ] && echo 0 || echo 1)" \
  "id=${SESSION_ID:-none} exit=$(exit_code "$W" run)"
check "with a worktree and its branch in the checkout" \
  "$([ -n "$WORKTREE" ] && [ -d "$WORKTREE" ] && git -C "$CHECKOUT" rev-parse --verify --quiet "$BRANCH" >/dev/null && echo 0 || echo 1)" \
  "${WORKTREE:-none} $BRANCH"

# --- discard: the worktree and branch go --------------------------------------------------------------
run_cmd "$W" discard "$FACTORY discard $SESSION_ID --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/discard-discard.txt"
check "factory discard exits 0 and says what it removed" \
  "$([ "$(exit_code "$W" discard)" = "0" ] && grep -qx "discarded $SESSION_ID: its worktree and branch are removed" "$EVIDENCE_DIR/discard-discard.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" discard)"
check "the worktree directory is gone" \
  "$([ -n "$WORKTREE" ] && [ ! -e "$WORKTREE" ] && echo 0 || echo 1)" "${WORKTREE:-none}"
check "the branch is gone" \
  "$(git -C "$CHECKOUT" rev-parse --verify --quiet "$BRANCH" >/dev/null && echo 1 || echo 0)" "$BRANCH"
check "and git no longer lists the worktree" \
  "$(git -C "$CHECKOUT" worktree list --porcelain | grep -qF "$SESSION_ID" && echo 1 || echo 0)" "worktree list"

# --- a repeat answers the first release --------------------------------------------------------------
run_cmd "$W" again "$FACTORY discard $SESSION_ID --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/discard-again.txt"
check "a second discard exits 0 and names the first release" \
  "$([ "$(exit_code "$W" again)" = "0" ] && grep -q "^$SESSION_ID was already released (discarded at " "$EVIDENCE_DIR/discard-again.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" again)"

# --- the discarded session takes no new run, and cuts nothing back ------------------------------------
run_cmd "$W" send "$FACTORY send $SESSION_ID \"more\" --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/discard-send.txt"
check "factory send to it is refused as invalid_input" \
  "$([ "$(exit_code "$W" send)" != "0" ] && grep -q 'invalid_input' "$EVIDENCE_DIR/discard-send.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" send)"
check "and the refusal cut no worktree or branch back" \
  "$([ ! -e "$WORKTREE" ] && ! git -C "$CHECKOUT" rev-parse --verify --quiet "$BRANCH" >/dev/null && echo 0 || echo 1)" \
  "$BRANCH"

# --- an unknown id is a typed error ------------------------------------------------------------------
run_cmd "$W" unknown "$FACTORY discard $UNKNOWN --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/discard-unknown.txt"
check "discarding an unknown id is error: not_found, non-zero" \
  "$([ "$(exit_code "$W" unknown)" != "0" ] && grep -q 'not_found' "$EVIDENCE_DIR/discard-unknown.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" unknown)"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/discard.json"
cp "$LOG" "$EVIDENCE_DIR/discard-api.log"

if [ "$failed" -eq 0 ]; then
  echo "discard: all checks passed"
else
  echo "discard: some checks failed — see $EVIDENCE_DIR" >&2
fi
exit "$failed"
