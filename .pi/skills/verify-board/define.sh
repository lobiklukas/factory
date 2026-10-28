#!/usr/bin/env bash
# Drive authoring a board definition version (D4): `factory board define --file def.json [--dry-run]`
# against a real control plane, each outcome read back from `board_definitions` (the oracle,
# `define.ts`) rather than from the command's own answer.
#
# The definition is the drive's own (`drv<hex>`, never `default`, which ./up.sh's board and every
# other drive pins): todo → doing → done, `doing` in the `builder` role binding the seeded `implement`
# skill and requiring `pr_link`, its move to `done` behind a `sign-off` gate, and a `canceled` lane.
# The drive proves, in order:
#
# - `--dry-run` validates and writes nothing — no row for the id, and every row the table held is
#   byte for byte what it was;
# - the define writes v1 and only v1, and prints it described (`faux/builder (role)` from ./up.sh's
#   `ROLE_MODELS`, the gate on the exit); defining it again writes nothing and says `unchanged`;
# - a changed file (read from stdin, `--file -`) writes v2, and v1 is still exactly what it was;
# - `board definitions` lists v1 and v2, `board create --definition` pins v2, `board config` describes
#   it, and `board add` starts a card in its initial column;
# - each refusal of the spec — a duplicate column, no initial column, a move to an undeclared column,
#   a terminal column with exits, no terminal column, an unknown requires key, an unknown skill, a
#   role ROLE_MODELS lacks — is `error: invalid_definition:` naming the field, non-zero, and writes
#   nothing (`--dry-run` included);
# - a file that is not JSON, carries a key the schema does not name, or cannot be read is the CLI's
#   `invalid_input`, sent nowhere.
#
# The commands run as plain subprocesses, whose stdout, stderr and exit code are captured exactly.
# Requires the instance from ./up.sh (API on API_PORT, default 9400) and DATABASE_URL naming its
# database, for `define.ts`'s reads.
set -uo pipefail

# This suite runs its API with auth off (LOB-20), like ./definitions.sh: a token exported for the
# rest of the verify skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
SKILL="$ROOT/.pi/skills/verify-board"
FILES="$RUN_DIR/define-files"

