#!/usr/bin/env bash
# Prove a long session's history over the wire (LOB-243): once its owner is released, a read
# carries the newest HISTORY_WINDOW entries and says where they start, `readSessionHistory` pages
# back through the rest to the first entry, `factory watch` says the entries it printed are not
# the first, and `factory history --before <earlier> --all` prints the rest.
#
# This script owns its own API instance — its own port, session root, log and pid file — because it
# needs a short idle timeout (the fold is the path under test) and a session grown past the window,
# which nothing else here leaves behind. It does not touch the instance ./up.sh starts, and it
# leaves nothing running.
#
#   ./history.sh
#   HISTORY_PORT=9531 ./history.sh     # another port
#
# Evidence: .verify/evidence/latest/api/history.json (every check the driver made, the window and
# each page), history-cli.txt (what `factory watch` printed), history-cli-earlier.txt (what
# `factory history --all` printed) and history-process.json (this
# script's checks) and history-api.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${HISTORY_PORT:-9437}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/history"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
# The window `readHistoricalSnapshot` serves (`HISTORY_WINDOW` in packages/harness/src/session.ts).
WINDOW=200

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

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — set HISTORY_PORT to a free one" >&2
  exit 1
fi

start_api() {
  # A 4 s idle timeout: long enough that a turn is read back live before its owner goes, short
  # enough that the drive reaches the fold without waiting long.
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=4000 \
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
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

trap 'stop_api' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

: > "$LOG"
start_api
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

# --- the driver: the RPC client the CLI and the dashboard build ------------------------------------
API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" HISTORY_WINDOW="$WINDOW" \
  bun "$ROOT/.pi/skills/verify-api/history.ts" > "$RUN_DIR/driver.log" 2>&1
DRIVER_RC=$?
cat "$RUN_DIR/driver.log"
check "the driver passes its checks" "$([ "$DRIVER_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVER_RC"

SESSION="$(sed -n 's/^SESSION=//p' "$EVIDENCE_DIR/history-session.env" 2>/dev/null)"
EARLIER="$(sed -n 's/^EARLIER=//p' "$EVIDENCE_DIR/history-session.env" 2>/dev/null)"

# --- the operator's terminal: factory watch on the released session --------------------------------
( cd "$ROOT/apps/cli" && bun run src/index.ts watch "$SESSION" --api "$API_URL" ) \
  > "$RUN_DIR/cli.txt" 2>&1
CLI_RC=$?
cp "$RUN_DIR/cli.txt" "$EVIDENCE_DIR/history-cli.txt"
check "factory watch exits cleanly" "$([ "$CLI_RC" = "0" ] && echo 0 || echo 1)" "exit=$CLI_RC"
check "factory watch reads the fold" \
  "$(grep -q '^mode: historical$' "$RUN_DIR/cli.txt" && echo 0 || echo 1)" "mode line"
check "factory watch says the entries before the window are not shown, and how to print them" \
  "$([ -n "$EARLIER" ] && grep -q "^\[earlier\] entries before $EARLIER are not shown; factory history $SESSION --before $EARLIER prints them$" "$RUN_DIR/cli.txt" && echo 0 || echo 1)" \
  "earlier=$EARLIER"

# --- the rest of it from the terminal: factory history --before <earlier> --all --------------------
( cd "$ROOT/apps/cli" && bun run src/index.ts history "$SESSION" --before "$EARLIER" --all --api "$API_URL" ) \
  > "$RUN_DIR/cli-history.txt" 2>&1
HISTORY_RC=$?
cp "$RUN_DIR/cli-history.txt" "$EVIDENCE_DIR/history-cli-earlier.txt"
check "factory history exits cleanly" "$([ "$HISTORY_RC" = "0" ] && echo 0 || echo 1)" "exit=$HISTORY_RC"
check "factory history --all reaches the first entry (no [earlier] line)" \
  "$(grep -q '^\[earlier\]' "$RUN_DIR/cli-history.txt" && echo 1 || echo 0)" "lines=$(wc -l < "$RUN_DIR/cli-history.txt" | tr -d ' ')"
# history's lines then watch's are the whole conversation: every turn's message once, in order.
TURNS="$(sed -n 's/^  "turns": \([0-9]*\),$/\1/p' "$EVIDENCE_DIR/history.json")"
cat "$RUN_DIR/cli-history.txt" "$RUN_DIR/cli.txt" | grep '^\[user\] history turn ' > "$RUN_DIR/cli-users.txt"
seq 0 $(( ${TURNS:-1} - 1 )) | sed 's/^/[user] history turn /' > "$RUN_DIR/cli-users-expected.txt"
check "factory history then factory watch print every turn's message once, in order" \
  "$([ -n "$TURNS" ] && cmp -s "$RUN_DIR/cli-users.txt" "$RUN_DIR/cli-users-expected.txt" && echo 0 || echo 1)" \
  "turns=$TURNS printed=$(wc -l < "$RUN_DIR/cli-users.txt" | tr -d ' ')"

cp "$LOG" "$EVIDENCE_DIR/history-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "session": "%s",\n' "$SESSION"
  printf '  "window": %s,\n' "$WINDOW"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/history-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "history: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "history: FAILURES — see $EVIDENCE_DIR/history-process.json" >&2
fi
exit "$failed"
