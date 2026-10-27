#!/usr/bin/env bash
# Drive `factory approvals` / `factory approve` / `factory deny` in a real tmux terminal (LOB-53): a
# gated call parks a run on an approval, the CLI lists it, decides it, and the parked session resumes
# — the approved call runs, the denied one is refused — and the decided approval leaves the list.
#
# An approval only exists once a gated call asks, and the gate is a deployment setting, so this
# script owns its own API instance — its own port, session root, log, pid file, and tmux server —
# with `APPROVAL_REQUIRED=sleep` and a faux command that is the gated one. It does not touch the
# instance ./up.sh started, and it leaves nothing running. `./drive.sh` runs it as its last block.
#
#   ./approve.sh                   # API on :9320 (APPROVE_PORT overrides it)
#
# Evidence: .verify/evidence/latest/cli/approve-*.txt (the raw panes) and approve.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${APPROVE_PORT:-9320}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-approve"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LOG="$RUN_DIR/api.log"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-approve"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
# The gate and the command it stops. The faux agent runs `$COMMAND` on every turn
# (`FAUX_EVERY_TURN`), which is an agent retrying a call it was blocked on once it is told to.
GATE="sleep"
COMMAND="sleep 1 && echo gated-ran"
RAN="gated-ran"
# 26 Crockford base32 characters that no session was minted with.
UNKNOWN_SESSION="ses_00000000000000000000000000"
UNKNOWN_REQUEST="ask-bash-not-a-request"

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
  echo "port $PORT is already in use — set APPROVE_PORT to a free one" >&2
  exit 1
fi

start_api() {
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      ALLOWED_ORIGINS="http://localhost:$PORT" \
      MODEL_BACKEND=faux \
      FAUX_COMMAND="$COMMAND" \
      FAUX_EVERY_TURN=true \
      APPROVAL_REQUIRED="$GATE" \
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

check "the API logs the gate it was started with" \
  "$(grep -q "commands that wait for an approval: $GATE" "$LOG" && echo 0 || echo 1)" \
  "APPROVAL_REQUIRED=$GATE"

t() { tmux -S "$SOCK" "$@"; }
pane() { t capture-pane -p -J -t "$TERM_SESSION" -S -4000 | sed -e 's/[[:space:]]*$//'; }

# Type a command, wait for its sentinel, and leave the output in the pane (drive.sh's pattern: the
# sentinel is a second typed line, so zsh's url-quote-magic cannot swallow it). The pane is cleared
# first, so an assertion cannot match an earlier command's output.
run_cmd() { # marker, command
  local marker="$1" cmd="$2"
  t send-keys -t "$TERM_SESSION" "clear" Enter
  sleep 0.3
  t clear-history -t "$TERM_SESSION" 2>/dev/null || true
  t send-keys -l -t "$TERM_SESSION" "$cmd"
  t send-keys -t "$TERM_SESSION" Enter
  t send-keys -l -t "$TERM_SESSION" "printf '\\n__done_%s:%s\\n' $marker \$?"
  t send-keys -t "$TERM_SESSION" Enter
  for _ in $(seq 1 600); do
    if pane | grep -q "^__done_$marker:[0-9]*$"; then
      sleep 0.2
      return 0
    fi
    sleep 0.1
  done
  return 1
}

exit_code() { pane | grep -o "__done_$1:[0-9]*" | tail -1 | cut -d: -f2; }

# Run a command and keep its pane as evidence: marker, file, command.
drive() {
  run_cmd "$1" "$3" || true
  pane > "$EVIDENCE_DIR/$2"
}

t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -x 220 -y 60 -c "$ROOT"

# --- a gated call parks a run on an approval -----------------------------------------------------
# The tool result is the harness's blocked sentence, wrapped over several lines, so the checks read
# the sentence itself rather than the `[tool:bash]` line it starts on.
drive park approve-run.txt "$FACTORY run \"approve probe\" --api $API_URL"
SESSION_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/approve-run.txt" | head -1)"
check "factory run exits 0 with the gated call parked" \
  "$([ "$(exit_code park)" = "0" ] && [ -n "$SESSION_ID" ] && echo 0 || echo 1)" \
  "exit=$(exit_code park) id=${SESSION_ID:-none}"
check "the gated call asked and did not run" \
  "$(grep -q '^\[tool:bash\] ' "$EVIDENCE_DIR/approve-run.txt" &&
    grep -qF "Tool call blocked: \`$GATE\` needs a person's approval, and one has been asked for" "$EVIDENCE_DIR/approve-run.txt" &&
    ! grep -q "$RAN" "$EVIDENCE_DIR/approve-run.txt" && echo 0 || echo 1)" \
  "asked; no $RAN"

