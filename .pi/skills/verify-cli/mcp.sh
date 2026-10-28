#!/usr/bin/env bash
# Drive `factory mcp` and `factory handoff` (S-local-agent-handoff-mcp) against a real control plane:
#
#   1. an MCP client launches `factory mcp` in a checkout the way Claude Code launches a configured
#      stdio server, and creates a card and reads its status through it (./mcp-client.ts), at both
#      revisions Claude Code has sent; the card is read back with `factory board show`. When the
#      `claude` CLI is installed, Claude Code itself is configured with the server — in a scratch
#      config directory, never the operator's — and its `claude mcp get` health check must connect.
#   2. `factory handoff --start` in a real tmux terminal, from a dirty checkout (a local commit, an
#      edit, an untracked file): the card's run is cut on factory/<session-id> with exactly the local
#      diff committed on it, its agent's first turn reads the handed-off file, and the local checkout
#      is left as it was.
#   3. an oversized diff is refused with its size and the cap, exits non-zero, and makes no card.
#
# It owns its own API instance — port, session root, checkouts, log, pid file and tmux server — and
# leaves nothing running. The model is faux, and its one command (`cat notes.md; git log -1`) is
# what proves the run's first turn started on the handed-off work. Nothing leaves loopback: the
# "remote" is a bare repository under .verify/run.
#
#   ./mcp.sh                   # API on :9397 (MCP_PORT overrides it)
#
# Evidence: .verify/evidence/latest/cli/mcp-*.txt|json (raw panes, MCP transcripts) and mcp.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${MCP_PORT:-9397}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-mcp"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LOG="$RUN_DIR/api.log"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-mcp"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
ORIGIN="$RUN_DIR/origin.git"
CHECKOUT="$RUN_DIR/checkout"
LOCAL="$RUN_DIR/local"
# A slug this run owns: a slug another drive registered would hand the session that drive's checkout.
REPO="lobiklukas/factory-mcp-$(date +%s)$$"
CAP=524288

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$(printf '%s' "$3" | tr '"\\' "''" | tr -d '\n')\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-64s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-64s %s\n' "$1" "$3"
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
      FAUX_COMMAND="cat notes.md; git log -1 --format=%s" \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      bun run src/index.ts ) >> "$LOG" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
}