mkdir -p "$EVIDENCE_DIR" "$RUN_DIR" "$FILES"
rm -f "$EVIDENCE_DIR"/define-*.txt "$EVIDENCE_DIR/define.json" "$FILES"/*.json

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
    printf 'PASS  %-72s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-72s %s\n' "$1" "$3"
  fi
}

# Run one `factory` command: the command line, then its stdout and stderr, into one evidence file;
# stdout and stderr alone beside it, for the comparisons; its exit code into `rc`. STDIN, when set,
# names the file piped to it.
rc=0
STDIN=""
run() { # evidence name, args...
  local name="$1"
  shift
  local out="$EVIDENCE_DIR/define-$name.txt"
  printf '$ factory %s%s\n' "$*" "${STDIN:+ < $(basename "$STDIN")}" > "$out"
  if [ -n "$STDIN" ]; then
    "${FACTORY[@]}" "$@" < "$STDIN" > "$RUN_DIR/define-$name.out" 2> "$RUN_DIR/define-$name.err"
  else
    "${FACTORY[@]}" "$@" > "$RUN_DIR/define-$name.out" 2> "$RUN_DIR/define-$name.err" < /dev/null
  fi
  rc=$?
  cat "$RUN_DIR/define-$name.out" "$RUN_DIR/define-$name.err" >> "$out"
}
has() { grep -qF -- "$2" "$EVIDENCE_DIR/define-$1.txt"; }
first_err() { head -1 "$RUN_DIR/define-$1.err"; }
yes_if() { "$@" && echo 0 || echo 1; }
ok_rc() { [ "$rc" = "0" ] && echo 0 || echo 1; }
probe() { bun "$SKILL/define.ts" 2>>"$RUN_DIR/define-probe.log"; }
# Sorted in the shell's own collation, so `comm` reads it as sorted.
table() { MODE=rows probe | LC_ALL=C sort; }
versions() { MODE=versions ID="$1" probe; }

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi
: > "$RUN_DIR/define-probe.log"
if ! table > "$RUN_DIR/define-rows-start.txt"; then
  echo "define: could not read board_definitions — see $RUN_DIR/define-probe.log" >&2
  exit 1
fi

HEX="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
ID="drv$HEX"

# One definition file, as an author writes it. `$1` is the version's name; the rest are jq-free
# substitutions the refusal cases make on a copy.
write_definition() { # path, name
  cat > "$1" <<EOF
{
  "id": "$ID",
  "name": "$2",
  "initialColumn": "todo",
  "caps": { "board": 3 },
  "columns": [
    { "name": "todo", "kind": "resting", "skills": [], "requires": [],
      "transitions": [{ "to": "doing" }, { "to": "canceled" }] },
    { "name": "doing", "kind": "working", "role": "builder", "skills": ["implement"],
      "requires": [{ "key": "pr_link", "description": "a PR link" }],
      "transitions": [{ "to": "done", "gate": "sign-off" }, { "to": "canceled" }], "wipLimit": 2 },
    { "name": "done", "kind": "terminal", "skills": [], "requires": [], "transitions": [] },
    { "name": "canceled", "kind": "terminal", "skills": [], "requires": [] }
  ]
}
EOF
}
write_definition "$FILES/v1.json" "Driven pipeline"
write_definition "$FILES/v2.json" "Driven pipeline, renamed"

# --- --dry-run: validated, nothing written ---------------------------------------------------------
run dry board define --file "$FILES/v1.json" --dry-run --api "$API_URL"
check "board define --dry-run exits 0" "$(ok_rc)" "exit=$rc"
check "it says the version it would write, and that nothing was written" \
  "$(yes_if has dry "valid       $ID would be written as v1; nothing written (--dry-run)")" "v1"
check "it describes the version it validated: the builder's model and the sign-off gate" \
  "$(has dry '  model     faux/builder (role)' && has dry '  exits     done [human gate: sign-off], canceled' && echo 0 || echo 1)" \
  "faux/builder (role), sign-off"
table > "$RUN_DIR/define-rows-dry.txt"
check "the dry run wrote no row, and changed none (board_definitions, read back)" \
  "$([ -z "$(versions "$ID")" ] && diff -q "$RUN_DIR/define-rows-start.txt" "$RUN_DIR/define-rows-dry.txt" >/dev/null && echo 0 || echo 1)" \
  "versions=[$(versions "$ID")]"

# --- define: v1 written, and only v1 ---------------------------------------------------------------
run v1 board define --file "$FILES/v1.json" --api "$API_URL"
check "board define exits 0" "$(ok_rc)" "exit=$rc"
check "it prints the version written, described" \
  "$(has v1 "defined     $ID v1" && has v1 "definition  $ID v1  Driven pipeline" && has v1 'initial     todo' && has v1 'caps        board 3 runs in flight' && has v1 '  wip       at most 2 runs in flight' && echo 0 || echo 1)" \
  "header, initial, caps, wip"
table > "$RUN_DIR/define-rows-v1.txt"
NEW_V1="$(LC_ALL=C comm -13 "$RUN_DIR/define-rows-start.txt" "$RUN_DIR/define-rows-v1.txt" | awk '{print $1}' | tr '\n' ' ' | sed 's/ $//')"
check "exactly one row is new — $ID@1 — and every row that existed is unchanged" \
  "$([ "$NEW_V1" = "$ID@1" ] && [ -z "$(LC_ALL=C comm -23 "$RUN_DIR/define-rows-start.txt" "$RUN_DIR/define-rows-v1.txt")" ] && echo 0 || echo 1)" \
  "new=[$NEW_V1]"

run again board define --file "$FILES/v1.json" --api "$API_URL"
check "defining the same file again exits 0 and says unchanged, v1" \
  "$([ "$rc" = "0" ] && has again "unchanged   $ID v1 already holds this definition; nothing written" && echo 0 || echo 1)" "exit=$rc"
check "and writes nothing" "$([ "$(versions "$ID")" = "1" ] && echo 0 || echo 1)" "versions=[$(versions "$ID")]"

# --- a changed file, from stdin: v2, v1 untouched ---------------------------------------------------
STDIN="$FILES/v2.json" run v2 board define --file - --api "$API_URL"
check "a changed file on stdin (--file -) is written as v2" \
  "$([ "$rc" = "0" ] && has v2 "defined     $ID v2" && has v2 "definition  $ID v2  Driven pipeline, renamed" && echo 0 || echo 1)" "exit=$rc"
table > "$RUN_DIR/define-rows-v2.txt"
NEW_V2="$(LC_ALL=C comm -13 "$RUN_DIR/define-rows-v1.txt" "$RUN_DIR/define-rows-v2.txt" | awk '{print $1}' | tr '\n' ' ' | sed 's/ $//')"
check "only $ID@2 is new, and $ID@1 is byte for byte what it was" \
  "$([ "$NEW_V2" = "$ID@2" ] && [ -z "$(LC_ALL=C comm -23 "$RUN_DIR/define-rows-v1.txt" "$RUN_DIR/define-rows-v2.txt")" ] && echo 0 || echo 1)" \
  "new=[$NEW_V2]"

# --- the rest of the board reads it -----------------------------------------------------------------
run list board definitions --api "$API_URL"
check "board definitions lists $ID v1 and v2" \
  "$([ "$rc" = "0" ] && grep -Eq "^$ID  v1  Driven pipeline  " "$RUN_DIR/define-list.out" && grep -Eq "^$ID  v2  Driven pipeline, renamed  " "$RUN_DIR/define-list.out" && echo 0 || echo 1)" \
  "exit=$rc"
REPO="verify-board/define-$HEX"
run create board create --repo "$REPO" --definition "$ID" --api "$API_URL"
BOARD="$(sed -n 's/^board  *//p' "$RUN_DIR/define-create.out" | head -1)"
check "board create --definition $ID pins the newest, v2" \
  "$([ "$rc" = "0" ] && [ -n "$BOARD" ] && has create "definition  $ID v2" && echo 0 || echo 1)" "board=${BOARD:-none}"
