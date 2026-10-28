#!/usr/bin/env bash
# Drive the board's configuration reads (LOB-270): `factory board definitions`, `factory board
# definition show <id> [--version]`, `factory board list` and `factory board config --board …` against
# a real control plane, each read back against the database (the oracle) or the expected description.
#
# The definition the drive shows is the seeded `default` pipeline at version 3, and its whole printed
# description is compared with `definitions-v3.expected` — every column's kind, role (or —), resolved
# model, skills, requires marked checked or unchecked, and exits with the human gates marked. The
# expected models are ./up.sh's: `ROLE_MODELS=builder=faux/builder`, so `building` runs its role's row
# and every other column the deployment's `faux/faux-1`. Then the refusals: an unknown id and an
# unknown version are the server's `definition_not_found`, a malformed id or board is the CLI's
# `invalid_input`, and an unknown board is `board_not_found` — each non-zero.
#
# The commands run as plain subprocesses, whose stdout, stderr and exit code are captured exactly, and
# `definition show default --version 3` runs once more in a private tmux server (its own socket, killed
# on exit), where the pane a person reads is captured and compared with the same expected text.
#
# Requires the instance from ./up.sh (API on API_PORT, default 9400; its seeded board in
# .verify/run/board.json) and DATABASE_URL naming the same database, for `board-create.ts`'s reads.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
SKILL="$ROOT/.pi/skills/verify-board"
EXPECTED="$SKILL/definitions-v3.expected"
SOCK="$RUN_DIR/definitions-tmux.sock"
TERM_SESSION="verify-definitions"
# The default pipeline (0007_create_tasks.ts), in declaration order.
LANES="intake specifying planning building review done canceled"

mkdir -p "$EVIDENCE_DIR" "$RUN_DIR"
rm -f "$EVIDENCE_DIR"/definitions-*.txt "$EVIDENCE_DIR/definitions.json"

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

# Run one `factory` command: the command line, then its stdout and stderr, into one evidence file;
# its stdout alone into a second (`.out`), for the comparisons; its exit code into `rc`.
rc=0
run() { # evidence name, args...
  local name="$1"
  shift
  local out="$EVIDENCE_DIR/definitions-$name.txt"
  printf '$ factory %s\n' "$*" > "$out"
  "${FACTORY[@]}" "$@" > "$RUN_DIR/definitions-$name.out" 2> "$RUN_DIR/definitions-$name.err"
  rc=$?
  cat "$RUN_DIR/definitions-$name.out" "$RUN_DIR/definitions-$name.err" >> "$out"
}
has() { grep -qF -- "$2" "$EVIDENCE_DIR/definitions-$1.txt"; }
yes_if() { "$@" && echo 0 || echo 1; }
ok_rc() { [ "$rc" = "0" ] && echo 0 || echo 1; }
bad_rc() { [ "$rc" != "0" ] && echo 0 || echo 1; }
# The column headers of a description, in order: `<name>  <kind>` lines.
columns_of() { grep -E '^[a-z_-]+  (resting|working|terminal)$' "$1" | awk '{print $1}' | tr '\n' ' ' | sed 's/ $//'; }

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi
if [ ! -s "$RUN_DIR/board.json" ]; then
  echo "no seeded board in $RUN_DIR/board.json — run ./up.sh first" >&2
  exit 1
fi
json() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$2"; }
SEEDED_BOARD="$(json boardId "$RUN_DIR/board.json")"
SEEDED_REPO="$(json repo "$RUN_DIR/board.json")"

NEWEST="$(MODE=newest bun "$SKILL/board-create.ts" 2>"$RUN_DIR/definitions-newest.log")"
if [ -z "$NEWEST" ]; then
  echo "definitions: could not read the newest default version — see $RUN_DIR/definitions-newest.log" >&2
  exit 1
fi
HEX="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"

