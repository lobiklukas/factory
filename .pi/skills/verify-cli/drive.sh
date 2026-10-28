#!/usr/bin/env bash
# Drive `factory run` / `watch` / `ls` — through ./repo.sh, `repo add` / `ls` / `show`, and through
# ./approve.sh, `approvals` / `approve` / `deny` — in a real tmux terminal and capture the evidence.
#
# A command line is only proven by running it the way a person does: a real terminal, the real
# control plane over HTTP, and the text it printed read back. Calling the RPC client from a test
# process would prove the client and nothing about the command — argument parsing, when the stream
# ends, what the transcript looks like, and the exit code a script would branch on.
#
# Requires the instance from ./up.sh (API on :9300, MODEL_BACKEND=faux), and the same DATABASE_URL in
# this shell as up.sh had: the PR-link checks seed a session through that database (LOB-65).
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
# What `factory ls` prints in the `pr` column for a session with no PR (apps/cli/src/commands/ls.ts).
NO_PR="-"

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

# The pane, with trailing whitespace stripped so a `grep -q '^mode: live$'` is exact. `-J` joins a
# line the terminal wrapped, so an `ls` row longer than the pane is still one row to `awk`.
pane() { t capture-pane -p -J -t "$TERM_SESSION" -S -4000 | sed -e 's/[[:space:]]*$//'; }

# The `pr` field of one session's `ls` row: everything before the title is one token, and the PR
# link is the sixth (LOB-65). Empty when the file has no row for the id.
pr_field() { awk -v id="$2" '$1 == id { print $6; exit }' "$EVIDENCE_DIR/$1"; }

# The `model` field of one session's `ls` row: the seventh, right after the PR link (LOB-272). The
# column is placed after `pr` so the link stays the sixth field a script already reads.
model_field() { awk -v id="$2" '$1 == id { print $7; exit }' "$EVIDENCE_DIR/$1"; }

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

# LOB-272: the model the session is pinned to, and the warning a scripted one earns. This instance
# is `MODEL_BACKEND=faux`, so both lines are required; the same line carries no warning on anthropic
# (proved by verify-web's `backend.sh`, which runs `factory status` and `factory ls` against one).
check "run prints the model the session is pinned to" \
  "$(grep -qx 'model faux/faux-1' "$EVIDENCE_DIR/run.txt" && echo 0 || echo 1)" \
  "model=$(grep -m1 '^model ' "$EVIDENCE_DIR/run.txt")"
check "run warns that the faux backend is scripted" \
  "$(grep -q '^warning: faux backend' "$EVIDENCE_DIR/run.txt" && echo 0 || echo 1)" \
  "$(grep -m1 '^warning: faux backend' "$EVIDENCE_DIR/run.txt" | cut -c1-90)"

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
check "ls prints a pr column" \
  "$(grep -q '^id  status  repo  last-activity  cost  pr  model  title$' "$EVIDENCE_DIR/ls.txt" && echo 0 || echo 1)" \
  "header names pr"
RUN_PR="$(pr_field ls.txt "$SESSION_ID")"
check "a session with no PR shows the placeholder, not an empty cell" \
  "$([ "$RUN_PR" = "$NO_PR" ] && echo 0 || echo 1)" \
  "pr=${RUN_PR:-<empty>}"

check "ls has a MODEL column with the session's model" \
  "$([ "$(model_field ls.txt "$SESSION_ID")" = "faux/faux-1" ] && echo 0 || echo 1)" \
  "model=$(model_field ls.txt "$SESSION_ID")"

# --- status: what the control plane runs, and why (LOB-272) ---------------------------------------
fresh
run_cmd status "$FACTORY status --api $API_URL" || true
capture status.txt
check "factory status exits 0" "$([ "$(exit_code status)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code status)"
check "status prints the backend" \
  "$(grep -qx 'backend faux' "$EVIDENCE_DIR/status.txt" && echo 0 || echo 1)" \
  "$(grep -m1 '^backend ' "$EVIDENCE_DIR/status.txt")"
check "status prints what chose it, and the boot's reason" \
  "$(grep -qx 'selected-by MODEL_BACKEND' "$EVIDENCE_DIR/status.txt" && grep -qx 'reason model backend: faux (selected by MODEL_BACKEND)' "$EVIDENCE_DIR/status.txt" && echo 0 || echo 1)" \
  "$(grep -m1 '^selected-by ' "$EVIDENCE_DIR/status.txt")"
check "status prints the default model, the faux warning and the sandbox" \
  "$(grep -qx 'default-model faux/faux-1' "$EVIDENCE_DIR/status.txt" && grep -q '^warning .*faux provider' "$EVIDENCE_DIR/status.txt" && grep -q '^sandbox ' "$EVIDENCE_DIR/status.txt" && echo 0 || echo 1)" \
  "$(grep -m1 '^default-model ' "$EVIDENCE_DIR/status.txt")"

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

