#!/usr/bin/env bash
# Walk docs/getting-started.md for real (G1): every command the guide shows in a `sh walk` block is
# run, in order, in one shell against the instance from ./up.sh, and the walk must end where the
# guide says it does: a card in `review` with a pull request recorded against the GitHub fake.
#
# The blocks are cut out of the guide itself, not copied into this script, so the guide cannot say
# one thing while a drive proves another: edit a command in the guide and the walk runs the edit.
# Two fences mark what runs:
#
#   ```sh walk        a hard step: the first command that fails ends the walk
#   ```sh walk-soft   a step whose exit status is evidence, not a verdict (`factory doctor` exits 1
#                     on any `fail` line, and a database an earlier drive used holds repositories
#                     that fail by design)
#
# Other blocks (the real-repository variants, the runbook's `.env` lines, the rehearsal's own
# start-up) are shown, not run; `apps/cli/src/guide.test.ts` checks every `factory` line of them
# against the CLI's own `--help`. The walk proves, in order:
#
#   1. extract    the guide has walk blocks (and a count the check below compares with)
#   2. walk       every block exits 0 (soft ones are recorded), the repository, board, card and the
#                 three kinds of run (specify with its question and answer, plan, build) all happen
#   3. card       `factory board show` prints the card in `review`, its spec and its plan
#   4. PR         `factory board runs` lists the build run's `/pull/` link, and the fake's ledger
#                 holds exactly one pull request for acme/demo with the card's title
#   5. doctor     the soft `factory doctor` printed its `ok api` line, so the guide's check step ran
#
# Requires the instance from ./up.sh (API on API_PORT, default 9400, and its GitHub fake) and
# DATABASE_URL naming its database. A repository has one board, so the walk registers the guide's
# `acme/demo` under a slug of its own (`GUIDE_REPO`, default `acme/demo-<random>`, substituted into
# the blocks as text) and a second run on the same database makes a second board. Exits non-zero on a
# failure.
set -uo pipefail

unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH API_URL

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
API_URL="http://localhost:$API_PORT"
RUN_DIR="$ROOT/.verify/run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
GUIDE="${GUIDE:-$ROOT/docs/getting-started.md}"
WALK="$EVIDENCE_DIR/guide-walk.sh"
LOG="$EVIDENCE_DIR/guide-walk.txt"
LEDGER="$RUN_DIR/github-ledger.json"
SLUG="${GUIDE_REPO:-acme/demo-$RANDOM$RANDOM}"

mkdir -p "$EVIDENCE_DIR" "$RUN_DIR"
rm -f "$EVIDENCE_DIR"/guide-*

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi
if [ ! -f "$LEDGER" ]; then
  echo "no GitHub fake ledger at $LEDGER — ./up.sh must run with BOARD_GITHUB=fake (the default)" >&2
  exit 1
fi

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  local detail="${3//\\/\\\\}"
  detail="${detail//\"/\\\"}"
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$detail\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-66s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-66s %s\n' "$1" "$3"
  fi
}
yes_if() { if "$@" >/dev/null 2>&1; then echo 0; else echo 1; fi; }

# --- 1. extract: the guide's walk blocks, in order, as one script -------------------------------------
awk '
  /^```sh walk(-soft)?[[:space:]]*$/ { inblock = 1; soft = ($0 ~ /walk-soft/); n++;
    printf "\n# ---- walk block %d%s\n", n, (soft ? " (soft)" : "");
    printf "echo \"== walk block %d%s\"\n", n, (soft ? " (soft)" : "");
    if (soft) print "{"; next }
  /^```/ && inblock { if (soft) print "} || echo \"(soft: exit $?)\""; inblock = 0; next }
  inblock { print }
' "$GUIDE" > "$WALK.body"
BLOCKS="$(grep -c '^# ---- walk block' "$WALK.body" || true)"
{
  echo 'set -eo pipefail'
  sed "s#acme/demo#$SLUG#g" "$WALK.body"
  # What the checks below read back, printed by the walk itself, after the guide's last command.
  echo 'echo "== walk end"'
  echo 'echo "GUIDE_BOARD=$BOARD"'
  echo 'echo "GUIDE_TASK=$TASK"'
} > "$WALK"
rm -f "$WALK.body"
check "the guide has walk blocks" "$(yes_if [ "${BLOCKS:-0}" -ge 10 ])" "blocks=${BLOCKS:-0} from $GUIDE"