run config board config --board "${BOARD:-brd_missing}" --api "$API_URL"
check "board config describes the authored v2" \
  "$([ "$rc" = "0" ] && has config "definition  $ID v2  Driven pipeline, renamed" && has config '  exits     done [human gate: sign-off], canceled' && echo 0 || echo 1)" "exit=$rc"
run add board add --board "${BOARD:-brd_missing}" --title "authored card" --api "$API_URL"
check "board add starts a card in the authored initial column, todo" \
  "$([ "$rc" = "0" ] && grep -Eq '^task tsk_[0-9a-z]{26} revision 1 column todo$' "$RUN_DIR/define-add.out" && echo 0 || echo 1)" "exit=$rc"

# --- refusals: typed, naming the field, writing nothing ---------------------------------------------
# Each is v1's file with one fault, made with sed so the rest stays valid.
refuse() { # evidence name, field, sed expression, [extra flag]
  local name="$1" field="$2" expr="$3" extra="${4:-}"
  sed -e "$expr" "$FILES/v1.json" > "$FILES/$name.json"
  local before
  before="$(table)"
  run "$name" board define --file "$FILES/$name.json" ${extra:+"$extra"} --api "$API_URL"
  local line
  line="$(first_err "$name")"
  check "refused ($name${extra:+, $extra}): invalid_definition naming $field, non-zero, nothing written" \
    "$([ "$rc" != "0" ] && [[ "$line" == "error: invalid_definition: definition $ID: $field: "* ]] && has "$name" "  $field: " && [ "$(table)" = "$before" ] && echo 0 || echo 1)" \
    "exit=$rc; $line"
}
refuse duplicate-column 'columns[3].name' 's/"name": "canceled"/"name": "done"/'
refuse no-initial-column 'initialColumn' '/"initialColumn"/d'
refuse undeclared-move 'columns[0].transitions[0].to' 's/{ "to": "doing" }/{ "to": "shipped" }/'
refuse terminal-exits 'columns[2].transitions' 's/"kind": "terminal", "skills": \[\], "requires": \[\], "transitions": \[\]/"kind": "terminal", "skills": [], "requires": [], "transitions": [{ "to": "todo" }]/'
refuse no-terminal 'columns' 's/"kind": "terminal"/"kind": "resting"/g'
refuse unknown-requirement 'columns[1].requires[0].key' 's/"key": "pr_link"/"key": "signed_off"/'
refuse unknown-skill 'columns[1].skills[0]' 's/\["implement"\]/["deploy-'"$HEX"'"]/'
refuse unknown-role 'columns[1].role' 's/"role": "builder"/"role": "buidler"/'
refuse unknown-skill-dry 'columns[1].skills[0]' 's/\["implement"\]/["deploy-'"$HEX"'"]/' --dry-run
check "after every refusal $ID still holds v1 and v2 only" \
  "$([ "$(versions "$ID")" = "1 2" ] && echo 0 || echo 1)" "versions=[$(versions "$ID")]"