# --- definitions: every id and version -------------------------------------------------------------
run list-definitions board definitions --api "$API_URL"
check "board definitions exits 0" "$(ok_rc)" "exit=$rc"
LISTED_DEFAULT="$(grep -E '^default  v[0-9]+  ' "$RUN_DIR/definitions-list-definitions.out" | awk '{print $2}' | tr '\n' ' ' | sed 's/ $//')"
WANT_DEFAULT="$(seq 1 "$NEWEST" | sed 's/^/v/' | tr '\n' ' ' | sed 's/ $//')"
check "it lists default v1–v$NEWEST, oldest first (the database's newest is v$NEWEST)" \
  "$([ "$NEWEST" -ge 3 ] && [ "$LISTED_DEFAULT" = "$WANT_DEFAULT" ] && echo 0 || echo 1)" \
  "listed=[$LISTED_DEFAULT]"
check "each default version line names the pipeline and a timestamp" \
  "$(yes_if grep -Eq '^default  v3  Default pipeline  [0-9]{4}-[0-9]{2}-[0-9]{2}T' "$RUN_DIR/definitions-list-definitions.out")" \
  "default v3 line"

# --- definition show default --version 3: the whole description ------------------------------------
run show-v3 board definition show default --version 3 --api "$API_URL"
check "board definition show default --version 3 exits 0" "$(ok_rc)" "exit=$rc"
check "its header names the definition, the version and its name" \
  "$(yes_if has show-v3 'definition  default v3  Default pipeline')" "header"
OBSERVED_COLUMNS="$(columns_of "$RUN_DIR/definitions-show-v3.out")"
check "it prints every column with its kind, in definition order" \
  "$([ "$OBSERVED_COLUMNS" = "$LANES" ] && echo 0 || echo 1)" "columns=[$OBSERVED_COLUMNS]"
check "a column with no role prints — for it" \
  "$(yes_if grep -Fxq '  role      —' "$RUN_DIR/definitions-show-v3.out")" "intake, done, canceled"
check "building's model is its role's row (ROLE_MODELS)" \
  "$(yes_if grep -Fxq '  model     faux/builder (role)' "$RUN_DIR/definitions-show-v3.out")" "faux/builder (role)"
check "a role with no row runs the deployment's model" \
  "$(yes_if grep -Fxq '  model     faux/faux-1 (deployment)' "$RUN_DIR/definitions-show-v3.out")" "faux/faux-1 (deployment)"
check "the checked requirements are marked checked" \
  "$(has show-v3 'non_empty_diff (checked)' && has show-v3 'pr_link (checked)' && has show-v3 'verified (checked)' && echo 0 || echo 1)" \
  "non_empty_diff, pr_link, verified"
check "the declared-only requirements are marked unchecked" \
  "$(has show-v3 'spec_doc (unchecked)' && has show-v3 'plan_doc (unchecked)' && has show-v3 'run_completed (unchecked)' && has show-v3 'review_verdict (unchecked)' && has show-v3 'human_move (unchecked)' && has show-v3 'human_merge (unchecked)' && echo 0 || echo 1)" \
  "spec_doc, plan_doc, run_completed, review_verdict, human_*"
check "the human gates are marked on their exits" \
  "$(has show-v3 '  exits     building [human gate: plan approval], canceled' && has show-v3 '  exits     done [human gate: merge], canceled' && echo 0 || echo 1)" \
  "plan approval, merge"
check "the whole description is the expected one (definitions-v3.expected)" \
  "$(diff -u "$EXPECTED" "$RUN_DIR/definitions-show-v3.out" > "$EVIDENCE_DIR/definitions-show-v3.diff" && echo 0 || echo 1)" \
  "see definitions-show-v3.diff"

# --- definition show default: the newest by default ------------------------------------------------
run show-newest board definition show default --api "$API_URL"
check "with no --version it shows the newest, v$NEWEST" \
  "$([ "$rc" = "0" ] && has show-newest "definition  default v$NEWEST  " && echo 0 || echo 1)" "exit=$rc"

# --- refusals ---------------------------------------------------------------------------------------
run unknown-id board definition show "nosuch$HEX" --api "$API_URL"
check "an unknown definition is definition_not_found, naming it, non-zero" \
  "$([ "$(bad_rc)" = "0" ] && has unknown-id "error: definition_not_found: no board definition nosuch$HEX" && echo 0 || echo 1)" \
  "exit=$rc"
