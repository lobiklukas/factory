#!/usr/bin/env bash
# Drive `factory run` / `watch` / `ls` in a real tmux terminal and capture the evidence.
#
# A command line is only proven by running it the way a person does: a real terminal, the real
# control plane over HTTP, and the text it printed read back. Calling the RPC client from a test
# process would prove the client and nothing about the command — argument parsing, when the stream
# ends, what the transcript looks like, and the exit code a script would branch on.
#
# Requires the instance from ./up.sh (API on :9300, MODEL_BACKEND=faux).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9300}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
SOCK="$RUN_DIR/cli-tmux.sock"
TERM_SESSION="verify-cli"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
PROMPT="verify-cli probe"
ANSWER="faux-ok (re: $PROMPT)"
# The window up.sh configured; the fold check waits it out.
IDLE_MS="$(cat "$RUN_DIR/cli-idle-ms" 2>/dev/null || echo 5000)"
# 26 Crockford base32 characters that no session was minted with.
UNKNOWN_ID="ses_00000000000000000000000000"

mkdir -p "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-42s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-42s %s\n' "$1" "$3"
  fi
}

# The checks as a JSON object keyed by name, matching `verify-api`'s drivers so the evidence files
# across the skills can be read the same way.
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

t() { tmux -S "$SOCK" "$@"; }

# The pane, with trailing whitespace stripped so a `grep -q '^mode: live$'` is exact.
pane() { t capture-pane -p -t "$TERM_SESSION" -S -4000 | sed -e 's/[[:space:]]*$//'; }

capture() { pane > "$EVIDENCE_DIR/$1"; }

# Start each command from an empty pane: assertions must not match an earlier command's output.
fresh() {
  t send-keys -t "$TERM_SESSION" "clear" Enter
  sleep 0.3
  t clear-history -t "$TERM_SESSION" 2>/dev/null || true
}

# Type a command, wait for its sentinel, and leave the output in the pane.
#
# The sentinel is a *second* typed line (`printf '\n__done_%s:%s\n' run $?`) rather than a `;`
# continuation of the first: zsh's `url-quote-magic` widget escapes a `;` typed directly after a
# URL-looking word, and the API URL is one — the escape turns the sentinel into an argument of the
# command instead of a new command. `$?` still carries the exit code of the line above, because zsh
# executes the buffered line after the command finishes. The marker is never typed as a literal
# (`__done_%s:` + the marker), so the wait cannot match its own input.
run_cmd() { # marker, command
  local marker="$1"
  local cmd="$2"
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

# The control plane must be ready before anything is driven against it.
if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi

# A private tmux server, so this never touches a session the developer is using.
t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -x 200 -y 50 -c "$ROOT"

# --- run: create, stream, and answer -------------------------------------------------------------
fresh
run_cmd run "$FACTORY run \"$PROMPT\" --api $API_URL" || true
capture run.txt
SESSION_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/run.txt" | head -1)"

check "factory run exits 0" "$([ "$(exit_code run)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code run)"
check "run names the session it minted" "$([ -n "$SESSION_ID" ] && echo 0 || echo 1)" "id=${SESSION_ID:-none}"
check "run reports the workspace the server resolved" \
  "$(grep -q '^workspace /' "$EVIDENCE_DIR/run.txt" && echo 0 || echo 1)" \
  "workspace=$(grep -m1 '^workspace ' "$EVIDENCE_DIR/run.txt" | cut -c1-40)"
check "run streams the tool call" \
  "$(grep -q '^\[tool:bash\] faux-ok' "$EVIDENCE_DIR/run.txt" && echo 0 || echo 1)" \
  "tool result present"
check "run prints the answer the tool produced" \
  "$(grep -qF "answer: $ANSWER" "$EVIDENCE_DIR/run.txt" && echo 0 || echo 1)" \
  "answer matches the prompt echo"

# --- ls: the server's list, not a local registry -------------------------------------------------
fresh
run_cmd ls "$FACTORY ls --api $API_URL" || true
capture ls.txt
check "factory ls exits 0" "$([ "$(exit_code ls)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code ls)"
check "ls lists the session this run created" \
  "$([ -n "$SESSION_ID" ] && grep -q "^$SESSION_ID" "$EVIDENCE_DIR/ls.txt" && echo 0 || echo 1)" \
  "row present"
check "ls reads the title from the index" \
  "$(grep -qF "$PROMPT" "$EVIDENCE_DIR/ls.txt" && echo 0 || echo 1)" \
  "title present"

# --- watch, live: this process owns the session ---------------------------------------------------
fresh
run_cmd watchlive "$FACTORY watch $SESSION_ID --api $API_URL" || true
capture watch-live.txt
check "watch labels a session this process owns live" \
  "$(grep -q '^mode: live$' "$EVIDENCE_DIR/watch-live.txt" && echo 0 || echo 1)" \
  "mode=live"
check "the live watch prints the same answer" \
  "$(grep -qF "answer: $ANSWER" "$EVIDENCE_DIR/watch-live.txt" && echo 0 || echo 1)" \
  "answer matches"

# --- watch, historical: the idle sweep released the owner (D8's other half) -----------------------
sleep "$((IDLE_MS / 1000 + 5))"
fresh
run_cmd watchfold "$FACTORY watch $SESSION_ID --api $API_URL" || true
capture watch-historical.txt
check "watch labels a released session historical" \
  "$(grep -q '^mode: historical$' "$EVIDENCE_DIR/watch-historical.txt" && echo 0 || echo 1)" \
  "mode=historical"
check "the fold prints the same answer" \
  "$(grep -qF "answer: $ANSWER" "$EVIDENCE_DIR/watch-historical.txt" && echo 0 || echo 1)" \
  "answer matches"

# --- typed errors: a script can branch on the code, not on prose ----------------------------------
fresh
run_cmd unknown "$FACTORY watch $UNKNOWN_ID --api $API_URL" || true
capture watch-unknown.txt
check "an unknown session is refused with the typed code" \
  "$(grep -q '^error: not_found' "$EVIDENCE_DIR/watch-unknown.txt" && echo 0 || echo 1)" \
  "error=not_found"
check "and the command exits non-zero" \
  "$([ "$(exit_code unknown)" != "0" ] && [ -n "$(exit_code unknown)" ] && echo 0 || echo 1)" \
  "exit=$(exit_code unknown)"

# --- evidence ------------------------------------------------------------------------------------
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "prompt": "%s",\n' "$PROMPT"
  printf '  "idleTimeoutMs": %s,\n' "$IDLE_MS"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/observed.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "drive: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "drive: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$failed"
