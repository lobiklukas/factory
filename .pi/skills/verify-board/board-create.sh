#!/usr/bin/env bash
# Drive board creation (LOB-208): `factory board create` against a real control plane, then read the
# board it made back through `factory board ls`, put a card on it through `createTask`, start a run
# on the card in `specifying`, and read the run's prompt from its own log — the column's skill is
# there only if the run-column join found the board `createBoard` wrote. Then the refusals: an
# unknown definition, an unknown version, and a repo that is not one.
#
# The commands run as plain subprocesses, not in tmux: what is asserted here is stdout, stderr and
# the exit code, which a subprocess captures exactly; `drive.sh` already proves the terminal reading
# of lanes. Every check is required; the drive exits non-zero on any miss.
#
# Requires the instance from ./up.sh (API on API_PORT, default 9400) and DATABASE_URL naming the same
# database, for the two reads `board-create.ts` makes.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
SKILL="$ROOT/.pi/skills/verify-board"
# The default pipeline (0007_create_tasks.ts), in declaration order.
LANES="intake specifying planning building review done canceled"

mkdir -p "$EVIDENCE_DIR" "$RUN_DIR"
rm -f "$EVIDENCE_DIR"/create-board-*.txt "$EVIDENCE_DIR/create-board.json"

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

# Run one `factory` command once: the command line, then its stdout and stderr, into one evidence
# file; its exit code into `rc`.
rc=0
run() { # evidence name, args...
  local out="$EVIDENCE_DIR/create-board-$1.txt"
  shift
  printf '$ factory %s\n' "$*" > "$out"
  "${FACTORY[@]}" "$@" >> "$out" 2>&1
  rc=$?
}
has() { grep -qF -- "$2" "$EVIDENCE_DIR/create-board-$1.txt"; }
field() { sed -n "s/^$2 *//p" "$EVIDENCE_DIR/create-board-$1.txt" | head -1; }
yes_if() { "$@" && echo 0 || echo 1; }

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi

NEWEST="$(MODE=newest bun "$SKILL/board-create.ts" 2>"$RUN_DIR/board-create-newest.log")"
if [ -z "$NEWEST" ]; then
  echo "board-create: could not read the newest default version — see $RUN_DIR/board-create-newest.log" >&2
  exit 1
fi
HEX="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
REPO="verify-board/made-$HEX"

# --- create: the default definition at its newest version -----------------------------------------
run create board create --repo "$REPO" --api "$API_URL"
BOARD_ID="$(field create board)"
check "board create exits 0" "$([ "$rc" = "0" ] && echo 0 || echo 1)" "exit=$rc"
check "it prints a board id" \
  "$(yes_if grep -Eq '^board +brd_[0-9a-z]{26}$' "$EVIDENCE_DIR/create-board-create.txt")" \
  "board=${BOARD_ID:-none}"
check "it binds the repo named" "$(yes_if has create "repo        $REPO")" "repo=$REPO"
check "it pins the default definition's newest version" \
  "$(yes_if has create "definition  default v$NEWEST")" "newest in the database=v$NEWEST"

# --- create: a version named on purpose ------------------------------------------------------------
run pinned board create --repo "$REPO" --version 1 --api "$API_URL"
PINNED_ID="$(field pinned board)"
check "board create --version 1 exits 0" "$([ "$rc" = "0" ] && echo 0 || echo 1)" "exit=$rc"
check "it pins version 1, a second board over the same repo" \
  "$([ -n "$PINNED_ID" ] && [ "$PINNED_ID" != "$BOARD_ID" ] && has pinned "definition  default v1" && echo 0 || echo 1)" \
  "board=${PINNED_ID:-none}"

# --- ls: the made board reads back through getBoard ------------------------------------------------
run ls board ls --board "${BOARD_ID:-brd_missing}" --api "$API_URL"
OBSERVED_LANES="$(grep -E '^[a-z]+  (resting|working|terminal)  [0-9]+$' "$EVIDENCE_DIR/create-board-ls.txt" | awk '{print $1}' | tr '\n' ' ' | sed 's/ $//')"
check "board ls on the made board exits 0" "$([ "$rc" = "0" ] && echo 0 || echo 1)" "exit=$rc"
check "its header names the repo and the pinned version" \
  "$(yes_if grep -Eq "^.+  $REPO  v$NEWEST$" "$EVIDENCE_DIR/create-board-ls.txt")" \
  "$REPO v$NEWEST"