# --- 2. walk: run them against the instance ---------------------------------------------------------
( cd "$ROOT" && FACTORY_API_URL="$API_URL" bash "$WALK" ) > "$LOG" 2>&1
walk_rc=$?
check "the guide's commands run to the end, in order" "$(yes_if [ "$walk_rc" = "0" ] && grep -q '^== walk end$' "$LOG")" \
  "exit=$walk_rc, $(grep -c '^== walk block' "$LOG") of ${BLOCKS:-0} blocks started"
if [ "$walk_rc" != "0" ]; then
  echo "--- last lines of $LOG ---" >&2
  tail -15 "$LOG" >&2
fi
BOARD="$(sed -n 's/^GUIDE_BOARD=//p' "$LOG" | tail -1)"
TASK="$(sed -n 's/^GUIDE_TASK=//p' "$LOG" | tail -1)"
check "it made a board and a card" "$(yes_if bash -c "[ -n '$BOARD' ] && [ -n '$TASK' ]")" "board=${BOARD:-none} task=${TASK:-none}"

# --- 3. card: where the guide says it ends -----------------------------------------------------------
factory() { ( cd "$ROOT" && FACTORY_API_URL="$API_URL" bun run apps/cli/src/index.ts "$@" 2>&1 ); }
SHOWN="$(factory board show --task "${TASK:-tsk_missing}")"
printf '%s\n' "$SHOWN" > "$EVIDENCE_DIR/guide-show.txt"
shown_has() { local p; for p in "$@"; do grep -qE "$p" <<<"$SHOWN" || return 1; done; }
check "the card is in review" "$(yes_if shown_has '^column +review$')" \
  "$(printf '%s' "$SHOWN" | grep -E '^(column|revision) ' | tr -s ' ' | paste -sd' ' -)"
check "with the spec the specifier wrote after its question was answered" \
  "$(yes_if shown_has '^spec ' 'gaps: none')" \
  "$(printf '%s' "$SHOWN" | grep -m1 '^spec ' | cut -c1-90)"
check "and the plan the planner declared" \
  "$(yes_if shown_has '^plan ' 'summary: ')" \
  "$(printf '%s' "$SHOWN" | grep -m1 'summary: ')"

# --- 4. PR: the link, and the fake's ledger ------------------------------------------------------------
RUNS="$(factory board runs --task "${TASK:-tsk_missing}")"
printf '%s\n' "$RUNS" > "$EVIDENCE_DIR/guide-runs.txt"
PR_URL="$(printf '%s\n' "$RUNS" | grep -o 'https://[^ ]*/pull/[0-9]*' | head -1)"
check "the build run lists its pull request" "$(yes_if [ -n "$PR_URL" ])" "pr=${PR_URL:-none}"
OPENED="$(bun -e '
  const ledger = JSON.parse(await Bun.file(process.argv[1]).text());
  const prs = ledger.requests.filter((r) => r.method === "POST" && r.path === "/repos/" + process.argv[2] + "/pulls");
  console.log(JSON.stringify({ count: prs.length, title: prs[0]?.body?.title ?? "", base: prs[0]?.body?.base ?? "" }));
' "$LEDGER" "$SLUG")"
echo "$OPENED" > "$EVIDENCE_DIR/guide-ledger.json"
check "the GitHub fake was asked for exactly one pull request, for the card" \
  "$(yes_if bash -c "[ '$OPENED' = '{\"count\":1,\"title\":\"Pin the Postgres major\",\"base\":\"main\"}' ]")" "$OPENED"

# --- 5. doctor: the check step ran --------------------------------------------------------------------
check "the check step's \`factory doctor\` reached the API" "$(yes_if grep -q '^ok api: ' "$LOG")" \
  "$(grep -m1 '^ok api: ' "$LOG")"
check "and the repository's own check is clean" "$(yes_if grep -qE "^ok (repo|base-ref|forge) $SLUG" "$LOG")" \
  "$(grep -cE "^(ok|warn|fail) .* $SLUG" "$LOG") lines about $SLUG"

{
  printf '{\n  "apiUrl": "%s",\n  "guide": "%s",\n  "blocks": %s,\n  "checks": {\n' "$API_URL" "$GUIDE" "${BLOCKS:-0}"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/guide.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "guide: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "guide: FAILURES — see $EVIDENCE_DIR/guide.json and $LOG" >&2
fi
exit "$failed"
