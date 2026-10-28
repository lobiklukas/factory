#!/usr/bin/env bash
# The both-ways phase's new-card leg (LOB-275, as LOB-87 is for moves): a card made with the board
# page's **New card** form is the card `factory board ls` and `factory board show` list, and a card
# made at the terminal with the same inputs is the one the open page shows next — the same title,
# body, repo, priority and base ref to the server.
#
# Two halves, as in the both-ways phase: `card-create.mjs` holds one browser page open on the board
# (never reloaded) and makes the browser's card, with its inline and server refusals on the way; this
# script is the terminal, a plain subprocess whose stdout is read back as triage.sh's is. They take
# turns through signal files in .verify/run/card-create/ (see card-create.mjs).
#
# The terminal's card is made with `factory board add` (LOB-261), the same inputs as the form.
#
# Requires the instance from ./up.sh (API on API_PORT, default 9400; web on WEB_PORT, read from
# .verify/run/web-port; a seeded board in .verify/run/board.json). drive.sh runs it in its both-ways
# phase; it also runs on its own against an instance that is up:
#
#   ./up.sh && ./card-create.sh && ./down.sh
#
# Evidence: .verify/evidence/latest/board/card-create.json (this half's checks),
# card-create-web.json and card-create-*.png (the page's), card-create-*.txt (what the terminal printed).
set -uo pipefail

# This suite runs its API with auth off (LOB-20): its clients send no credential, and it declares
# actors (a run's session id) that only an open control plane keeps. A token exported for the
# rest of the verify skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run"
WEB_PORT="${WEB_PORT:-$(cat "$RUN_DIR/web-port" 2>/dev/null || echo 3400)}"
WEB_URL="${WEB_URL:-http://localhost:$WEB_PORT}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
SKILL="$ROOT/.pi/skills/verify-board"
SIGNAL_DIR="$RUN_DIR/card-create"

mkdir -p "$EVIDENCE_DIR"
rm -rf "$SIGNAL_DIR"
mkdir -p "$SIGNAL_DIR"
rm -f "$EVIDENCE_DIR"/card-create-*.txt "$EVIDENCE_DIR"/card-create-*.png \
  "$EVIDENCE_DIR/card-create.json" "$EVIDENCE_DIR/card-create-web.json"

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi
if ! curl -sf -m 2 "$WEB_URL/" >/dev/null 2>&1; then
  echo "no dashboard at $WEB_URL — run ./up.sh first" >&2
  exit 1
fi
if [ ! -s "$RUN_DIR/board.json" ]; then
  echo "no seeded board in $RUN_DIR/board.json — run ./up.sh first" >&2
  exit 1
