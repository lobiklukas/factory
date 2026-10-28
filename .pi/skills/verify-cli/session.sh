#!/usr/bin/env bash
# Drive `factory fork`, `reset`, `compact` and `spend` in a real tmux terminal (C15): the session
# controls the dashboard has, from a shell. A fork's transcript is the parent's, a reset leaves a
# marker the transcript shows, a compaction prints its summary (or says there was nothing to
# compact), and `spend` prints the totals `listSpend` returns, narrowed by `--repo` and `--actor`.
# Every command refuses an unknown id with a typed error and a non-zero exit.
#
# The scripted model is faux: no key, no network. The script owns its own API instance (its own
# port, session root, checkout, log, pid file and tmux server), because a repo-bound session needs a
# checkout to cut a worktree from and spend needs a model that reports a cost (`FAUX_COST`). It does
# not touch the instance ./up.sh started, and it leaves nothing running.
#
#   ./session.sh                   # API on :9380 (SESSION_PORT overrides it)
#
# Evidence: .verify/evidence/latest/cli/session-*.txt (the raw panes) and session.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${SESSION_PORT:-9380}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-session"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LOG="$RUN_DIR/api.log"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-session"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
CHECKOUT="$RUN_DIR/checkout"
# A slug this run owns: a slug another drive registered would hand the session that drive's checkout.
REPO="lobiklukas/factory-session-$(date +%s)$$"
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
      FAUX_COST=0.01 \
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
  echo "port $PORT is already in use — set SESSION_PORT to a free one" >&2
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
  commit -q --allow-empty -m "session checkout"

: > "$LOG"
start_api
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

# No CLI verb registers a checkout yet, so the repo is registered over the RPC the CLI speaks.
# The request line keeps its newline (NDJSON), so it is piped rather than substituted.
printf '{"_tag":"Request","id":"1","tag":"registerRepo","payload":{"repo":"%s","localPath":"%s"},"headers":[]}\n' \
  "$REPO" "$CHECKOUT" |
  curl -s -m 10 -H 'content-type: application/ndjson' --data-binary @- "$API_URL/rpc" \
    > "$EVIDENCE_DIR/session-register.txt" 2>&1
check "the repo is registered with its checkout" \
  "$(grep -q '"_tag":"Success"' "$EVIDENCE_DIR/session-register.txt" && echo 0 || echo 1)" "$REPO"

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

# Read one session over the RPC the CLI speaks, for what the CLI does not print: entry ids.
rpc_entries() { # session id -> "<id> <kind>" per entry, oldest first
  printf '{"_tag":"Request","id":"1","tag":"getSession","payload":{"sessionId":"%s"},"headers":[]}\n' "$1" |
    curl -s -m 10 -H 'content-type: application/ndjson' --data-binary @- "$API_URL/rpc" |
    bun -e '
      const text = await Bun.stdin.text();
      for (const line of text.split("\n").filter(Boolean)) {
        const entries = JSON.parse(line)?.exit?.value?.entries;
        if (Array.isArray(entries)) for (const e of entries) console.log(e.id, e.kind);
      }'
}

t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -n cmd -x 200 -y 60 -c "$ROOT"
W="$TERM_SESSION:cmd"
ACTOR="verify-$$"

# --- two runs: one on the repo (attributed to $ACTOR), one scratch (attributed to nobody named) -----
run_cmd "$W" run "$FACTORY run \"fork probe\" --repo $REPO --base-ref main --actor $ACTOR --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-run.txt"
PARENT="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/session-run.txt" | head -1)"
check "factory run opened a session on the repo" \
  "$([ "$(exit_code "$W" run)" = "0" ] && [ -n "$PARENT" ] && echo 0 || echo 1)" \
  "id=${PARENT:-none} exit=$(exit_code "$W" run)"

# --- fork ----------------------------------------------------------------------------------------
run_cmd "$W" fork "$FACTORY fork $PARENT --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-fork.txt"
CHILD="$(grep -o "^fork ses_[0-9a-z]\{26\} of $PARENT$" "$EVIDENCE_DIR/session-fork.txt" | cut -d' ' -f2)"
check "factory fork exits 0 and prints the child's id" \
  "$([ "$(exit_code "$W" fork)" = "0" ] && [ -n "$CHILD" ] && [ "$CHILD" != "$PARENT" ] && echo 0 || echo 1)" \
  "child=${CHILD:-none} exit=$(exit_code "$W" fork)"

