#!/usr/bin/env bash
# The start phase of a card that says what it is for (LOB-260, docs/board.md B1): a card created with
# a markdown body, base ref `release` and an external ref, read back by `factory board show`, then
# started with `factory board start --prompt` the way a person starts one — and the run's own log and
# worktree read back: its prompt carries the body verbatim as `task_body`, and its worktree stands on
# `release`'s commit, not `main`'s. A second card with no body is the control: its run is cut from
# `main` and its prompt has no `task_body` at all.
#
# The fixture checkout ./up.sh registers (.verify/run/board-repo) gets a `release` branch one commit
# ahead of `main` — an empty commit over main's tree, made with `git commit-tree` so the checkout's
# working tree is never touched — re-pointed on every run, so its sha is this run's own.
#
# `factory board add` exists (LOB-261, features/add.md), but `body.ts` still creates both cards over
# the API's `createTask` on purpose: it needs the exact `baseRef` and body, plus a no-body control, as
# one atomic read-back; everything a person reads is a plain subprocess's stdout, as triage.sh.
#
# Requires the instance from ./up.sh (API on API_PORT, default 9400, a seeded board in
# .verify/run/board.json) and DATABASE_URL naming its database, for the run's log read.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
SKILL="$ROOT/.pi/skills/verify-board"
BOARD_REPO="$RUN_DIR/board-repo"
CARD_FILE="$RUN_DIR/body-cards.json"

mkdir -p "$EVIDENCE_DIR" "$RUN_DIR"
rm -f "$EVIDENCE_DIR"/body-*.txt "$EVIDENCE_DIR"/body-*.json "$EVIDENCE_DIR/start-body.json" "$CARD_FILE"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL must name the instance's database (the run's log is read from it)" >&2
  exit 1
fi
if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi
if [ ! -s "$RUN_DIR/board.json" ] || [ ! -d "$BOARD_REPO/.git" ]; then
  echo "no seeded board or fixture checkout in $RUN_DIR — run ./up.sh first" >&2
  exit 1
fi
BOARD_ID="$(sed -n 's/.*"boardId":"\([^"]*\)".*/\1/p' "$RUN_DIR/board.json")"

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
  local out="$EVIDENCE_DIR/body-$1.txt"
  shift
  printf '$ factory %s\n' "$*" > "$out"
  "${FACTORY[@]}" "$@" >> "$out" 2>&1
  rc=$?
}
has() { grep -qxF -- "$2" "$EVIDENCE_DIR/body-$1.txt"; }

probe() { # mode, extra env...
  local mode="$1"
  shift
  env MODE="$mode" API_URL="$API_URL" BOARD_ID="$BOARD_ID" CARD_FILE="$CARD_FILE" \
    EVIDENCE_DIR="$EVIDENCE_DIR" "$@" bun "$SKILL/body.ts" > "$RUN_DIR/body-$mode.log" 2>&1
  local code=$?
  cat "$RUN_DIR/body-$mode.log"
  return "$code"
}

# --- the fixture's `release`: one commit ahead of main, its working tree untouched ---------------
MAIN_SHA="$(git -C "$BOARD_REPO" rev-parse main)"
RELEASE_SHA="$(git -C "$BOARD_REPO" commit-tree "main^{tree}" -p main -m "release cut for verify-board start-body $(date +%s)-$$")"
git -C "$BOARD_REPO" branch -f release "$RELEASE_SHA" >/dev/null
check "the fixture has a release branch one commit ahead of main" \
  "$([ -n "$RELEASE_SHA" ] && [ "$(git -C "$BOARD_REPO" rev-parse release)" = "$RELEASE_SHA" ] && [ "$RELEASE_SHA" != "$MAIN_SHA" ] && echo 0 || echo 1)" \
  "release ${RELEASE_SHA:0:12}, main ${MAIN_SHA:0:12}"

# --- create: the body card and the bare card, over createTask ------------------------------------
probe create
check "body.ts creates both cards and reads them back" "$?" "see body-create.json"
BODY_TASK="$(sed -n 's/.*"bodyTask":"\([^"]*\)".*/\1/p' "$CARD_FILE" 2>/dev/null)"
BARE_TASK="$(sed -n 's/.*"bareTask":"\([^"]*\)".*/\1/p' "$CARD_FILE" 2>/dev/null)"

# --- show: what a person reads about the card -----------------------------------------------------
run show board show --task "${BODY_TASK:-tsk_missing}" --api "$API_URL"
check "board show prints the base ref and the external ref" \
  "$([ "$rc" = "0" ] && has show "base      release" && has show "external  LOB-260" && echo 0 || echo 1)" \
  "exit=$rc"
check "and the body, every line indented as it was filed" \
  "$(has show "body      6 lines" && has show "      ## Goal" && has show "    - keep port 5442" && echo 0 || echo 1)" \
  "$(grep -c '^    ' "$EVIDENCE_DIR/body-show.txt") indented lines"
run show-bare board show --task "${BARE_TASK:-tsk_missing}" --api "$API_URL"
check "the bare card prints a dash for each" \
  "$([ "$rc" = "0" ] && has show-bare "base      -" && has show-bare "external  -" && has show-bare "body      -" && echo 0 || echo 1)" \
  "exit=$rc"

# --- start: both cards, the way a person starts a run -----------------------------------------------
run start board start --task "${BODY_TASK:-tsk_missing}" --prompt "work on this card" --api "$API_URL"
SESSION_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/body-start.txt" | head -1)"
check "board start opens a run on the body card and sends its prompt" \
  "$([ "$rc" = "0" ] && [ -n "$SESSION_ID" ] && has start "task    $BODY_TASK in intake" && has start "sent    work on this card" && echo 0 || echo 1)" \
  "session=${SESSION_ID:-none}"
run start-bare board start --task "${BARE_TASK:-tsk_missing}" --prompt "work on this card" --api "$API_URL"
BARE_SESSION_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/body-start-bare.txt" | head -1)"
check "and one on the bare card" \
  "$([ "$rc" = "0" ] && [ -n "$BARE_SESSION_ID" ] && echo 0 || echo 1)" \
  "session=${BARE_SESSION_ID:-none}"

# --- told: the runs' worktrees and recorded prompts ------------------------------------------------
probe told SESSION_ID="${SESSION_ID:-}" BARE_SESSION_ID="${BARE_SESSION_ID:-}" \
  RELEASE_SHA="$RELEASE_SHA" MAIN_SHA="$MAIN_SHA"
check "the run is cut from release and told the body; the bare one is neither" "$?" "see body-told.json"

{
  printf '{\n  "apiUrl": "%s",\n  "bodyTask": "%s",\n  "bareTask": "%s",\n  "session": "%s",\n  "bareSession": "%s",\n  "releaseSha": "%s",\n  "mainSha": "%s",\n  "checks": {\n' \
    "$API_URL" "${BODY_TASK:-}" "${BARE_TASK:-}" "${SESSION_ID:-}" "${BARE_SESSION_ID:-}" "$RELEASE_SHA" "$MAIN_SHA"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/start-body.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "start-body: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "start-body: FAILURES — see $EVIDENCE_DIR/start-body.json" >&2
fi
exit "$failed"