# --- the CLI's own refusals: nothing sent -----------------------------------------------------------
printf '{ "id": "%s", ' "$ID" > "$FILES/not-json.json"
run not-json board define --file "$FILES/not-json.json" --api "$API_URL"
check "a file that is not JSON is invalid_input, non-zero" \
  "$([ "$rc" != "0" ] && [[ "$(first_err not-json)" == "error: invalid_input: --file \"$FILES/not-json.json\": not a board definition: "* ]] && echo 0 || echo 1)" \
  "exit=$rc; $(first_err not-json)"
sed -e 's/"wipLimit": 2/"wiplimit": 2/' "$FILES/v1.json" > "$FILES/misspelt.json"
run misspelt board define --file "$FILES/misspelt.json" --api "$API_URL"
check "a key the schema does not name (wiplimit) is invalid_input naming it, non-zero" \
  "$([ "$rc" != "0" ] && has misspelt 'error: invalid_input: ' && has misspelt 'wiplimit' && echo 0 || echo 1)" \
  "exit=$rc; $(first_err misspelt)"
run missing board define --file "$FILES/nosuch.json" --api "$API_URL"
check "a file that cannot be read is invalid_input, non-zero" \
  "$([ "$rc" != "0" ] && [[ "$(first_err missing)" == "error: invalid_input: --file \"$FILES/nosuch.json\" cannot be read: "* ]] && echo 0 || echo 1)" \
  "exit=$rc"
table > "$RUN_DIR/define-rows-end.txt"
check "the CLI's refusals wrote nothing" \
  "$(diff -q "$RUN_DIR/define-rows-v2.txt" "$RUN_DIR/define-rows-end.txt" >/dev/null && echo 0 || echo 1)" "rows unchanged since v2"

# --- definition show --json: a file define accepts, and a round trip (F8) --------------------------
# $ID's newest is v2 (the refusals above wrote nothing). Its file read back, defined with --dry-run,
# is unchanged; one field edited and defined is a v3 differing in that field only.
json_keys() { bun -e 'const t = await Bun.file(process.argv[1]).text(); console.log(Object.keys(JSON.parse(t)).sort().join(" "))' "$1"; }
run show-json board definition show "$ID" --version 2 --json --api "$API_URL"
cp "$RUN_DIR/define-show-json.out" "$FILES/shown-v2.json"
check "definition show --json exits 0 and prints one JSON document on stdout, nothing on stderr" \
  "$([ "$rc" = "0" ] && [ ! -s "$RUN_DIR/define-show-json.err" ] && json_keys "$FILES/shown-v2.json" >/dev/null 2>&1 && echo 0 || echo 1)" "exit=$rc"
check "it names exactly the keys a definition file does — no version, no author, no actor" \
  "$([ "$(json_keys "$FILES/shown-v2.json")" = "caps columns id initialColumn name" ] && echo 0 || echo 1)" \
  "keys=[$(json_keys "$FILES/shown-v2.json")]"
