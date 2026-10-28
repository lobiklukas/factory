#!/usr/bin/env bash
# Drive upgrading a board to a newer definition version (D5): `factory board upgrade` and the settings
# page's Upgrade action, against a real control plane, each outcome read back from the tables
# (`upgrade.ts`, the oracle) as well as from what the command printed.
#
# The board is the drive's own (`verify-board/upgrade-<hex>`, a repository no other drive names),
# created on `default` v2 — the version whose `review` does not declare `verified`. The drive proves,
# in order:
#
# - a card made on v2 is pinned to v2 (`board show` prints `pinned    v2`);
# - an upgrade at a stale expected version is `stale_board_version`, non-zero, and writes nothing;
# - `board upgrade --to 3 --expect-version 2` moves the pin to v3 and only the pin: the old card's
#   version, revision and history are unchanged, and the command says one card still pins an older
#   version;
# - a card made after it pins v3; `board ls` and the board page (`upgrade.mjs MODE=notice`) both say
#   the board's cards pin v2 and v3;
# - with both cards in `review` (a fixture write — reaching review honestly is requires.sh's), the new
#   card's exit checklist lists `verified` and the old card's does not, and `board move --to done`
#   is refused naming `verified` for the new card and `review_verdict` for the old one: the
#   `verified` gate applies to the new card;
# - a migration whose mapping leaves `review` out is `card_migration_refused` naming both cards,
#   non-zero, and writes nothing — not the cards, not the pin;
# - `--same-columns` to v4 re-pins both cards, each with a `repinned` event (versions, the mapping,
#   the actor `cli`) at its revision and a new revision; the old card's move is now refused naming
#   `verified`;
# - the settings page's Upgrade action (`upgrade.mjs MODE=upgrade`) moves the board to v5 migrating
#   both cards, each with a `repinned` event whose actor is the dashboard's, and the board page no
#   longer says its cards pin more than one version.
#
# Requires the instance from ./up.sh (API on API_PORT, default 9400; web on WEB_PORT, read from
# .verify/run/web-port) and DATABASE_URL naming its database, for `upgrade.ts`'s reads.
set -uo pipefail

# This suite runs its API with auth off (LOB-20), like ./define.sh: a token exported for the rest of
# the verify skills must not turn auth on here.
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

mkdir -p "$EVIDENCE_DIR" "$RUN_DIR"
rm -f "$EVIDENCE_DIR"/upgrade-*.txt "$EVIDENCE_DIR/upgrade.json" \
  "$EVIDENCE_DIR"/upgrade-web-*.json "$EVIDENCE_DIR"/upgrade-*.png

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
    printf 'PASS  %-78s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-78s %s\n' "$1" "$3"
  fi
}

# Run one `factory` command: the command line, then its stdout and stderr, into one evidence file;
# stdout and stderr alone beside it; its exit code into `rc`.
rc=0
run() { # evidence name, args...
  local name="$1"
  shift
  local out="$EVIDENCE_DIR/upgrade-$name.txt"
  printf '$ factory %s\n' "$*" > "$out"
  "${FACTORY[@]}" "$@" > "$RUN_DIR/upgrade-$name.out" 2> "$RUN_DIR/upgrade-$name.err" < /dev/null
  rc=$?
  cat "$RUN_DIR/upgrade-$name.out" "$RUN_DIR/upgrade-$name.err" >> "$out"
}
has() { grep -qF -- "$2" "$EVIDENCE_DIR/upgrade-$1.txt"; }
first_err() { head -1 "$RUN_DIR/upgrade-$1.err"; }
ok_rc() { [ "$rc" = "0" ] && echo 0 || echo 1; }
yes_if() { "$@" && echo 0 || echo 1; }
probe() { bun "$SKILL/upgrade.ts" 2>>"$RUN_DIR/upgrade-probe.log"; }
pin() { MODE=pin BOARD="$BOARD" probe; }
card() { MODE=card TASK="$1" probe; }
last_event() { MODE=last TASK="$1" probe; }
revision_of() { card "$1" | awk '{print $3}'; }

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi
if ! curl -sf -m 2 "$WEB_URL/" >/dev/null 2>&1; then
  echo "no dashboard at $WEB_URL — run ./up.sh first" >&2
  exit 1
