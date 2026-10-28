#!/usr/bin/env bash
# Drive `factory skill ls` / `show` / `put` in a real tmux terminal (D7): list the skills with their
# newest version and the default definition's columns that bind them, show one version, put a skill
# of this run's own from a SKILL.md and then an edit of it — version 1, then version 2, with version 1
# still readable as it was — and the typed refusals: an unknown name or version, a blank body, and a
# file with no name (refused before any request).
#
# The skills need no deployment setting, so this runs against the instance ./up.sh started (API_URL,
# default :9300) with its own tmux server and fixtures under .verify/run/cli-skill/. ./drive.sh runs
# it as a block; it can also be run alone after ./up.sh. It puts only a skill named for this run, so
# the shipped skills a later run is told are never touched; the rows stay, as session logs do.
#
# Evidence: .verify/evidence/latest/cli/skill-*.txt (the raw panes) and skill.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9300}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run/cli-skill"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-skill"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
# A skill of this run's own, so a version an earlier run put is never the one asserted on.
RUN_ID="$(date +%s)-$$"
SKILL="verify-cli-skill-$RUN_ID"
UNKNOWN="verify-cli-unknown-$RUN_ID"
# A port nothing listens on: a command that sent a request there would fail as `error: error:`.
DEAD_API="http://127.0.0.1:9"

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

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi

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

has() { grep -qx -- "$2" "$EVIDENCE_DIR/$1"; }
failed_with() { # marker, file, code
  [ "$(exit_code "$1")" != "0" ] && [ -n "$(exit_code "$1")" ] &&
    grep -q "^error: $3: " "$EVIDENCE_DIR/$2"
}

t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -x 220 -y 60 -c "$ROOT"
trap 't kill-server 2>/dev/null || true' EXIT

# The fixtures: the skill as a SKILL.md, an edit of it, a blank body, and a file with no name.
V1="$RUN_DIR/v1.md"
V2="$RUN_DIR/v2.md"
BLANK="$RUN_DIR/blank.md"
NAMELESS="$RUN_DIR/nameless.md"
printf -- '---\nname: %s\ndescription: |\n  A skill verify-cli puts,\n  over two lines.\nlicense: MIT\n---\n\n# Probe\n\nVersion one body.\n' "$SKILL" > "$V1"
printf -- '---\nname: %s\n---\n# Probe\n\nVersion two body.\n' "$SKILL" > "$V2"
printf -- '---\nname: %s\n---\n\n   \n' "$SKILL" > "$BLANK"
printf -- '# No frontmatter here\n' > "$NAMELESS"

# --- ls: the shipped skills, their newest version, and the columns that bind them ----------------
drive ls skill-ls.txt "$FACTORY skill ls --api $API_URL"
row_of() { awk -v name="$2" '$1 == name { print; exit }' "$EVIDENCE_DIR/$1"; }
check "skill ls exits 0 with its header" \
  "$([ "$(exit_code ls)" = "0" ] &&
    grep -qE '^name[[:space:]]+version[[:space:]]+columns[[:space:]]+updated-at[[:space:]]+description$' \
      "$EVIDENCE_DIR/skill-ls.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code ls)"
SPECIFY_ROW="$(row_of skill-ls.txt specify)"
check "skill ls lists specify with its newest version and the column that binds it" \
  "$(echo "$SPECIFY_ROW" | awk '$2 ~ /^[0-9]+$/ && $3 == "specifying" { ok = 1 } END { exit !ok }' && echo 0 || echo 1)" \
  "row=$(echo "$SPECIFY_ROW" | tr '\t' ' ' | cut -c1-100)"
check "skill ls names each stage skill's column and none for an unbound skill" \
  "$(row_of skill-ls.txt implement | awk '$3 == "building" { ok = 1 } END { exit !ok }' &&
    row_of skill-ls.txt review | awk '$3 == "review" { ok = 1 } END { exit !ok }' &&
    row_of skill-ls.txt decompose | awk '$3 == "none" { ok = 1 } END { exit !ok }' && echo 0 || echo 1)" \
  "implement=building review=review decompose=none"
SPECIFY_VERSION="$(echo "$SPECIFY_ROW" | awk '{ print $2 }')"

# --- show: one version, its header and its body ---------------------------------------------------
drive show skill-show-specify.txt "$FACTORY skill show specify --api $API_URL"
check "skill show prints the newest version, marked newest, and the body" \
  "$([ "$(exit_code show)" = "0" ] && has skill-show-specify.txt "name         specify" &&
    has skill-show-specify.txt "version      $SPECIFY_VERSION (newest)" &&
    grep -q '^# Specify' "$EVIDENCE_DIR/skill-show-specify.txt" && echo 0 || echo 1)" \
  "version=$SPECIFY_VERSION"

# --- put: a new skill is version 1 ----------------------------------------------------------------
drive put1 skill-put-v1.txt "$FACTORY skill put --file $V1 --api $API_URL"
check "skill put of a new skill exits 0 and makes version 1" \
  "$([ "$(exit_code put1)" = "0" ] && has skill-put-v1.txt "put          $SKILL@1" &&
    has skill-put-v1.txt "previous     none (a new skill)" && echo 0 || echo 1)" \
  "exit=$(exit_code put1)"
