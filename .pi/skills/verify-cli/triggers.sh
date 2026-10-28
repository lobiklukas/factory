#!/usr/bin/env bash
# Drive `factory triggers ls` in a real tmux terminal (T4): deliver generic webhooks the API's seam
# processes, skips for an unmapped label and for an unregistered repo, and one with a wrong
# signature, then read them back — newest first, each with its source, outcome and the seam's reason
# verbatim; a processed delivery names its session; `--status skipped` and `--source` filter; a page
# cursor continues the walk; and a word that is not a status or source is refused before any request.
#
# The script owns its own API instance (its own port, session root, log, pid file and tmux server)
# because the deliveries need a signing secret and a label → repo rule, both deployment settings, and
# does not touch the one ./up.sh started. Nothing leaves loopback: the webhooks are posted by `curl`,
# signed with the secret this script booted the API with.
#
#   ./triggers.sh                  # API on :9395 (TRIGGERS_PORT)
#
# Evidence: .verify/evidence/latest/cli/triggers-*.txt (the raw panes) and triggers.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${TRIGGERS_PORT:-9395}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-triggers"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LOG="$RUN_DIR/api.log"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-triggers"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
SECRET="verify-cli-triggers-secret"
RUN_ID="$(date +%s)$$"
REPO="acme/triggers-$RUN_ID"
GHOST="acme/triggers-ghost-$RUN_ID"
SESSION_ROOT="$RUN_DIR/sessions"
CHECKOUT="$RUN_DIR/checkout"
# A port nothing listens on: a command that sent a request there would fail as `error: error:`.
DEAD_API="http://127.0.0.1:9"
RULES="[{\"label\":\"t4-ok\",\"repo\":\"$REPO\",\"baseRef\":\"main\",\"prompt\":\"{{title}}\"},{\"label\":\"t4-ghost\",\"repo\":\"$GHOST\",\"prompt\":\"{{title}}\"}]"

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
      TRIGGER_SECRET="$SECRET" \
      TRIGGER_RULES="$RULES" \
      SESSION_ROOT="$SESSION_ROOT" \
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

cleanup() {
  if [ -f "$RUN_DIR/api.pid" ]; then
    local pid; pid="$(cat "$RUN_DIR/api.pid")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$RUN_DIR/api.pid"
  fi
  tmux -S "$SOCK" kill-server 2>/dev/null || true
}
trap cleanup EXIT

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — set TRIGGERS_PORT to a free one" >&2
  exit 1
fi

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# The rule's repo needs a checkout to register against: a throwaway git repo, never a real remote.
rm -rf "$RUN_DIR/sessions" "$CHECKOUT"
mkdir -p "$SESSION_ROOT" "$CHECKOUT"
git init -q -b main "$CHECKOUT"
git -C "$CHECKOUT" config user.email verify-triggers@localhost
git -C "$CHECKOUT" config user.name verify-triggers
git -C "$CHECKOUT" commit -q --allow-empty -m seed

: > "$LOG"
start_api
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

t() { tmux -S "$SOCK" "$@"; }
pane() { t capture-pane -p -J -t "$TERM_SESSION" -S -4000 | sed -e 's/[[:space:]]*$//'; }

# Type a command, wait for its sentinel, and leave the output in the pane (drive.sh's pattern: the
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

drive() { # marker, file, command
  run_cmd "$1" "$3" || true
  pane > "$EVIDENCE_DIR/$2"
}

failed_with() { # marker, file, code
  [ "$(exit_code "$1")" != "0" ] && [ -n "$(exit_code "$1")" ] &&
    grep -q "^error: $3: " "$EVIDENCE_DIR/$2"
}

# POST one generic webhook, signed as the API's secret signs it (hex HMAC-SHA256 of the raw body).
deliver() { # request id, label, title -> the answer's JSON
  local body sig
  body="{\"requestId\":\"$1\",\"label\":\"$2\",\"title\":\"$3\",\"body\":\"from the drive\"}"
  sig="$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"
  curl -s -m 20 -X POST "$API_URL/webhooks/generic" \
    -H 'content-type: application/json' -H "x-trigger-signature: $sig" --data "$body"
}

# --- the fixture: a registered repo, then the deliveries the CLI will read ------------------------
$FACTORY repo add "$REPO" --path "$CHECKOUT" --base-ref main --api "$API_URL" > "$EVIDENCE_DIR/triggers-setup.txt" 2>&1
OK_ID="t4-$RUN_ID-ok"
NORULE_ID="t4-$RUN_ID-norule"
GHOST_ID="t4-$RUN_ID-ghost"
FORGED_ID="t4-$RUN_ID-forged"
OK_ANSWER="$(deliver "$OK_ID" t4-ok "Fix the wobble $RUN_ID")"
sleep 0.05
NORULE_ANSWER="$(deliver "$NORULE_ID" t4-nothing "Unmapped $RUN_ID")"
sleep 0.05
GHOST_ANSWER="$(deliver "$GHOST_ID" t4-ghost "Ghost $RUN_ID")"
# A delivery with a wrong signature: refused before the seam, so recorded nowhere.
FORGED_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -m 20 -X POST "$API_URL/webhooks/generic" \
  -H 'content-type: application/json' -H "x-trigger-signature: $(printf '0%.0s' $(seq 1 64))" \
  --data "{\"requestId\":\"$FORGED_ID\",\"label\":\"t4-ok\",\"title\":\"forged\"}")"