run unknown-version board definition show default --version 99 --api "$API_URL"
check "an unknown version is definition_not_found, naming both, non-zero" \
  "$([ "$(bad_rc)" = "0" ] && has unknown-version "error: definition_not_found: board definition default has no version 99" && echo 0 || echo 1)" \
  "exit=$rc"
run bad-id board definition show "Not An Id" --api "$API_URL"
check "a malformed definition id is invalid_input, sent nowhere" \
  "$([ "$(bad_rc)" = "0" ] && has bad-id 'error: invalid_input: "Not An Id" is not a definition id' && echo 0 || echo 1)" \
  "exit=$rc"

# --- list: every board, with its repo and pinned version -------------------------------------------
PINNED_REPO="verify-board/defs-$HEX"
run create-pinned board create --repo "$PINNED_REPO" --definition-version 1 --api "$API_URL"
PINNED_ID="$(sed -n 's/^board  *//p' "$RUN_DIR/definitions-create-pinned.out" | head -1)"
check "a second board, pinned to v1, is made for the list" \
  "$([ "$rc" = "0" ] && [ -n "$PINNED_ID" ] && echo 0 || echo 1)" "board=${PINNED_ID:-none}"
run list board list --api "$API_URL"
check "board list exits 0" "$(ok_rc)" "exit=$rc"
check "it lists ./up.sh's board with its repo and pinned version" \
  "$(yes_if grep -Eq "^$SEEDED_BOARD  $SEEDED_REPO  default v$NEWEST  [0-9]{4}-" "$RUN_DIR/definitions-list.out")" \
  "$SEEDED_BOARD $SEEDED_REPO v$NEWEST"
check "it lists the v1 board with its repo and v1" \
  "$([ -n "$PINNED_ID" ] && grep -Eq "^$PINNED_ID  $PINNED_REPO  default v1  [0-9]{4}-" "$RUN_DIR/definitions-list.out" && echo 0 || echo 1)" \
  "$PINNED_ID $PINNED_REPO v1"
LISTED_BOARDS="$(grep -cE '^brd_[0-9a-z]{26}  ' "$RUN_DIR/definitions-list.out")"
DB_BOARDS="$(MODE=boards bun "$SKILL/board-create.ts" 2>"$RUN_DIR/definitions-boards.log")"
check "it prints one line per board the database holds (up to the list's cap of 100)" \
  "$([ -n "$DB_BOARDS" ] && [ "$LISTED_BOARDS" = "$(( DB_BOARDS > 100 ? 100 : DB_BOARDS ))" ] && echo 0 || echo 1)" \
  "listed=$LISTED_BOARDS, database=${DB_BOARDS:-unread}"
CAPPED_NOTE="$(grep -c '^(showing the newest 100 boards; older boards may exist)$' "$RUN_DIR/definitions-list.out")"
check "a list cut at the cap says so on its last line, and an uncut one does not" \
  "$([ -n "$DB_BOARDS" ] && { { [ "$DB_BOARDS" -ge 100 ] && [ "$CAPPED_NOTE" = "1" ] && tail -1 "$RUN_DIR/definitions-list.out" | grep -q '^(showing'; } || { [ "$DB_BOARDS" -lt 100 ] && [ "$CAPPED_NOTE" = "0" ]; }; } && echo 0 || echo 1)" \
  "note=$CAPPED_NOTE, database=${DB_BOARDS:-unread}"

# --- config: a board's pinned version, described ---------------------------------------------------
run config board config --board "$SEEDED_BOARD" --api "$API_URL"
check "board config exits 0" "$(ok_rc)" "exit=$rc"
check "it names the board, its repo and its pinned definition version" \
  "$(has config "board       $SEEDED_BOARD" && has config "repo        $SEEDED_REPO" && has config "definition  default v$NEWEST  " && echo 0 || echo 1)" \
  "$SEEDED_BOARD v$NEWEST"
run show-pinned board definition show default --version "$NEWEST" --api "$API_URL"
check "its columns are exactly what definition show prints for that version" \
  "$([ "$rc" = "0" ] && diff <(tail -n +3 "$RUN_DIR/definitions-config.out") "$RUN_DIR/definitions-show-pinned.out" > "$EVIDENCE_DIR/definitions-config.diff" && echo 0 || echo 1)" \
  "see definitions-config.diff"