wait_ready() {
  for _ in $(seq 1 120); do
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
  echo "port $PORT is already in use — set MCP_PORT to a free one" >&2
  exit 1
fi

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

g() { git -c user.email=verify-cli@localhost -c user.name=verify-cli "$@"; }

# The remote, the factory's registered checkout of it, and the developer's own clone, each on main
# with a README and a source file.
rm -rf "$RUN_DIR/sessions" "$ORIGIN" "$CHECKOUT" "$LOCAL" "$RUN_DIR/claude-config"
mkdir -p "$RUN_DIR/sessions"
git init -q -b main --bare "$ORIGIN"
git init -q -b main "$CHECKOUT"
printf 'mcp\n' > "$CHECKOUT/README.md"
printf 'one\ntwo\nthree\n' > "$CHECKOUT/src.txt"
g -C "$CHECKOUT" add -A
g -C "$CHECKOUT" commit -q -m "mcp checkout"
git -C "$CHECKOUT" remote add origin "$ORIGIN"
git -C "$CHECKOUT" push -q origin main
git clone -q "$ORIGIN" "$LOCAL"
git -C "$LOCAL" checkout -q -b feature/local

: > "$LOG"
start_api
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

t() { tmux -S "$SOCK" "$@"; }
pane() { t capture-pane -p -J -t "$1" -S -4000 | sed -e 's/[[:space:]]*$//'; }

# Type a command, wait for its sentinel, and leave the output there (drive.sh's pattern).
run_cmd() { # window, marker, command, [tries]
  local window="$1" marker="$2" cmd="$3" tries="${4:-900}"
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
t new-session -d -s "$TERM_SESSION" -n cmd -x 220 -y 60 -c "$LOCAL"
W="$TERM_SESSION:cmd"

# --- the repo and its board ---------------------------------------------------------------------------
run_cmd "$W" repo "$FACTORY repo add $REPO --path $CHECKOUT --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/mcp-repo.txt"
check "the repo is registered with the factory's checkout" \
  "$([ "$(exit_code "$W" repo)" = "0" ] && echo 0 || echo 1)" "$REPO exit=$(exit_code "$W" repo)"
run_cmd "$W" board "$FACTORY board create --repo $REPO --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/mcp-board.txt"
BOARD_ID="$(grep -o 'brd_[0-9a-z]\{26\}' "$EVIDENCE_DIR/mcp-board.txt" | head -1)"
check "a board is over it" "$([ -n "$BOARD_ID" ] && echo 0 || echo 1)" "${BOARD_ID:-none}"

# --- 1. an MCP client creates a card and reads its status --------------------------------------------
for PROTOCOL in 2025-06-18 2025-11-25; do
  OUT="$EVIDENCE_DIR/mcp-client-$PROTOCOL.txt"
  ( cd "$ROOT" && FACTORY="$FACTORY" API_URL="$API_URL" REPO="$REPO" CHECKOUT="$LOCAL" \
      PROTOCOL="$PROTOCOL" TITLE="Made over MCP at $PROTOCOL" \
      EVIDENCE="$EVIDENCE_DIR/mcp-client-$PROTOCOL.json" \
      bun "$ROOT/.pi/skills/verify-cli/mcp-client.ts" ) > "$OUT" 2>&1
  CLIENT_EXIT=$?
  CARD="$(grep -o '^card tsk_[0-9a-z]\{26\}' "$OUT" | cut -d' ' -f2)"
  check "[$PROTOCOL] the MCP session completed" "$([ "$CLIENT_EXIT" = "0" ] && echo 0 || echo 1)" \
    "exit=$CLIENT_EXIT"
  check "[$PROTOCOL] create_card made a card" \
    "$([ -n "$CARD" ] && grep -q '^created ok card tsk_' "$OUT" && echo 0 || echo 1)" "${CARD:-none}"
  check "[$PROTOCOL] get_status reads it back in its column" \
    "$(grep -q "^status ok card $CARD \"Made over MCP at $PROTOCOL\" is in intake (revision 1)" "$OUT" && echo 0 || echo 1)" \
    "$(grep '^status' "$OUT" | head -1)"
  check "[$PROTOCOL] every stdout line was JSON-RPC, and the server exited with stdin" \
    "$(grep -q '^stdout [0-9]* lines, 0 not JSON-RPC$' "$OUT" && grep -q '^exited yes$' "$OUT" && echo 0 || echo 1)" \
    "$(grep -E '^(stdout|exited)' "$OUT" | tr '\n' ' ')"
  run_cmd "$W" "show${PROTOCOL//-/}" "$FACTORY board show --task ${CARD:-tsk_00000000000000000000000000} --api $API_URL" || true
  pane "$W" > "$EVIDENCE_DIR/mcp-show-$PROTOCOL.txt"
  check "[$PROTOCOL] factory board show reads the same card" \
    "$([ "$(exit_code "$W" "show${PROTOCOL//-/}")" = "0" ] && grep -q "Made over MCP at $PROTOCOL" "$EVIDENCE_DIR/mcp-show-$PROTOCOL.txt" && echo 0 || echo 1)" \
    "exit=$(exit_code "$W" "show${PROTOCOL//-/}")"
done

# Claude Code itself, when it is installed: configured with the server in a scratch config directory
# (the operator's ~/.claude.json is never touched), and its health check — which launches the server
# and runs the handshake, with no model call — must say it connected.
if command -v claude >/dev/null 2>&1; then
  CLAUDE_ENV=(env CLAUDE_CONFIG_DIR="$RUN_DIR/claude-config" DISABLE_TELEMETRY=1
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1)
  mkdir -p "$RUN_DIR/claude-config"
  ( cd "$LOCAL" && "${CLAUDE_ENV[@]}" perl -e 'alarm 90; exec @ARGV' claude mcp add -s local factory -- \
      bun "$ROOT/apps/cli/src/index.ts" mcp --api "$API_URL" --repo "$REPO" ) \
    > "$EVIDENCE_DIR/mcp-claude-add.txt" 2>&1
  ( cd "$LOCAL" && "${CLAUDE_ENV[@]}" perl -e 'alarm 90; exec @ARGV' claude mcp get factory ) \
    > "$EVIDENCE_DIR/mcp-claude-get.txt" 2>&1
  check "Claude Code configured with factory mcp connects to it" \
    "$(grep -qi 'connected' "$EVIDENCE_DIR/mcp-claude-get.txt" && ! grep -qi 'failed' "$EVIDENCE_DIR/mcp-claude-get.txt" && echo 0 || echo 1)" \
    "$(grep -i 'status' "$EVIDENCE_DIR/mcp-claude-get.txt" | head -1)"
else
  echo "SKIP  Claude Code is not installed: its own health check was not run"
fi

# --- 2. factory handoff from a dirty checkout -----------------------------------------------------------
# A local commit, an unstaged edit and an untracked file: the work a local agent stopped in.
printf 'committed locally\n' > "$LOCAL/committed.txt"
g -C "$LOCAL" add committed.txt
g -C "$LOCAL" commit -q -m "local commit"
printf 'one\ntwo, edited locally\nthree\n' > "$LOCAL/src.txt"
printf 'work in progress\n' > "$LOCAL/notes.md"
BASE_COMMIT="$(git -C "$LOCAL" merge-base HEAD origin/main)"
# The diff the run must start with, taken the way the command takes it: a scratch index, so the
# operator's own is not touched.
SCRATCH="$RUN_DIR/expected-index"
rm -f "$SCRATCH"
GIT_INDEX_FILE="$SCRATCH" git -C "$LOCAL" read-tree HEAD
GIT_INDEX_FILE="$SCRATCH" git -C "$LOCAL" add -A
GIT_INDEX_FILE="$SCRATCH" git -C "$LOCAL" diff --cached --binary --full-index "$BASE_COMMIT" \
  > "$EVIDENCE_DIR/mcp-expected.patch"
rm -f "$SCRATCH"
LOCAL_BEFORE="$(git -C "$LOCAL" status --porcelain; git -C "$LOCAL" rev-parse HEAD)"

run_cmd "$W" handoff "$FACTORY handoff --repo $REPO --note \"Finish the local work\" --start --column building --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/mcp-handoff.txt"
HANDOFF_TASK="$(grep -o '^task    tsk_[0-9a-z]\{26\}' "$EVIDENCE_DIR/mcp-handoff.txt" | head -1 | awk '{print $2}')"
SESSION_ID="$(grep -o '^session ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/mcp-handoff.txt" | head -1 | awk '{print $2}')"
check "factory handoff made a card and started its run" \
  "$([ "$(exit_code "$W" handoff)" = "0" ] && [ -n "$HANDOFF_TASK" ] && [ -n "$SESSION_ID" ] && echo 0 || echo 1)" \
  "task=${HANDOFF_TASK:-none} session=${SESSION_ID:-none} exit=$(exit_code "$W" handoff)"
check "it named what it handed off" \
  "$(grep -q '^handoff 3 files, [0-9]* bytes from feature/local at .* onto main$' "$EVIDENCE_DIR/mcp-handoff.txt" && echo 0 || echo 1)" \
  "$(grep '^handoff' "$EVIDENCE_DIR/mcp-handoff.txt" | head -1)"

WORKTREE="$RUN_DIR/sessions/${REPO}/${SESSION_ID:-none}"
BRANCH="$(git -C "$WORKTREE" rev-parse --abbrev-ref HEAD 2>/dev/null)"
git -C "$WORKTREE" diff --binary --full-index main HEAD > "$EVIDENCE_DIR/mcp-run.patch" 2>/dev/null
check "the run's worktree is on factory/<session-id>" \
  "$([ "$BRANCH" = "factory/$SESSION_ID" ] && echo 0 || echo 1)" "${BRANCH:-none}"
check "with the same diff committed on it" \
  "$([ -s "$EVIDENCE_DIR/mcp-expected.patch" ] && cmp -s "$EVIDENCE_DIR/mcp-expected.patch" "$EVIDENCE_DIR/mcp-run.patch" && [ -z "$(git -C "$WORKTREE" status --porcelain)" ] && echo 0 || echo 1)" \
  "$(git -C "$WORKTREE" log -1 --format=%s 2>/dev/null)"
check "and the local checkout is left as it was" \
  "$([ "$LOCAL_BEFORE" = "$(git -C "$LOCAL" status --porcelain; git -C "$LOCAL" rev-parse HEAD)" ] && echo 0 || echo 1)" \
  "status and HEAD unchanged"

# The run's first turn: its one command reads the handed-off file.
SNAPSHOT="$EVIDENCE_DIR/mcp-handoff-session.ndjson"
for _ in $(seq 1 240); do
  printf '{"_tag":"Request","id":"1","tag":"getSession","payload":{"sessionId":"%s"},"headers":[]}\n' "$SESSION_ID" |
    curl -s -m 10 -H 'content-type: application/ndjson' --data-binary @- "$API_URL/rpc" > "$SNAPSHOT" 2>&1
  grep -q '"kind":"toolResult"' "$SNAPSHOT" && grep -q '"status":"idle"' "$SNAPSHOT" && break
  sleep 0.5
done
check "the agent's first turn started on the handed-off work" \
  "$(grep -q 'work in progress' "$SNAPSHOT" && grep -q 'Hand off 3 files from local feature/local' "$SNAPSHOT" && echo 0 || echo 1)" \
  "cat notes.md; git log -1 in the run"

# --- 3. the cap -----------------------------------------------------------------------------------------
run_cmd "$W" lsbefore "$FACTORY board ls --board $BOARD_ID --api $API_URL" || true
CARDS_BEFORE="$(pane "$W" | grep -o 'tsk_[0-9a-z]\{26\}' | sort -u | wc -l | tr -d ' ')"
head -c $((CAP + 4096)) /dev/zero | tr '\0' 'x' > "$LOCAL/big.txt"
run_cmd "$W" cap "$FACTORY handoff --repo $REPO --note \"Too big\" --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/mcp-cap.txt"
check "an oversized diff is refused with its size and the cap, non-zero" \
  "$([ "$(exit_code "$W" cap)" != "0" ] && grep -q "^error: handoff_refused: the handoff patch is [0-9]* bytes as a card carries it, over the $CAP-byte cap" "$EVIDENCE_DIR/mcp-cap.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" cap)"
run_cmd "$W" lsafter "$FACTORY board ls --board $BOARD_ID --api $API_URL" || true
CARDS_AFTER="$(pane "$W" | grep -o 'tsk_[0-9a-z]\{26\}' | sort -u | wc -l | tr -d ' ')"
check "and makes no card" "$([ "$CARDS_BEFORE" = "$CARDS_AFTER" ] && [ "$CARDS_BEFORE" != "0" ] && echo 0 || echo 1)" \
  "cards before=$CARDS_BEFORE after=$CARDS_AFTER"
rm -f "$LOCAL/big.txt"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "repo": "%s",\n' "$REPO"
  printf '  "handoffTask": "%s",\n' "$HANDOFF_TASK"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/mcp.json"
cp "$LOG" "$EVIDENCE_DIR/mcp-api.log"

if [ "$failed" -eq 0 ]; then
  echo "mcp: all checks passed"
else
  echo "mcp: some checks failed — see $EVIDENCE_DIR" >&2
fi
exit "$failed"