check "it prints every lane in definition order" \
  "$([ "$OBSERVED_LANES" = "$LANES" ] && echo 0 || echo 1)" "lanes=[$OBSERVED_LANES]"

# --- a card and a run on the made board -----------------------------------------------------------
rm -f "$RUN_DIR/create-board-card.json"
API_URL="$API_URL" BOARD_ID="${BOARD_ID:-}" EVIDENCE_DIR="$RUN_DIR/create-board-card" \
  CARD_FILE="$RUN_DIR/create-board-card.json" bun "$SKILL/create.ts" > "$RUN_DIR/create-board-card.log" 2>&1
CARD_RC=$?
TASK_ID="$(sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p' "$RUN_DIR/create-board-card.json" 2>/dev/null)"
check "createTask puts a card on the made board (create.ts)" \
  "$([ "$CARD_RC" = "0" ] && [ -n "$TASK_ID" ] && echo 0 || echo 1)" \
  "exit=$CARD_RC, task=${TASK_ID:-none}"

run move board move --task "${TASK_ID:-tsk_missing}" --to specifying --expect-revision 1 --api "$API_URL"
check "a person moves the card to specifying" \
  "$([ "$rc" = "0" ] && has move "to specifying (revision 2)" && echo 0 || echo 1)" "exit=$rc"

run start board start --task "${TASK_ID:-tsk_missing}" --prompt "specify it" --api "$API_URL"
SESSION_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/create-board-start.txt" | head -1)"
check "board start opens a run on the card in specifying" \
  "$([ "$rc" = "0" ] && [ -n "$SESSION_ID" ] && has start "in specifying" && echo 0 || echo 1)" \
  "exit=$rc, session=${SESSION_ID:-none}"

MODE=prompt SESSION_ID="${SESSION_ID:-}" bun "$SKILL/board-create.ts" \
  > "$EVIDENCE_DIR/create-board-prompt.json" 2> "$RUN_DIR/board-create-prompt.log"
PROMPT_RC=$?
check "the run is told the specifying column's skill (the run-column join)" \
  "$([ "$PROMPT_RC" = "0" ] && grep -q '"skillSpecify":"[^"]*Clarify the goal' "$EVIDENCE_DIR/create-board-prompt.json" && echo 0 || echo 1)" \
  "exit=$PROMPT_RC, see create-board-prompt.json"

# --- refusals --------------------------------------------------------------------------------------
run unknown board create --repo "$REPO" --definition "nosuch$HEX" --api "$API_URL"
check "an unknown definition is refused, naming it" \
  "$(yes_if has unknown "error: definition_not_found: no board definition nosuch$HEX")" "message verbatim"
check "and the unknown-definition refusal exits non-zero" "$([ "$rc" != "0" ] && echo 0 || echo 1)" "exit=$rc"

run noversion board create --repo "$REPO" --version 99 --api "$API_URL"
check "a version the definition lacks is refused, naming both" \
  "$(yes_if has noversion "error: definition_not_found: board definition default has no version 99")" \
  "message verbatim"
check "and the unknown-version refusal exits non-zero" "$([ "$rc" != "0" ] && echo 0 || echo 1)" "exit=$rc"

run badrepo board create --repo "Not A Repo" --api "$API_URL"
check "a repo that is not owner/name is invalid_input, sent nowhere" \
  "$([ "$rc" != "0" ] && has badrepo 'error: invalid_input: --repo "Not A Repo" is not a repository (owner/name)' && echo 0 || echo 1)" \
  "exit=$rc"

# --- evidence --------------------------------------------------------------------------------------
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "repo": "%s",\n' "$REPO"
  printf '  "boardId": "%s",\n' "${BOARD_ID:-}"
  printf '  "pinnedBoardId": "%s",\n' "${PINNED_ID:-}"
  printf '  "newestVersion": "%s",\n' "$NEWEST"
  printf '  "taskId": "%s",\n' "${TASK_ID:-}"
  printf '  "sessionId": "%s",\n' "${SESSION_ID:-}"
  printf '  "checks": {\n'
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/create-board.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "board-create: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "board-create: FAILURES — see $EVIDENCE_DIR/create-board.json" >&2
fi
exit "$failed"