run_cmd "$W" watchchild "$FACTORY watch $CHILD --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-fork-watch.txt"
check "the child's transcript is the parent's: the task and its answer" \
  "$(grep -qx '\[user\] fork probe' "$EVIDENCE_DIR/session-fork-watch.txt" && grep -q '^answer: ' "$EVIDENCE_DIR/session-fork-watch.txt" && echo 0 || echo 1)" \
  "[user] fork probe, then an answer"

# --at: fork at the parent's first entry, which leaves the child with that entry and no answer.
FIRST_ID="$(rpc_entries "$PARENT" | awk '$2 == "user" { print $1; exit }')"
run_cmd "$W" forkat "$FACTORY fork $PARENT --at $FIRST_ID --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-fork-at.txt"
EARLY="$(grep -o "^fork ses_[0-9a-z]\{26\} of $PARENT at entry $FIRST_ID$" "$EVIDENCE_DIR/session-fork-at.txt" | cut -d' ' -f2)"
check "factory fork --at prints a child forked at that entry" \
  "$([ "$(exit_code "$W" forkat)" = "0" ] && [ -n "$EARLY" ] && [ -n "$FIRST_ID" ] && echo 0 || echo 1)" \
  "child=${EARLY:-none} at=${FIRST_ID:-none}"
EARLY_KINDS="$(rpc_entries "$EARLY" | awk '{ print $2 }' | tr '\n' ' ')"
check "and the child holds the prefix up to it, not the later turns" \
  "$(echo "$EARLY_KINDS" | grep -q 'user' && ! echo "$EARLY_KINDS" | grep -q 'assistant' && echo 0 || echo 1)" \
  "kinds=$EARLY_KINDS"

run_cmd "$W" forkbad "$FACTORY fork $PARENT --at no-such-entry --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-fork-bad.txt"
check "an entry the parent does not have is error: invalid_input, non-zero" \
  "$([ "$(exit_code "$W" forkbad)" != "0" ] && grep -q '^error: invalid_input' "$EVIDENCE_DIR/session-fork-bad.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" forkbad)"

run_cmd "$W" forkunknown "$FACTORY fork $UNKNOWN --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-fork-unknown.txt"
check "forking an unknown id is error: not_found, non-zero" \
  "$([ "$(exit_code "$W" forkunknown)" != "0" ] && grep -q '^error: not_found' "$EVIDENCE_DIR/session-fork-unknown.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" forkunknown)"

# --- reset -----------------------------------------------------------------------------------------
NOTE="we were fixing the flaky login test"
run_cmd "$W" reset "$FACTORY reset $PARENT --note \"$NOTE\" --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-reset.txt"
MARKER="$(grep -o "^reset $PARENT marker [0-9a-z]*$" "$EVIDENCE_DIR/session-reset.txt" | awk '{ print $4 }')"
check "factory reset --note exits 0 and prints the new context marker" \
  "$([ "$(exit_code "$W" reset)" = "0" ] && [ -n "$MARKER" ] && grep -qx "\[reset\] $NOTE" "$EVIDENCE_DIR/session-reset.txt" && echo 0 || echo 1)" \
  "marker=${MARKER:-none}"
check "the marker is the transcript's own reset entry" \
  "$(rpc_entries "$PARENT" | grep -qx "$MARKER reset" && echo 0 || echo 1)" \
  "entries=$(rpc_entries "$PARENT" | awk '{ print $2 }' | tr '\n' ' ')"

run_cmd "$W" watchreset "$FACTORY watch $PARENT --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-reset-watch.txt"
check "factory watch shows the turns before the reset, then the handoff" \
  "$(awk -v note="[reset] $NOTE" '/^\[user\] fork probe$/ { user = 1 } user && /^\[assistant\]/ { answered = 1 } answered && $0 == note { found = 1 } END { exit !found }' "$EVIDENCE_DIR/session-reset-watch.txt" && echo 0 || echo 1)" \
  "[user], [assistant], [reset]"

run_cmd "$W" resetbare "$FACTORY reset $PARENT --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-reset-bare.txt"
BARE="$(grep -o "^reset $PARENT marker [0-9a-z]*$" "$EVIDENCE_DIR/session-reset-bare.txt" | awk '{ print $4 }')"
check "a reset with no note prints a second, different marker and no handoff line" \
  "$([ -n "$BARE" ] && [ "$BARE" != "$MARKER" ] && ! grep -q '^\[reset\]' "$EVIDENCE_DIR/session-reset-bare.txt" && echo 0 || echo 1)" \
  "marker=${BARE:-none}"