# --- ls, with a PR: the link the session recorded (LOB-65) ----------------------------------------
# The API has no RPC that opens a PR, so the seed is the in-process caller of the real PR step,
# against a loopback GitHub fake, on this API's database and session root. It exits before `ls`
# runs, so the row below is the API's read of the index, not the seed's. It runs after both watches
# because it takes seconds, and the live watch has to land inside the short idle window up.sh set.
SEED_OUT="$RUN_DIR/cli-pr-seed.json"
rm -f "$SEED_OUT"
env PR_SEED_OUT="$SEED_OUT" SESSION_ROOT="$RUN_DIR/sessions" PR_SEED_TITLE="verify-cli pr probe" \
  bun "$ROOT/.pi/skills/lib/seed-pr.ts" > "$EVIDENCE_DIR/pr-seed.txt" 2>&1
SEED_RC=$?
SEED_ID="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).sessionId ?? "")' "$SEED_OUT" 2>/dev/null)"
SEED_URL="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).prUrl ?? "")' "$SEED_OUT" 2>/dev/null)"
check "a session with a recorded PR was seeded" \
  "$([ "$SEED_RC" = "0" ] && [ -n "$SEED_ID" ] && [ -n "$SEED_URL" ] && echo 0 || echo 1)" \
  "exit=$SEED_RC id=${SEED_ID:-none} prUrl=${SEED_URL:-none}"

fresh
run_cmd lspr "$FACTORY ls --api $API_URL" || true
capture ls-pr.txt
SEED_PR="$(pr_field ls-pr.txt "$SEED_ID")"
check "factory ls exits 0 with a PR in the list" "$([ "$(exit_code lspr)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code lspr)"
check "ls shows the recorded PR URL for the session that has one" \
  "$([ -n "$SEED_URL" ] && [ "$SEED_PR" = "$SEED_URL" ] && echo 0 || echo 1)" \
  "pr=${SEED_PR:-<empty>}"
RUN_PR_AFTER="$(pr_field ls-pr.txt "$SESSION_ID")"
check "and still the placeholder for the session that has none" \
  "$([ "$RUN_PR_AFTER" = "$NO_PR" ] && echo 0 || echo 1)" \
  "pr=${RUN_PR_AFTER:-<empty>}"

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

# --- repo: the registry, added to, listed and shown (LOB-253) -------------------------------------
# `./repo.sh` drives this same instance in a tmux server of its own; its checks are in repo.json, and
# the drive fails when any of them does. It is handed the parent of `$EVIDENCE_DIR`, as approve.sh is.
REPO_LOG="$RUN_DIR/cli-repo.log"
API_URL="$API_URL" EVIDENCE_DIR="${EVIDENCE_DIR%/cli}" "$ROOT/.pi/skills/verify-cli/repo.sh" > "$REPO_LOG" 2>&1
REPO_RC=$?
cat "$REPO_LOG"
check "repo.sh adds, lists and shows repos" \
  "$([ "$REPO_RC" = "0" ] && echo 0 || echo 1)" \
  "exit=$REPO_RC; checks $(grep -c '^PASS' "$REPO_LOG") passed, $(grep -c '^FAIL' "$REPO_LOG") failed"

# --- approvals: a gated call parked, decided from the CLI, and resumed (LOB-53) ---------------------
# The gate is a deployment setting, so the approval block owns its own API with
# `APPROVAL_REQUIRED` set (`./approve.sh`, `APPROVE_PORT`, default :9330); this instance stays
# ungated so the run above is the plain faux turn. Its checks are in approve.json; the drive fails
# when any of them does.
# approve.sh scopes its evidence to `<dir>/cli` as this script does, so it is handed the parent of
# this script's `$EVIDENCE_DIR` — an exported EVIDENCE_DIR would otherwise nest it at `cli/cli`.
APPROVE_LOG="$RUN_DIR/cli-approve.log"
EVIDENCE_DIR="${EVIDENCE_DIR%/cli}" "$ROOT/.pi/skills/verify-cli/approve.sh" > "$APPROVE_LOG" 2>&1
APPROVE_RC=$?
cat "$APPROVE_LOG"
check "approve.sh decides a parked approval and the session resumes" \
  "$([ "$APPROVE_RC" = "0" ] && echo 0 || echo 1)" \
  "exit=$APPROVE_RC; checks $(grep -c '^PASS' "$APPROVE_LOG") passed, $(grep -c '^FAIL' "$APPROVE_LOG") failed"

# --- evidence ------------------------------------------------------------------------------------
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "prSessionId": "%s",\n' "$SEED_ID"
  printf '  "prUrl": "%s",\n' "$SEED_URL"
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
