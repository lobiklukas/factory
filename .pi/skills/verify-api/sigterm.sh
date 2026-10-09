#!/usr/bin/env bash
# Prove SIGTERM mid-run (LOB-21): the process releases the session owners it holds, and the session
# it interrupted is resumable rather than lost.
#
# This script owns its own API instance — its own port, session root, log and pid file — because the
# point of the test is to kill it. It does not touch the instance ./up.sh started, and it leaves
# nothing running.
#
#   ./sigterm.sh
#
# Evidence: .verify/evidence/latest/api/sigterm-session.json (what the session looked like, from the
# driver) plus sigterm-process.json (what the process did, from this script), the API log, and the
# transcript as text.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${SIGTERM_PORT:-9400}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/sigterm"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
STATE="$RUN_DIR/session-id"
DRIVER="$ROOT/.pi/skills/verify-api/sigterm.ts"
LOG="$RUN_DIR/api.log"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"
rm -f "$STATE"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-52s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-52s %s\n' "$1" "$3"
  fi
}

# The checks as a JSON object keyed by name, matching the drivers' evidence files.
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

start_api() { # faux command
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      FAUX_COMMAND="$1" \
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
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

trap 'stop_api' EXIT

# The session log is Postgres; the shared check asks the port before it asks compose, so this works
# from a ralph worktree (LOB-57).
source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

: > "$LOG"
# The faux tool call sleeps, so the run is genuinely in flight when the signal lands.
start_api "sleep 8 && echo faux-ok"
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

# --- arm: a busy session, then SIGTERM ------------------------------------------------------------
MODE=arm API_URL="$API_URL" SIGTERM_STATE="$STATE" EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$DRIVER" > "$RUN_DIR/arm.log" 2>&1 &
ARM_PID=$!

for _ in $(seq 1 150); do [ -s "$STATE" ] && break; sleep 0.1; done
if [ ! -s "$STATE" ]; then
  echo "the arm phase never reached a busy run — see $RUN_DIR/arm.log" >&2
  kill "$ARM_PID" 2>/dev/null || true
  exit 1
fi
SESSION_ID="$(cat "$STATE")"
API_PID="$(cat "$RUN_DIR/api.pid")"

kill -TERM "$API_PID"
for _ in $(seq 1 150); do kill -0 "$API_PID" 2>/dev/null || break; sleep 0.1; done
wait "$ARM_PID" 2>/dev/null || true
rm -f "$RUN_DIR/api.pid"

cat "$RUN_DIR/arm.log"
check "the process exits on SIGTERM" \
  "$(kill -0 "$API_PID" 2>/dev/null && echo 1 || echo 0)" \
  "pid=$API_PID session=$SESSION_ID"
check "the shutdown finalizer logged the release" \
  "$(grep -q 'shutdown: releasing every session owner' "$LOG" && echo 0 || echo 1)" \
  "log line present"
check "and reported the owners released" \
  "$(grep -q 'shutdown: session owners released' "$LOG" && echo 0 || echo 1)" \
  "log line present"

# --- verify: a fresh process reads the session back and continues it ------------------------------
start_api "echo faux-ok"
wait_ready || { echo "the restarted api did not become ready — see $LOG" >&2; exit 1; }

MODE=verify API_URL="$API_URL" SIGTERM_STATE="$STATE" EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$DRIVER" > "$RUN_DIR/verify.log" 2>&1
VERIFY_RC=$?
cat "$RUN_DIR/verify.log"
check "the resumed session passes its checks" "$([ "$VERIFY_RC" = "0" ] && echo 0 || echo 1)" "exit=$VERIFY_RC"

cp "$LOG" "$EVIDENCE_DIR/sigterm-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/sigterm-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "sigterm: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "sigterm: FAILURES — see $EVIDENCE_DIR/sigterm-process.json" >&2
fi
exit "$failed"