run roundtrip board define --file "$FILES/shown-v2.json" --dry-run --api "$API_URL"
check "define --file <shown> --dry-run answers unchanged, v2: the file is the version" \
  "$([ "$rc" = "0" ] && has roundtrip "unchanged   $ID v2 already holds this definition; nothing written" && echo 0 || echo 1)" "exit=$rc"
sed -e 's/"name": "Driven pipeline, renamed"/"name": "Driven pipeline, edited from a shown file"/' "$FILES/shown-v2.json" > "$FILES/shown-v3.json"
run roundtrip-edit board define --file "$FILES/shown-v3.json" --api "$API_URL"
check "the file with one field edited is written as v3" \
  "$([ "$rc" = "0" ] && has roundtrip-edit "defined     $ID v3" && has roundtrip-edit "definition  $ID v3  Driven pipeline, edited from a shown file" && echo 0 || echo 1)" "exit=$rc"
run show-json-v3 board definition show "$ID" --version 3 --json --api "$API_URL"
FILE_DIFF="$(diff "$FILES/shown-v2.json" "$RUN_DIR/define-show-json-v3.out" || true)"
DIFFERING="$(printf '%s\n' "$FILE_DIFF" | grep -c '^<' || true)"
check "v3 read back differs from v2 in that one field only (the name)" \
  "$([ "$DIFFERING" = "1" ] && [[ "$FILE_DIFF" == *'< '*'"name": "Driven pipeline, renamed"'* ]] && echo 0 || echo 1)" \
  "differing lines in v2=$DIFFERING"
run show-json-legacy board definition show default --version 1 --json --api "$API_URL"
cp "$RUN_DIR/define-show-json-legacy.out" "$FILES/legacy.json"
check "a legacy version (default v1) spells out its initial column and every column's moves" \
  "$(bun -e 'const d = JSON.parse(await Bun.file(process.argv[1]).text()); const ok = d.initialColumn === "intake" && d.columns.every((c) => Array.isArray(c.transitions)) && d.columns[0].transitions.length > 0; process.exit(ok ? 0 : 1)' "$FILES/legacy.json" && echo 0 || echo 1)" \
  "initialColumn intake, transitions on every column"
BEFORE_LEGACY="$(table)"
run legacy-dry board define --file "$FILES/legacy.json" --dry-run --api "$API_URL"
check "and that file decodes on the way in (never invalid_input) and a dry run writes nothing" \
  "$(! has legacy-dry 'error: invalid_input' && [ "$(table)" = "$BEFORE_LEGACY" ] && echo 0 || echo 1)" "exit=$rc; $(head -1 "$RUN_DIR/define-legacy-dry.err")"
check "after the round trip $ID holds v1, v2 and v3" \
  "$([ "$(versions "$ID")" = "1 2 3" ] && echo 0 || echo 1)" "versions=[$(versions "$ID")]"

# --- author (F7): this suite runs with auth off, so no caller is named --------------------------------
# The credential's actor on a version is proven by verify-api's identity.sh (auth on); here the
# contrary: with no caller there is no author, in the table and in the listing.
check "with auth off a version written by board define has no author (NULL), seeded or not" \
  "$([ "$(MODE=authors ID="$ID" probe)" = "1=NULL 2=NULL 3=NULL" ] && echo 0 || echo 1)" \
  "authors=[$(MODE=authors ID="$ID" probe)]"
check "board definitions prints no author for them" \
  "$(! grep -E "^$ID  " "$RUN_DIR/define-list.out" | grep -q ' by ' && echo 0 || echo 1)" "no 'by' column"

# --- evidence --------------------------------------------------------------------------------------
cp "$FILES/v1.json" "$EVIDENCE_DIR/define-v1.json"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "definitionId": "%s",\n' "$ID"
  printf '  "board": "%s",\n' "${BOARD:-}"
  printf '  "checks": {\n'
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/define.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "define: all ${#rows[@]} checks passed — evidence in $EVIDENCE_DIR"
else
  echo "define: FAILURES — see $EVIDENCE_DIR/define.json" >&2
fi
exit "$failed"