run_cmd "$W" resetunknown "$FACTORY reset $UNKNOWN --note x --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-reset-unknown.txt"
check "resetting an unknown id is error: not_found, non-zero" \
  "$([ "$(exit_code "$W" resetunknown)" != "0" ] && grep -q '^error: not_found' "$EVIDENCE_DIR/session-reset-unknown.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" resetunknown)"

# --- compact ---------------------------------------------------------------------------------------
# Pi Durable summarizes an old prefix and keeps the newest 20k tokens verbatim, so a short session has
# nothing to cut: the long one is a scratch session whose first message is 90k characters.
head -c 90000 /dev/zero | tr '\0' 'y' > "$RUN_DIR/long.txt"
run_cmd "$W" long "$FACTORY run \"\$(cat $RUN_DIR/long.txt)\" --actor $ACTOR --api $API_URL > $RUN_DIR/long-run.txt" 900 || true
LONG="$(grep -o 'ses_[0-9a-z]\{26\}' "$RUN_DIR/long-run.txt" | head -1)"
check "a scratch run with a long first message settled" \
  "$([ "$(exit_code "$W" long)" = "0" ] && [ -n "$LONG" ] && echo 0 || echo 1)" \
  "id=${LONG:-none} exit=$(exit_code "$W" long)"

run_cmd "$W" compact "$FACTORY compact $LONG --instructions \"the long probe message\" --api $API_URL" 900 || true
pane "$W" > "$EVIDENCE_DIR/session-compact.txt"
check "factory compact exits 0 and prints the summary it wrote" \
  "$([ "$(exit_code "$W" compact)" = "0" ] && grep -q '^\[compaction\] .' "$EVIDENCE_DIR/session-compact.txt" && echo 0 || echo 1)" \
  "$(grep -m1 '^\[compaction\]' "$EVIDENCE_DIR/session-compact.txt" | cut -c1-60)"
check "and the summary is a compaction entry in the transcript" \
  "$(rpc_entries "$LONG" | grep -q ' compaction$' && echo 0 || echo 1)" \
  "entries=$(rpc_entries "$LONG" | awk '{ print $2 }' | tr '\n' ' ')"

run_cmd "$W" compactshort "$FACTORY compact $CHILD --api $API_URL" 900 || true
pane "$W" > "$EVIDENCE_DIR/session-compact-short.txt"
check "a session too short to cut prints 'nothing to compact' and exits 0" \
  "$([ "$(exit_code "$W" compactshort)" = "0" ] && grep -qx 'nothing to compact' "$EVIDENCE_DIR/session-compact-short.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" compactshort)"
check "and it wrote no compaction entry" \
  "$(rpc_entries "$CHILD" | grep -q ' compaction$' && echo 1 || echo 0)" \
  "entries=$(rpc_entries "$CHILD" | awk '{ print $2 }' | tr '\n' ' ')"

run_cmd "$W" compactunknown "$FACTORY compact $UNKNOWN --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-compact-unknown.txt"
check "compacting an unknown id is error: not_found, non-zero" \
  "$([ "$(exit_code "$W" compactunknown)" != "0" ] && grep -q '^error: not_found' "$EVIDENCE_DIR/session-compact-unknown.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" compactunknown)"

# --- spend -----------------------------------------------------------------------------------------
# The numbers are the server's, so each is read back from somewhere else: `factory ls` for the session
# counts and costs, and the table's own rows for its total.
run_cmd "$W" lsall "$FACTORY ls --limit 500 --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-ls.txt"
run_cmd "$W" spend "$FACTORY spend --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-spend.txt"
TOTAL_LINE="$(grep '^total  ' "$EVIDENCE_DIR/session-spend.txt")"
TOTAL_SESSIONS="$(echo "$TOTAL_LINE" | awk '{ print $2 }')"
check "factory spend prints the header, the rows and a total" \
  "$([ "$(exit_code "$W" spend)" = "0" ] && grep -qx 'repo  actor  sessions  cost' "$EVIDENCE_DIR/session-spend.txt" && [ -n "$TOTAL_LINE" ] && echo 0 || echo 1)" \
  "$TOTAL_LINE"
check "the cost is a real number, not zero (FAUX_COST)" \
  "$(echo "$TOTAL_LINE" | grep -q '\$0.0000$' && echo 1 || echo 0)" "$TOTAL_LINE"