fi
: > "$RUN_DIR/upgrade-probe.log"

HEX="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
REPO="verify-board/upgrade-$HEX"
COLUMNS=(intake specifying planning building review done canceled)

# --- a board on v2, and a card made on it ------------------------------------------------------------
run create board create --repo "$REPO" --definition-version 2 --api "$API_URL"
BOARD="$(sed -n 's/^board  *//p' "$RUN_DIR/upgrade-create.out" | head -1)"
check "board create --definition-version 2 pins default v2" \
  "$([ "$rc" = "0" ] && [ -n "$BOARD" ] && has create "definition  default v2" && echo 0 || echo 1)" "board=${BOARD:-none}"
BOARD="${BOARD:-brd_missing}"
run add-old board add --board "$BOARD" --title "made on v2 ($HEX)" --api "$API_URL"
OLD="$(sed -n 's/^task \(tsk_[0-9a-z]*\) .*/\1/p' "$RUN_DIR/upgrade-add-old.out")"
OLD="${OLD:-tsk_missing}"
run show-old board show --task "$OLD" --api "$API_URL"
check "a card made on it is pinned to v2" \
  "$([ "$rc" = "0" ] && grep -qx 'pinned    v2' "$RUN_DIR/upgrade-show-old.out" && echo 0 || echo 1)" "task=$OLD"
OLD_BEFORE="$(card "$OLD")"

# --- a stale expected version: refused, nothing written ----------------------------------------------
run stale board upgrade --board "$BOARD" --to 3 --expect-version 1 --api "$API_URL"
check "an upgrade at a stale expected version is stale_board_version, non-zero" \
  "$([ "$rc" != "0" ] && [[ "$(first_err stale)" == "error: stale_board_version: board $BOARD is pinned to default v2, not v1"* ]] && echo 0 || echo 1)" \
  "exit=$rc; $(first_err stale)"
check "and writes nothing: the board pins v2, the card is as it was" \
  "$([ "$(pin)" = "2" ] && [ "$(card "$OLD")" = "$OLD_BEFORE" ] && echo 0 || echo 1)" "pin=$(pin); card=$(card "$OLD")"

# --- the upgrade: the pin moves, and only the pin ----------------------------------------------------
run up3 board upgrade --board "$BOARD" --to 3 --expect-version 2 --api "$API_URL"
check "board upgrade --to 3 --expect-version 2 prints the move and the card left on v2" \
  "$([ "$rc" = "0" ] && has up3 "upgraded    $BOARD default v2 → v3" && has up3 'cards       1 card still pins an older version and moves by it' && echo 0 || echo 1)" "exit=$rc"
check "the board pins v3, and the old card's version, revision and history are unchanged" \
  "$([ "$(pin)" = "3" ] && [ "$(card "$OLD")" = "$OLD_BEFORE" ] && echo 0 || echo 1)" "pin=$(pin); card=$(card "$OLD") (was $OLD_BEFORE)"

run add-new board add --board "$BOARD" --title "made on v3 ($HEX)" --api "$API_URL"
NEW="$(sed -n 's/^task \(tsk_[0-9a-z]*\) .*/\1/p' "$RUN_DIR/upgrade-add-new.out")"
NEW="${NEW:-tsk_missing}"
run show-new board show --task "$NEW" --api "$API_URL"
check "a card made after it is pinned to v3" \
  "$([ "$rc" = "0" ] && grep -qx 'pinned    v3' "$RUN_DIR/upgrade-show-new.out" && echo 0 || echo 1)" "task=$NEW"
run ls board ls --board "$BOARD" --api "$API_URL"
check "board ls says the board's cards pin v2 and v3" \
  "$([ "$rc" = "0" ] && has ls "pinned   This board's cards pin more than one version: 1 on v2, 1 on v3 (the board's). Each card moves by the version it pins." && echo 0 || echo 1)" "exit=$rc"