# --- approvals: the pending request, in every session's list and in the session's own ------------
drive list approve-list.txt "$FACTORY approvals --api $API_URL"
REQUEST_ID="$(awk -v sid="$SESSION_ID" '$2 == sid && $4 == "sleep" { print $1; exit }' "$EVIDENCE_DIR/approve-list.txt")"
check "factory approvals lists the parked run's request" \
  "$([ "$(exit_code list)" = "0" ] &&
    grep -qx 'request  session  requested  action' "$EVIDENCE_DIR/approve-list.txt" &&
    [[ "$REQUEST_ID" == ask-bash-* ]] && echo 0 || echo 1)" \
  "request=${REQUEST_ID:-none}"

drive listone approve-list-session.txt "$FACTORY approvals --session $SESSION_ID --api $API_URL"
check "factory approvals --session lists the same request" \
  "$(grep -q "^$REQUEST_ID  $SESSION_ID  .*  sleep$" "$EVIDENCE_DIR/approve-list-session.txt" && echo 0 || echo 1)" \
  "request=${REQUEST_ID:-none}"

# --- typed refusals: a script branches on the code, and the exit is non-zero ----------------------
drive unknownid approve-unknown-id.txt "$FACTORY approve $SESSION_ID --id $UNKNOWN_REQUEST --api $API_URL"
check "an approval id the session never asked for is not_found" \
  "$(grep -q '^error: not_found' "$EVIDENCE_DIR/approve-unknown-id.txt" &&
    [ "$(exit_code unknownid)" != "0" ] && [ -n "$(exit_code unknownid)" ] && echo 0 || echo 1)" \
  "exit=$(exit_code unknownid)"

drive unknownsession approve-unknown-session.txt "$FACTORY approve $UNKNOWN_SESSION --api $API_URL"
check "an unknown session is not_found" \
  "$(grep -q '^error: not_found' "$EVIDENCE_DIR/approve-unknown-session.txt" &&
    [ "$(exit_code unknownsession)" != "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code unknownsession)"

# The refusals decided nothing: the request is still pending.
drive stillpending approve-list-refused.txt "$FACTORY approvals --session $SESSION_ID --api $API_URL"
check "a refused decision leaves the request pending" \
  "$(grep -q "^$REQUEST_ID  " "$EVIDENCE_DIR/approve-list-refused.txt" && echo 0 || echo 1)" \
  "still listed"

# --- approve: the decision resumes the parked session, and the call runs -------------------------
drive approve approve-approve.txt "$FACTORY approve $SESSION_ID --api $API_URL"
check "factory approve exits 0" "$([ "$(exit_code approve)" = "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code approve)"
check "it names the decision it recorded" \
  "$(grep -qx "approved $REQUEST_ID by cli" "$EVIDENCE_DIR/approve-approve.txt" && echo 0 || echo 1)" \
  "approved $REQUEST_ID by cli"
check "and the follow-up that resumed the session" \
  "$(grep -q "^resumed $SESSION_ID with submission [0-9]*$" "$EVIDENCE_DIR/approve-approve.txt" &&
    grep -qF "[user] Approved: \`$GATE\` (request $REQUEST_ID) was approved by cli." "$EVIDENCE_DIR/approve-approve.txt" &&
    echo 0 || echo 1)" \
  "[user] Approved: ..."