SESSION_ID="$(printf '%s' "$OK_ANSWER" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')"
check "the drive's deliveries: one processed with a session, two skipped, one forged refused" \
  "$(printf '%s' "$OK_ANSWER" | grep -q '"status":"processed"' && [ -n "$SESSION_ID" ] &&
    printf '%s' "$NORULE_ANSWER" | grep -q '"status":"skipped"' &&
    printf '%s' "$GHOST_ANSWER" | grep -q '"status":"skipped"' && [ "$FORGED_STATUS" = "401" ] && echo 0 || echo 1)" \
  "session=$SESSION_ID forged=$FORGED_STATUS"

t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -x 240 -y 60 -c "$ROOT"

# What a script reads, with the tab itself as the separator.
piped() { $FACTORY triggers ls --api "$API_URL" "$@" 2>/dev/null; }
col() { awk -F'\t' -v id="$1" -v n="$2" '$4 == id { print $n; exit }'; }

# --- ls: the terminal's own view, then the columns a script reads ---------------------------------
drive ls triggers-ls.txt "$FACTORY triggers ls --limit 10 --api $API_URL"
check "triggers ls exits 0 with its header" \
  "$([ "$(exit_code ls)" = "0" ] &&
    grep -qE '^received-at[[:space:]]+source[[:space:]]+status[[:space:]]+delivery[[:space:]]+session[[:space:]]+card[[:space:]]+reason$' \
      "$EVIDENCE_DIR/triggers-ls.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code ls)"
piped --limit 50 > "$EVIDENCE_DIR/triggers-ls-piped.txt"
check "the processed delivery is a generic row naming its session" \
  "$([ "$(col "$OK_ID" 2 < "$EVIDENCE_DIR/triggers-ls-piped.txt")" = "generic" ] &&
    [ "$(col "$OK_ID" 3 < "$EVIDENCE_DIR/triggers-ls-piped.txt")" = "processed" ] &&
    [ "$(col "$OK_ID" 5 < "$EVIDENCE_DIR/triggers-ls-piped.txt")" = "$SESSION_ID" ] &&
    [ "$(col "$OK_ID" 6 < "$EVIDENCE_DIR/triggers-ls-piped.txt")" = "none" ] && echo 0 || echo 1)" \
  "session=$(col "$OK_ID" 5 < "$EVIDENCE_DIR/triggers-ls-piped.txt")"
check "its reason names the rule and the repo, verbatim" \
  "$([ "$(col "$OK_ID" 7 < "$EVIDENCE_DIR/triggers-ls-piped.txt")" = "rule \"t4-ok\" (env:TRIGGER_RULES[0]) mapped it to $REPO" ] && echo 0 || echo 1)" \
  "$(col "$OK_ID" 7 < "$EVIDENCE_DIR/triggers-ls-piped.txt")"
check "the unmapped label's skip carries the seam's exact reason and no session" \
  "$([ "$(col "$NORULE_ID" 3 < "$EVIDENCE_DIR/triggers-ls-piped.txt")" = "skipped" ] &&
    [ "$(col "$NORULE_ID" 7 < "$EVIDENCE_DIR/triggers-ls-piped.txt")" = "no rule matches labels [t4-nothing]" ] &&
    [ "$(col "$NORULE_ID" 5 < "$EVIDENCE_DIR/triggers-ls-piped.txt")" = "none" ] && echo 0 || echo 1)" \
  "$(col "$NORULE_ID" 7 < "$EVIDENCE_DIR/triggers-ls-piped.txt")"
check "the unregistered repo's skip carries the seam's exact reason" \
  "$([ "$(col "$GHOST_ID" 7 < "$EVIDENCE_DIR/triggers-ls-piped.txt")" = "repo $GHOST is not registered" ] && echo 0 || echo 1)" \
  "$(col "$GHOST_ID" 7 < "$EVIDENCE_DIR/triggers-ls-piped.txt")"
check "the refused delivery (wrong signature) is not recorded" \
  "$(grep -qF "$FORGED_ID" "$EVIDENCE_DIR/triggers-ls-piped.txt" && echo 1 || echo 0)" \
  "absent from the list"
check "newest first: the ghost skip, then the unmapped one, then the processed one" \
  "$(awk -F'\t' -v a="$GHOST_ID" -v b="$NORULE_ID" -v c="$OK_ID" '$4 == a { ia = NR } $4 == b { ib = NR } $4 == c { ic = NR } END { exit !(ia && ib && ic && ia < ib && ib < ic) }' \
    "$EVIDENCE_DIR/triggers-ls-piped.txt" && echo 0 || echo 1)" \
  "order by line"