WEB_URL="$WEB_URL" BOARD_ID="$BOARD" MODE=notice EXPECT_VERSIONS="2,3" EVIDENCE_DIR="$EVIDENCE_DIR" \
  node "$SKILL/upgrade.mjs" > "$RUN_DIR/upgrade-web-notice.log" 2>&1
web_rc=$?
check "the board page says the same (upgrade.mjs MODE=notice)" \
  "$([ "$web_rc" = "0" ] && echo 0 || echo 1)" "$(grep -c '^PASS' "$RUN_DIR/upgrade-web-notice.log") PASS, exit=$web_rc"

# --- the verified gate: the new card meets it, the old card does not ---------------------------------
MODE=seat TASK="$OLD" probe >/dev/null
MODE=seat TASK="$NEW" probe >/dev/null
run exit-new board show --task "$NEW" --api "$API_URL"
run exit-old board show --task "$OLD" --api "$API_URL"
check "in review, the new card's exit lists verified and the old card's does not" \
  "$(has exit-new 'leaves    review when' && has exit-new '  verified: unmet' && has exit-old 'leaves    review when' && ! has exit-old '  verified:' && echo 0 || echo 1)" \
  "new: $(grep -c '^  [a-z_]*:' "$RUN_DIR/upgrade-exit-new.out") requirements, old: $(grep -c '^  [a-z_]*:' "$RUN_DIR/upgrade-exit-old.out")"
run done-new board move --task "$NEW" --to done --expect-revision "$(revision_of "$NEW")" --api "$API_URL"
check "the new card's review → done is refused naming verified" \
  "$([ "$rc" != "0" ] && [[ "$(first_err done-new)" == 'error: requirement_unmet: the move review → done needs "verified"'* ]] && echo 0 || echo 1)" \
  "exit=$rc; $(first_err done-new)"
run done-old board move --task "$OLD" --to done --expect-revision "$(revision_of "$OLD")" --api "$API_URL"
check "the old card's is refused naming review_verdict: v2's review, which has no verified" \
  "$([ "$rc" != "0" ] && [[ "$(first_err done-old)" == 'error: requirement_unmet: the move review → done needs "review_verdict"'* ]] && echo 0 || echo 1)" \
  "exit=$rc; $(first_err done-old)"

# --- a refused batch writes nothing ------------------------------------------------------------------
OLD_SEATED="$(card "$OLD")"
NEW_SEATED="$(card "$NEW")"
run refused board upgrade --board "$BOARD" --to 4 --expect-version 3 \
  --map intake=intake --map building=building --api "$API_URL"
check "a mapping that leaves review out is card_migration_refused naming both cards, non-zero" \
  "$([ "$rc" != "0" ] && [[ "$(first_err refused)" == 'error: card_migration_refused: '* ]] && has refused "$OLD (review) is in a column the mapping does not name" && has refused "$NEW (review) is in a column the mapping does not name" && echo 0 || echo 1)" \
  "exit=$rc; $(first_err refused)"
check "and writes nothing: the board pins v3, both cards are as they were" \
  "$([ "$(pin)" = "3" ] && [ "$(card "$OLD")" = "$OLD_SEATED" ] && [ "$(card "$NEW")" = "$NEW_SEATED" ] && echo 0 || echo 1)" \
  "pin=$(pin); old=$(card "$OLD"); new=$(card "$NEW")"

# --- --same-columns: both cards re-pinned, each with its event ---------------------------------------
OLD_REV="$(revision_of "$OLD")"
NEW_REV="$(revision_of "$NEW")"
run up4 board upgrade --board "$BOARD" --to 4 --expect-version 3 --same-columns --api "$API_URL"
check "--same-columns to v4 re-pins both cards and says every card pins v4" \
  "$([ "$rc" = "0" ] && has up4 "upgraded    $BOARD default v3 → v4" && has up4 "repinned    $OLD v2 review → v4 review (revision $((OLD_REV + 1)))" && has up4 "repinned    $NEW v3 review → v4 review (revision $((NEW_REV + 1)))" && has up4 'cards       every card pins v4' && echo 0 || echo 1)" "exit=$rc"