check "the put read the frontmatter's block description onto one line" \
  "$(has skill-put-v1.txt "description  A skill verify-cli puts, over two lines." && echo 0 || echo 1)" \
  "description folded"

# --- put again: an edit is version 2, and version 1 is not overwritten -----------------------------
drive put2 skill-put-v2.txt "$FACTORY skill put --file $V2 --api $API_URL"
check "skill put of an edit makes version 2 and names the version it superseded" \
  "$([ "$(exit_code put2)" = "0" ] && has skill-put-v2.txt "put          $SKILL@2" &&
    has skill-put-v2.txt "previous     $SKILL@1" &&
    has skill-put-v2.txt "note         runs already open keep the version they opened with; the next run is told $SKILL@2" &&
    echo 0 || echo 1)" \
  "exit=$(exit_code put2)"
check "an edit with no description keeps the superseded version's" \
  "$(has skill-put-v2.txt "description  A skill verify-cli puts, over two lines." && echo 0 || echo 1)" \
  "description kept"
drive showv1 skill-show-v1.txt "$FACTORY skill show $SKILL --version 1 --api $API_URL"
check "version 1 is still the body it was put with, and says it is not the newest" \
  "$([ "$(exit_code showv1)" = "0" ] && has skill-show-v1.txt "version      1 (newest is 2)" &&
    has skill-show-v1.txt "Version one body." && ! grep -q "Version two body." "$EVIDENCE_DIR/skill-show-v1.txt" &&
    echo 0 || echo 1)" \
  "exit=$(exit_code showv1)"
drive shownew skill-show-v2.txt "$FACTORY skill show $SKILL --api $API_URL"
check "show without --version reads version 2, the edit" \
  "$([ "$(exit_code shownew)" = "0" ] && has skill-show-v2.txt "version      2 (newest)" &&
    has skill-show-v2.txt "Version two body." && echo 0 || echo 1)" \
  "exit=$(exit_code shownew)"

# --- refusals -------------------------------------------------------------------------------------
drive unknown skill-show-unknown.txt "$FACTORY skill show $UNKNOWN --api $API_URL"
check "show of an unknown skill is skill_not_found, non-zero" \
  "$(failed_with unknown skill-show-unknown.txt skill_not_found && echo 0 || echo 1)" \
  "exit=$(exit_code unknown)"
drive noversion skill-show-no-version.txt "$FACTORY skill show $SKILL --version 9 --api $API_URL"
check "show of a version the skill does not hold is skill_not_found, naming it" \
  "$(failed_with noversion skill-show-no-version.txt skill_not_found &&
    grep -qF "skill \"$SKILL\" has no version 9" "$EVIDENCE_DIR/skill-show-no-version.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code noversion)"
drive blank skill-put-blank.txt "$FACTORY skill put --file $BLANK --api $API_URL"
check "a put with a blank body is invalid_skill, non-zero" \
  "$(failed_with blank skill-put-blank.txt invalid_skill && echo 0 || echo 1)" \
  "exit=$(exit_code blank)"
drive nameless skill-put-nameless.txt "$FACTORY skill put --file $NAMELESS --api $DEAD_API"
check "a file with no name and no --name is invalid_input before any request" \
  "$(failed_with nameless skill-put-nameless.txt invalid_input && echo 0 || echo 1)" \
  "exit=$(exit_code nameless), --api $DEAD_API never asked"

# --- ls again: the skill at version 2, bound by no column; and piped, tab-separated ---------------
drive ls2 skill-ls-after.txt "$FACTORY skill ls --api $API_URL"
PUT_ROW="$(row_of skill-ls-after.txt "$SKILL")"
check "skill ls lists the put skill once, at version 2, with no column" \
  "$([ "$(grep -cE "^$SKILL[[:space:]]" "$EVIDENCE_DIR/skill-ls-after.txt")" = "1" ] &&
    echo "$PUT_ROW" | awk '$2 == "2" && $3 == "none" { ok = 1 } END { exit !ok }' && echo 0 || echo 1)" \
  "row=$(echo "$PUT_ROW" | tr '\t' ' ' | cut -c1-100)"
$FACTORY skill ls --api "$API_URL" > "$EVIDENCE_DIR/skill-ls-piped.txt" 2>&1
PIPED_COLUMNS="$(awk -F'\t' '$1 == "specify" { print $3; exit }' "$EVIDENCE_DIR/skill-ls-piped.txt")"
check "piped, skill ls separates its columns with tabs" \
  "$([ "$(head -1 "$EVIDENCE_DIR/skill-ls-piped.txt")" = "$(printf 'name\tversion\tcolumns\tupdated-at\tdescription')" ] &&
    [ "$PIPED_COLUMNS" = "specifying" ] && echo 0 || echo 1)" \
  "specify columns=$PIPED_COLUMNS"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "skill": "%s",\n' "$SKILL"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/skill.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "skill: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "skill: FAILURES — see $EVIDENCE_DIR/skill.json" >&2
fi
exit "$failed"