run config-v1 board config --board "${PINNED_ID:-brd_missing}" --api "$API_URL"
check "a v1 board's config describes v1: review does not require verified yet" \
  "$([ "$rc" = "0" ] && has config-v1 "definition  default v1  " && ! has config-v1 'verified (checked)' && has config-v1 'review_verdict (unchecked)' && echo 0 || echo 1)" \
  "exit=$rc"
run config-unknown board config --board "brd_$(printf '0%.0s' $(seq 1 26))" --api "$API_URL"
check "an unknown board is board_not_found, non-zero" \
  "$([ "$(bad_rc)" = "0" ] && has config-unknown "error: board_not_found: no board brd_" && echo 0 || echo 1)" "exit=$rc"
run config-bad board config --board nope --api "$API_URL"
check "a malformed board id is invalid_input, sent nowhere" \
  "$([ "$(bad_rc)" = "0" ] && has config-bad 'error: invalid_input: --board "nope" is not a board id (brd_…)' && echo 0 || echo 1)" \
  "exit=$rc"

# --- the terminal: definition show in a real tmux pane ----------------------------------------------
export LANG="${LANG:-en_US.UTF-8}" LC_ALL="${LC_ALL:-en_US.UTF-8}"
t() { tmux -u -S "$SOCK" "$@"; }
pane() { t capture-pane -p -t "$TERM_SESSION" -S -4000 | sed -e 's/[[:space:]]*$//'; }
cleanup() { t kill-server 2>/dev/null || true; rm -f "$SOCK"; }
trap cleanup EXIT
cleanup
# A plain shell with a plain prompt, so nothing a person's prompt prints lands between the lines.
t new-session -d -s "$TERM_SESSION" -x 200 -y 80 -c "$ROOT" "env PS1='$ ' bash --norc --noprofile"
t send-keys -l -t "$TERM_SESSION" "clear"
t send-keys -t "$TERM_SESSION" Enter
sleep 0.3
t clear-history -t "$TERM_SESSION" 2>/dev/null || true
t send-keys -l -t "$TERM_SESSION" "${FACTORY[*]} board definition show default --version 3 --api $API_URL"
t send-keys -t "$TERM_SESSION" Enter
t send-keys -l -t "$TERM_SESSION" "printf '\\n__done_defs:%s\\n' \$?"
t send-keys -t "$TERM_SESSION" Enter
for _ in $(seq 1 300); do
  pane | grep -q '^__done_defs:[0-9]*$' && break
  sleep 0.1
done
sleep 0.2
pane > "$EVIDENCE_DIR/definitions-pane.txt"
PANE_RC="$(grep -o '__done_defs:[0-9]*' "$EVIDENCE_DIR/definitions-pane.txt" | tail -1 | cut -d: -f2)"
# The pane's printed description: from the header up to the prompt that typed the sentinel.
sed -n '/^definition  default v3  /,$p' "$EVIDENCE_DIR/definitions-pane.txt" |
  sed -n "/^\$ printf /q;p" > "$RUN_DIR/definitions-pane.out"
check "in a tmux pane, definition show default --version 3 exits 0" \
  "$([ "${PANE_RC:-1}" = "0" ] && echo 0 || echo 1)" "exit=${PANE_RC:-none}"
check "and the pane reads the expected description, line for line" \
  "$(diff -u "$EXPECTED" "$RUN_DIR/definitions-pane.out" > "$EVIDENCE_DIR/definitions-pane.diff" && echo 0 || echo 1)" \
  "see definitions-pane.txt, definitions-pane.diff"

# --- evidence --------------------------------------------------------------------------------------
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "newestVersion": "%s",\n' "$NEWEST"
  printf '  "seededBoard": "%s",\n' "$SEEDED_BOARD"
  printf '  "pinnedBoard": "%s",\n' "${PINNED_ID:-}"
  printf '  "checks": {\n'
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/definitions.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "definitions: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "definitions: FAILURES — see $EVIDENCE_DIR/definitions.json" >&2
fi
exit "$failed"