OLD_EVENT="$(last_event "$OLD")"
same_mapping() { # event json: every default column mapped to itself
  local column
  for column in "${COLUMNS[@]}"; do
    printf '%s' "$1" | grep -qF "\"$column\":\"$column\"" || return 1
  done
}
check "the old card's history ends with repinned: v2 → v4, review → review, the mapping, actor cli, at its revision" \
  "$(printf '%s' "$OLD_EVENT" | grep -qF '"kind":"repinned"' && printf '%s' "$OLD_EVENT" | grep -qF '"actor":"cli"' && printf '%s' "$OLD_EVENT" | grep -qF "\"revision\":$OLD_REV," && printf '%s' "$OLD_EVENT" | grep -qF '"fromVersion":2' && printf '%s' "$OLD_EVENT" | grep -qF '"toVersion":4' && same_mapping "$OLD_EVENT" && echo 0 || echo 1)" \
  "$OLD_EVENT"
check "both cards pin v4 at their next revision" \
  "$([ "$(card "$OLD" | awk '{print $1, $3}')" = "4 $((OLD_REV + 1))" ] && [ "$(card "$NEW" | awk '{print $1, $3}')" = "4 $((NEW_REV + 1))" ] && echo 0 || echo 1)" \
  "old=$(card "$OLD"); new=$(card "$NEW")"
run done-migrated board move --task "$OLD" --to done --expect-revision "$(revision_of "$OLD")" --api "$API_URL"
check "the migrated old card's review → done is now refused naming verified" \
  "$([ "$rc" != "0" ] && [[ "$(first_err done-migrated)" == 'error: requirement_unmet: the move review → done needs "verified"'* ]] && echo 0 || echo 1)" \
  "exit=$rc; $(first_err done-migrated)"

# --- the dashboard's Upgrade action: v4 → v5, migrating both ----------------------------------------
NEWEST="$("${FACTORY[@]}" board definition show default --api "$API_URL" 2>/dev/null | sed -n 's/^definition  default v\([0-9]*\).*/\1/p' | head -1)"
TO="${NEWEST:-5}"
if [ "$TO" -le 4 ]; then
  check "default holds a version newer than v4 for the dashboard's upgrade" 1 "newest=v$TO"
else
  WEB_URL="$WEB_URL" BOARD_ID="$BOARD" MODE=upgrade TO_VERSION="$TO" EXPECT_VERSION=4 EVIDENCE_DIR="$EVIDENCE_DIR" \
    node "$SKILL/upgrade.mjs" > "$RUN_DIR/upgrade-web-upgrade.log" 2>&1
  web_rc=$?
  check "the settings page's Upgrade moves the board to v$TO with its cards (upgrade.mjs MODE=upgrade)" \
    "$([ "$web_rc" = "0" ] && echo 0 || echo 1)" "$(grep -c '^PASS' "$RUN_DIR/upgrade-web-upgrade.log") PASS, exit=$web_rc"
  NEW_EVENT="$(last_event "$NEW")"
  check "the board pins v$TO, both cards pin it, each repinned by the dashboard" \
    "$([ "$(pin)" = "$TO" ] && [ "$(card "$OLD" | awk '{print $1}')" = "$TO" ] && [ "$(card "$NEW" | awk '{print $1}')" = "$TO" ] && printf '%s' "$NEW_EVENT" | grep -qF '"kind":"repinned"' && printf '%s' "$NEW_EVENT" | grep -qF '"actor":"dashboard"' && printf '%s' "$NEW_EVENT" | grep -qF "\"toVersion\":$TO" && echo 0 || echo 1)" \
    "pin=$(pin); $NEW_EVENT"
fi

# --- evidence ----------------------------------------------------------------------------------------
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "board": "%s",\n' "$BOARD"
  printf '  "cards": {"old": "%s", "new": "%s"},\n' "$OLD" "$NEW"
  printf '  "checks": {\n'
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/upgrade.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "upgrade: all ${#rows[@]} checks passed — evidence in $EVIDENCE_DIR"
else
  echo "upgrade: FAILURES — see $EVIDENCE_DIR/upgrade.json" >&2
fi
exit "$failed"