# The database outlives a run (and a page of `ls` is at most 100 sessions), so the rows are checked
# against their own total here and against `ls` only for the repo this run made.
TOTAL_COST="$(echo "$TOTAL_LINE" | awk '{ print $NF }' | tr -d '$')"
# Each row's cost is rounded to four places and so is the total, so the sum may differ by a rounding
# step per row; anything more is a total that disagrees with its rows.
ROW_SUMS="$(awk -v total="$TOTAL_COST" '
  /^total/ { exit }
  /^[^ ]+  [^ ]+  [0-9]+  \$/ { sessions += $3; cost += substr($4, 2); rows += 1 }
  END {
    diff = cost - total; if (diff < 0) diff = -diff
    printf "%d %.4f %d\n", sessions, cost, (diff <= rows * 0.0001 + 0.00005) ? 1 : 0
  }' "$EVIDENCE_DIR/session-spend.txt")"
check "the rows add up to the total, sessions and cost" \
  "$([ "${ROW_SUMS%% *}" = "$TOTAL_SESSIONS" ] && [ "${ROW_SUMS##* }" = "1" ] && echo 0 || echo 1)" \
  "rows sum to ${ROW_SUMS% *} against $TOTAL_SESSIONS sessions \$$TOTAL_COST"

run_cmd "$W" spendrepo "$FACTORY spend --repo $REPO --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-spend-repo.txt"
REPO_SESSIONS="$(awk -v repo="$REPO" '/^ses_/ && $3 == repo { n += 1 } END { print n + 0 }' "$EVIDENCE_DIR/session-ls.txt")"
REPO_COST="$(awk -v repo="$REPO" '/^ses_/ && $3 == repo { sum += $5 } END { printf "%.4f", sum }' "$EVIDENCE_DIR/session-ls.txt")"
check "--repo narrows to that repo, and its total is the sessions and cost factory ls lists for it" \
  "$([ "$REPO_SESSIONS" -ge 3 ] && grep -qx "total  $REPO_SESSIONS sessions  \$$REPO_COST" "$EVIDENCE_DIR/session-spend-repo.txt" && ! grep '^[^ ]*  [^ ]*  [0-9]' "$EVIDENCE_DIR/session-spend-repo.txt" | grep -qv "^$REPO  " && echo 0 || echo 1)" \
  "ls says $REPO_SESSIONS sessions \$$REPO_COST: $(grep '^total' "$EVIDENCE_DIR/session-spend-repo.txt")"

run_cmd "$W" spendactor "$FACTORY spend --actor $ACTOR --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-spend-actor.txt"
check "--actor narrows to that actor's rows" \
  "$([ "$(grep -c "^[^ ]*  $ACTOR  [0-9]" "$EVIDENCE_DIR/session-spend-actor.txt")" -ge 2 ] && ! grep '^[^ ]*  [^ ]*  [0-9]' "$EVIDENCE_DIR/session-spend-actor.txt" | grep -qv "^[^ ]*  $ACTOR  " && echo 0 || echo 1)" \
  "$(grep -c "  $ACTOR  " "$EVIDENCE_DIR/session-spend-actor.txt") rows"

run_cmd "$W" spendboth "$FACTORY spend --repo $REPO --actor $ACTOR --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-spend-both.txt"
check "both filters keep only the pair that matches both" \
  "$([ "$(grep -c "^$REPO  $ACTOR  " "$EVIDENCE_DIR/session-spend-both.txt")" = "1" ] && [ "$(grep -c '^[^ ]*  [^ ]*  [0-9]' "$EVIDENCE_DIR/session-spend-both.txt")" = "1" ] && echo 0 || echo 1)" \
  "$(grep '^total' "$EVIDENCE_DIR/session-spend-both.txt")"

run_cmd "$W" spendnone "$FACTORY spend --repo nobody/nothing --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-spend-none.txt"
check "a repo with no sessions prints a zero total" \
  "$([ "$(exit_code "$W" spendnone)" = "0" ] && grep -qx 'total  0 sessions  \$0.0000' "$EVIDENCE_DIR/session-spend-none.txt" && echo 0 || echo 1)" \
  "$(grep '^total' "$EVIDENCE_DIR/session-spend-none.txt")"

run_cmd "$W" spendbad "$FACTORY spend --repo not-a-slug --api $API_URL" || true
pane "$W" > "$EVIDENCE_DIR/session-spend-bad.txt"
check "a malformed --repo is refused with a non-zero exit" \
  "$([ "$(exit_code "$W" spendbad)" != "0" ] && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" spendbad)"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "parent": "%s",\n' "$PARENT"
  printf '  "child": "%s",\n' "$CHILD"
  printf '  "compacted": "%s",\n' "$LONG"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/session.json"
cp "$LOG" "$EVIDENCE_DIR/session-api.log"

if [ "$failed" -eq 0 ]; then
  echo "session: all checks passed"
else
  echo "session: some checks failed — see $EVIDENCE_DIR" >&2
fi
exit "$failed"