# --- filters --------------------------------------------------------------------------------------
drive skipped triggers-ls-skipped.txt "$FACTORY triggers ls --status skipped --api $API_URL"
check "triggers ls --status skipped lists the skips and not the processed delivery" \
  "$([ "$(exit_code skipped)" = "0" ] && grep -qF "$NORULE_ID" "$EVIDENCE_DIR/triggers-ls-skipped.txt" &&
    grep -qF "$GHOST_ID" "$EVIDENCE_DIR/triggers-ls-skipped.txt" &&
    ! grep -qF "$OK_ID" "$EVIDENCE_DIR/triggers-ls-skipped.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code skipped)"
piped --status skipped --limit 200 > "$EVIDENCE_DIR/triggers-ls-skipped-piped.txt"
check "every row it printed is skipped" \
  "$(awk -F'\t' 'NR > 1 && $3 != "skipped" { bad = 1 } END { exit bad }' "$EVIDENCE_DIR/triggers-ls-skipped-piped.txt" && echo 0 || echo 1)" \
  "status column"
piped --status processed --source generic --limit 200 > "$EVIDENCE_DIR/triggers-ls-processed-generic.txt"
check "--status processed --source generic keeps the processed delivery and drops the skips" \
  "$(grep -qF "$OK_ID" "$EVIDENCE_DIR/triggers-ls-processed-generic.txt" &&
    ! grep -qF "$NORULE_ID" "$EVIDENCE_DIR/triggers-ls-processed-generic.txt" &&
    awk -F'\t' 'NR > 1 && ($2 != "generic" || $3 != "processed") { bad = 1 } END { exit bad }' "$EVIDENCE_DIR/triggers-ls-processed-generic.txt" && echo 0 || echo 1)" \
  "source and status columns"
piped --source linear --limit 200 > "$EVIDENCE_DIR/triggers-ls-linear.txt"
check "--source linear drops this run's generic deliveries" \
  "$(grep -qF "$OK_ID" "$EVIDENCE_DIR/triggers-ls-linear.txt" && echo 1 || echo 0)" \
  "absent"
drive deliveries triggers-deliveries.txt "$FACTORY triggers deliveries --status skipped --api $API_URL"
check "triggers deliveries is the same command" \
  "$([ "$(exit_code deliveries)" = "0" ] && grep -qF "$GHOST_ID" "$EVIDENCE_DIR/triggers-deliveries.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code deliveries)"

# --- paging ---------------------------------------------------------------------------------------
$FACTORY triggers ls --limit 1 --api "$API_URL" > "$EVIDENCE_DIR/triggers-page1.txt" 2> "$EVIDENCE_DIR/triggers-page1.err"
CURSOR="$(sed -n 's/^cursor: //p' "$EVIDENCE_DIR/triggers-page1.err")"
$FACTORY triggers ls --limit 1 --cursor "$CURSOR" --api "$API_URL" > "$EVIDENCE_DIR/triggers-page2.txt" 2>/dev/null
check "--limit 1 prints one row and a cursor on stderr; --cursor continues with the next row" \
  "$([ -n "$CURSOR" ] && [ "$(wc -l < "$EVIDENCE_DIR/triggers-page1.txt" | tr -d ' ')" = "2" ] &&
    [ "$(sed -n 2p "$EVIDENCE_DIR/triggers-page1.txt" | cut -f4)" = "$GHOST_ID" ] &&
    [ "$(sed -n 2p "$EVIDENCE_DIR/triggers-page2.txt" | cut -f4)" = "$NORULE_ID" ] && echo 0 || echo 1)" \
  "cursor=$CURSOR"

# --- refusals -------------------------------------------------------------------------------------
drive badstatus triggers-bad-status.txt "$FACTORY triggers ls --status nope --api $DEAD_API"
check "a status that is not one is invalid_input before any request" \
  "$(failed_with badstatus triggers-bad-status.txt invalid_input &&
    grep -qF 'is not one of received, skipped, processed' "$EVIDENCE_DIR/triggers-bad-status.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code badstatus), --api $DEAD_API never asked"
drive badsource triggers-bad-source.txt "$FACTORY triggers ls --source fax --api $DEAD_API"
check "a source that is not one is invalid_input before any request" \
  "$(failed_with badsource triggers-bad-source.txt invalid_input && echo 0 || echo 1)" \
  "exit=$(exit_code badsource)"
drive badcursor triggers-bad-cursor.txt "$FACTORY triggers ls --cursor nope --api $API_URL"
check "a cursor the server did not mint is invalid_input, non-zero" \
  "$(failed_with badcursor triggers-bad-cursor.txt invalid_input && echo 0 || echo 1)" \
  "exit=$(exit_code badcursor)"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "repo": "%s",\n' "$REPO"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/triggers.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "triggers: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "triggers: FAILURES — see $EVIDENCE_DIR/triggers.json" >&2
fi
exit "$failed"