fi
BOARD_ID="$(sed -n 's/.*"boardId":"\([^"]*\)".*/\1/p' "$RUN_DIR/board.json")"
BOARD_REPO_SLUG="$(sed -n 's/.*"repo":"\([^"]*\)".*/\1/p' "$RUN_DIR/board.json")"

# The inputs both halves type. The title is this run's own, so the checks find these cards by id and
# title on a board other drives share; the body is markdown over several lines with an em dash, so a
# door that trimmed, wrapped or re-encoded it would be caught. The bad ref holds `..`, which
# `isSafeBranchName` refuses: the refusal is the server's, never a rule the form copies.
TAG="$(date +%s)-$$"
CARD_TITLE="Pin the Postgres major (card-create $TAG)"
CARD_BODY="$(printf '## Goal\n\nCompose names one Postgres major.\n\n- keep port 5442 \xe2\x80\x94 it is shared\n- leave the seed alone')"
CARD_BASE_REF="main"
CARD_BAD_REF="main..release"

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
    printf 'PASS  %-62s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-62s %s\n' "$1" "$3"
  fi
}

rc=0
run() { # evidence name, args...
  local out="$EVIDENCE_DIR/card-create-$1.txt"
  shift
  printf '$ factory %s\n' "$*" > "$out"
  "${FACTORY[@]}" "$@" >> "$out" 2>&1
  rc=$?
}
has() { grep -qxF -- "$2" "$EVIDENCE_DIR/card-create-$1.txt"; }
lane_of() { # task id, ls capture: the lane line a card line sits under, as drive.sh reads it
  awk -v id="$1" '
    /^[a-z]+  (resting|working|terminal)  [0-9]+$/ { lane = $1; next }
    /^  / && lane != "" && index($0, id) > 0 { print lane; exit }
  ' "$2"
}
# `board show`'s body block for CARD_BODY: the line count, then each line indented four spaces.
body_shown() { # evidence name
  local lines
  lines="$(printf '%s\n' "$CARD_BODY" | wc -l | tr -d ' ')"
  has "$1" "body      $lines lines" || return 1
  while IFS= read -r line; do
    has "$1" "    $line" || return 1
  done <<< "$CARD_BODY"
}

PAGE_SIGNAL_TIMEOUT=120
await_page() { # name: the page's signal; empty once the page is gone or late
  local name="$1"
  for _ in $(seq 1 $((PAGE_SIGNAL_TIMEOUT * 10))); do
    if [ -s "$SIGNAL_DIR/$name" ]; then
      cat "$SIGNAL_DIR/$name"
      return 0
    fi
    if ! kill -0 "$PAGE_PID" 2>/dev/null; then
      [ -s "$SIGNAL_DIR/$name" ] && cat "$SIGNAL_DIR/$name"
      return 1
    fi
    sleep 0.1
  done
  return 1
}
page_signal() { # name, body: written beside, then renamed, so the page never reads half of it
  printf '%s\n' "$2" > "$SIGNAL_DIR/$1.tmp" && mv "$SIGNAL_DIR/$1.tmp" "$SIGNAL_DIR/$1"
}

WEB_URL="$WEB_URL" API_URL="$API_URL" BOARD_ID="$BOARD_ID" \
  CARD_TITLE="$CARD_TITLE" CARD_BODY="$CARD_BODY" CARD_BASE_REF="$CARD_BASE_REF" \
  CARD_BAD_REF="$CARD_BAD_REF" SIGNAL_DIR="$SIGNAL_DIR" EVIDENCE_DIR="$EVIDENCE_DIR" \
  SIGNAL_TIMEOUT_MS=$((PAGE_SIGNAL_TIMEOUT * 1000)) \
  node "$SKILL/card-create.mjs" > "$RUN_DIR/card-create-web.log" 2>&1 &
PAGE_PID=$!
trap 'kill "$PAGE_PID" 2>/dev/null || true' EXIT

# --- browser → terminal: the page's card, as `board ls` and `board show` print it ----------------
BROWSER_TASK="$(await_page browser-created)"
[ "$BROWSER_TASK" = "none" ] && BROWSER_TASK=""
check "the page creates a card from the New card form (card-create.mjs)" \
  "$([ -n "$BROWSER_TASK" ] && echo 0 || echo 1)" \
  "task=${BROWSER_TASK:-none}, see card-create-web.json"

run ls board ls --board "$BOARD_ID" --api "$API_URL"
BROWSER_LANE="$(lane_of "${BROWSER_TASK:-tsk_none}" "$EVIDENCE_DIR/card-create-ls.txt")"
check "factory board ls lists the browser's card in intake" \
  "$([ "$rc" = "0" ] && [ -n "$BROWSER_TASK" ] && [ "$BROWSER_LANE" = "intake" ] && grep -F "$BROWSER_TASK" "$EVIDENCE_DIR/card-create-ls.txt" | grep -qF "$CARD_TITLE" && echo 0 || echo 1)" \
  "exit=$rc, lane=${BROWSER_LANE:-none}"

run show-browser board show --task "${BROWSER_TASK:-tsk_none}" --api "$API_URL"
check "factory board show prints the browser's card as the form filed it" \
  "$([ "$rc" = "0" ] && has show-browser "column    intake" && has show-browser "revision  1" \
      && has show-browser "priority  urgent" && has show-browser "repo      $BOARD_REPO_SLUG" \
      && has show-browser "title     $CARD_TITLE" && has show-browser "base      $CARD_BASE_REF" \
      && body_shown show-browser && echo 0 || echo 1)" \
  "exit=$rc, see card-create-show-browser.txt"

# --- terminal → browser: the twin, with the same inputs ----------------------------------------------
CLI_TASK=""
run add board add --board "$BOARD_ID" --title "$CARD_TITLE" --body "$CARD_BODY" \
  --priority urgent --base-ref "$CARD_BASE_REF" --api "$API_URL"
CLI_TASK="$(grep -o 'tsk_[0-9a-z]\{26\}' "$EVIDENCE_DIR/card-create-add.txt" | head -1)"
check "factory board add creates the twin in intake at revision 1" \
  "$([ "$rc" = "0" ] && [ -n "$CLI_TASK" ] && has add "task $CLI_TASK revision 1 column intake" && echo 0 || echo 1)" \
  "exit=$rc, task=${CLI_TASK:-none}"

run show-cli board show --task "${CLI_TASK:-tsk_none}" --api "$API_URL"
check "factory board show prints the twin as it prints the browser's card" \
  "$([ "$rc" = "0" ] && diff <(grep -vE '^(\$ factory|id  )' "$EVIDENCE_DIR/card-create-show-browser.txt") \
      <(grep -vE '^(\$ factory|id  )' "$EVIDENCE_DIR/card-create-show-cli.txt") >/dev/null && echo 0 || echo 1)" \
  "exit=$rc, card-create-show-browser.txt vs card-create-show-cli.txt, id lines aside"

page_signal cli-created "${CLI_TASK:-none}"
FOLLOWED="$(await_page browser-followed)"
check "the open page shows the terminal's card without a reload" \
  "$([ "$FOLLOWED" = "pass" ] && echo 0 || echo 1)" \
  "page: ${FOLLOWED:-no answer}, see card-create-web.json"

# --- the page's own verdicts ------------------------------------------------------------------------
PAGE_RC=1
for _ in $(seq 1 600); do
  if ! kill -0 "$PAGE_PID" 2>/dev/null; then
    wait "$PAGE_PID"
    PAGE_RC=$?
    break
  fi
  sleep 0.1
done
kill "$PAGE_PID" 2>/dev/null || true
cat "$RUN_DIR/card-create-web.log"
check "the page's checks pass: refusals, the created card, the twin, the same card (card-create.mjs)" \
  "$([ "$PAGE_RC" = "0" ] && echo 0 || echo 1)" \
  "exit=$PAGE_RC, see card-create-web.json"

{
  printf '{\n  "apiUrl": "%s",\n  "webUrl": "%s",\n  "boardId": "%s",\n  "browserTask": "%s",\n  "cliTask": "%s",\n  "checks": {\n' \
    "$API_URL" "$WEB_URL" "$BOARD_ID" "${BROWSER_TASK:-}" "${CLI_TASK:-}"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/card-create.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "card-create: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "card-create: FAILURES — see $EVIDENCE_DIR/card-create.json" >&2
fi
exit "$failed"