check "the resumed run ran the gated call" \
  "$(grep -q "^\[tool:bash\] $RAN$" "$EVIDENCE_DIR/approve-approve.txt" &&
    grep -q "^answer: $RAN (re: Approved: " "$EVIDENCE_DIR/approve-approve.txt" && echo 0 || echo 1)" \
  "[tool:bash] $RAN, then the answer"

# --- the decided approval left the pending list --------------------------------------------------
drive after approve-list-after.txt "$FACTORY approvals --api $API_URL"
check "the decided approval is gone from every session's list" \
  "$([ "$(exit_code after)" = "0" ] && ! grep -q "^$REQUEST_ID  $SESSION_ID " "$EVIDENCE_DIR/approve-list-after.txt" && echo 0 || echo 1)" \
  "no row for $REQUEST_ID"
drive afterone approve-list-session-after.txt "$FACTORY approvals --session $SESSION_ID --api $API_URL"
check "and the session's own list is empty" \
  "$(grep -qx 'no approvals pending' "$EVIDENCE_DIR/approve-list-session-after.txt" && echo 0 || echo 1)" \
  "no approvals pending"
drive nothing approve-nothing.txt "$FACTORY approve $SESSION_ID --api $API_URL"
check "approving with nothing pending is not_found" \
  "$(grep -q '^error: not_found' "$EVIDENCE_DIR/approve-nothing.txt" && [ "$(exit_code nothing)" != "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code nothing)"

# --- deny: the decision resumes a second parked run, and the call stays refused -------------------
drive park2 approve-run-deny.txt "$FACTORY run \"deny probe\" --api $API_URL"
DENY_SESSION="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/approve-run-deny.txt" | head -1)"
drive deny approve-deny.txt "$FACTORY deny $DENY_SESSION --api $API_URL"
DENY_REQUEST="$(grep -o '^denied ask-bash-[0-9a-f]* by cli$' "$EVIDENCE_DIR/approve-deny.txt" | cut -d' ' -f2)"
check "factory deny exits 0 and names the denial" \
  "$([ "$(exit_code deny)" = "0" ] && [ -n "$DENY_REQUEST" ] && echo 0 || echo 1)" \
  "denied ${DENY_REQUEST:-none} by cli"
check "the denied run resumed, and the call was refused, not run" \
  "$(grep -qF "[user] Denied: \`$GATE\` (request $DENY_REQUEST) was denied by cli." "$EVIDENCE_DIR/approve-deny.txt" &&
    grep -qF "Tool call blocked: \`$GATE\` was denied by cli (request $DENY_REQUEST)" "$EVIDENCE_DIR/approve-deny.txt" &&
    ! grep -q "$RAN" "$EVIDENCE_DIR/approve-deny.txt" && echo 0 || echo 1)" \
  "[user] Denied: ...; refused; no $RAN"
drive denyafter approve-list-deny-after.txt "$FACTORY approvals --api $API_URL"
check "the denied approval is gone from the list" \
  "$([ -n "$DENY_REQUEST" ] && ! grep -q "^$DENY_REQUEST  $DENY_SESSION " "$EVIDENCE_DIR/approve-list-deny-after.txt" && echo 0 || echo 1)" \
  "no row for ${DENY_REQUEST:-none}"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "requestId": "%s",\n' "$REQUEST_ID"
  printf '  "deniedSessionId": "%s",\n' "$DENY_SESSION"
  printf '  "deniedRequestId": "%s",\n' "$DENY_REQUEST"
  printf '  "approvalRequired": "%s",\n' "$GATE"
  printf '  "fauxCommand": "%s",\n' "$COMMAND"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/approve.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "approve: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "approve: FAILURES — see $EVIDENCE_DIR/approve.json and $LOG" >&2
fi
exit "$failed"
