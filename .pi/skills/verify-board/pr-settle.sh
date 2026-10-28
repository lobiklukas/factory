#!/usr/bin/env bash
# Prove a card run's PR follows its branch across settles and across a killed process (F14, F16),
# through the CLI an operator types and against a forge that is real git.
#
#   F16  a boot settles what no process saw: a card's building run settles, its settle-time PR step
#        pushes the branch and is inside its GitHub call (the fake holds the first create open) when
#        the API is SIGKILLed. On restart the boot's sweep takes the step it was owed: the PR is the
#        one GitHub already holds (the create is refused as a duplicate and adopted), the API log
#        names the session among the boot's settled PR steps, and `factory pr` answers it
#        `already-open`. A second restart steps nothing more.
#   F14  a settled session pushes later commits to its open PR: a commit made by hand on the run's
#        branch is not on the PR, so `board move --to review` is refused naming `pr_link`; the same
#        session sent another message commits again and settles, and its settle pushes the new tip —
#        the forge's `factory/<id>` moves to the worktree's commit, fast-forward, GitHub is asked for
#        no new PR, and the transcript says `pushed <sha> to <pr>`. `factory pr` then reaches no forge
#        at all (`already-open`, no git request, no GitHub request), and the move goes through.
#        Last, someone else pushes to the PR's branch and the session commits again: its settle is
#        refused `non-fast-forward`, the forge's branch keeps their commit, the transcript says the
#        PR step pushed nothing to the PR, and the card keeps its PR.
#
# The forge is the two loopback fakes `verify-api/pr-push.sh` uses, as one forge: `git-forge-fake.ts`
# serves bare repositories with the real `git http-backend`, refusing any request without the
# token, and `github-fake.ts` runs with `GITHUB_FAKE_GIT_ROOT` at the same repositories, so it refuses
# a PR whose head the git side does not hold. Nothing reaches github.com, and the token is minted for
# this run.
#
# Not ./up.sh's instance: this script starts and stops its own API, fakes, session root and fixture,
# and leaves nothing running.
#
#   ./pr-settle.sh
#   PR_SETTLE_PORT=9510 PR_SETTLE_GITHUB_PORT=9511 PR_SETTLE_GIT_PORT=9512 ./pr-settle.sh
#
# Env: PR_SETTLE_PORT (API, 9405), PR_SETTLE_GITHUB_PORT (9406), PR_SETTLE_GIT_PORT (9408),
# DATABASE_URL, EVIDENCE_DIR. Evidence: .verify/evidence/latest/board/pr-settle.json (every check),
# pr-settle-github.json and pr-settle-git.json (the fakes' ledgers), pr-settle-*.txt (each CLI
# call's output), pr-settle-api.log.
set -uo pipefail

# Auth off, as every board drive runs its API (LOB-20).
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${PR_SETTLE_PORT:-9405}"
GH_PORT="${PR_SETTLE_GITHUB_PORT:-9406}"
GIT_PORT="${PR_SETTLE_GIT_PORT:-9408}"
API_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/pr-settle"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
LOG="$RUN_DIR/api.log"
GH_LEDGER="$RUN_DIR/github-ledger.json"
GIT_LEDGER="$RUN_DIR/git-ledger.json"
FORGE="$RUN_DIR/forge"
SESSION_ROOT="$RUN_DIR/sessions"
PROBE="$ROOT/.pi/skills/verify-board/pr-settle.ts"
# Never a real token: the fakes are the only things it is sent to.
TOKEN="pr-settle-fake-$(date +%s)$$"
SLUG="f16/pr-settle-$(date +%s)$$"
BARE="$FORGE/$SLUG.git"
UPSTREAM="$RUN_DIR/upstream"
CHECKOUT="$RUN_DIR/checkout"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
GIT_ENV=(env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  GIT_AUTHOR_NAME=pr-settle GIT_AUTHOR_EMAIL=pr-settle@localhost
  GIT_COMMITTER_NAME=pr-settle GIT_COMMITTER_EMAIL=pr-settle@localhost)
# Every run commits one more line on its branch (FAUX_EVERY_TURN: every message's turn runs it, not
# only the session's first), so each settle has a commit of its own.
FAUX_COMMAND="echo run >> work.txt && git add work.txt && git -c user.email=builder@localhost -c user.name=builder commit -q -m 'the run' && echo built"
DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
export DATABASE_URL

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR" "$EVIDENCE_DIR" "$FORGE/f16" "$SESSION_ROOT"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"${3//\"/\'}\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-76s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-76s %s\n' "$1" "$3"
  fi
}
g() { "${GIT_ENV[@]}" git "$@"; }
sha() { g --git-dir "$1" rev-parse --verify --quiet "$2" 2>/dev/null || echo none; }
yes_if() { if eval "$1"; then echo 0; else echo 1; fi; }

for port in "$PORT" "$GH_PORT" "$GIT_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set PR_SETTLE_PORT / PR_SETTLE_GITHUB_PORT / PR_SETTLE_GIT_PORT" >&2
    exit 1
  fi
done

stop_pid() { # pidfile [signal]
  [ -f "$1" ] || return 0
  local pid; pid="$(cat "$1")"
  kill "-${2:-TERM}" "$pid" 2>/dev/null || true
  for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$1"
}
trap 'stop_pid "$RUN_DIR/api.pid"; stop_pid "$RUN_DIR/github.pid"; stop_pid "$RUN_DIR/git.pid"' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# --- the forge's repository, an upstream clone that can move it, and the operator's checkout ---------
g init -q --bare -b main "$BARE"
g --git-dir "$BARE" config http.receivepack true
g clone -q "$BARE" "$UPSTREAM" 2>/dev/null
g -C "$UPSTREAM" checkout -q -b main
echo seed > "$UPSTREAM/README.md"
g -C "$UPSTREAM" add README.md && g -C "$UPSTREAM" commit -q -m seed
g -C "$UPSTREAM" push -q origin main
g clone -q "$BARE" "$CHECKOUT"

# --- the two fakes: the first PR create is held open, the window the kill lands in -----------------
( exec env GIT_FORGE_PORT="$GIT_PORT" GIT_FORGE_ROOT="$FORGE" GIT_FORGE_TOKEN="$TOKEN" \
    GIT_FORGE_LEDGER="$GIT_LEDGER" bun "$ROOT/.pi/skills/verify-api/git-forge-fake.ts" ) \
  > "$RUN_DIR/git.log" 2>&1 &
echo $! > "$RUN_DIR/git.pid"
( exec env GITHUB_FAKE_PORT="$GH_PORT" GITHUB_FAKE_LEDGER="$GH_LEDGER" GITHUB_FAKE_GIT_ROOT="$FORGE" \
    GITHUB_FAKE_HANG_FIRST=1 bun "$ROOT/.pi/skills/verify-api/github-fake.ts" ) \
  > "$RUN_DIR/github.log" 2>&1 &
echo $! > "$RUN_DIR/github.pid"
for _ in $(seq 1 60); do
  [ -s "$GH_LEDGER" ] && [ -s "$GIT_LEDGER" ] && break
  sleep 0.1
done
[ -s "$GH_LEDGER" ] && [ -s "$GIT_LEDGER" ] || { echo "a fake did not start — see $RUN_DIR/*.log" >&2; exit 1; }

start_api() { # one process over the same database and session root
  ( cd "$ROOT/apps/api" && exec env \
      -u GITHUB_APP_ID -u GITHUB_APP_PRIVATE_KEY -u GITHUB_APP_INSTALLATION_ID \
      -u GITHUB_REVIEWER_TOKEN -u GITHUB_REVIEWER_APP_ID -u GITHUB_REVIEWER_APP_PRIVATE_KEY \
      -u GITHUB_REVIEWER_APP_INSTALLATION_ID \
      GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
      PORT="$PORT" HOST="127.0.0.1" MODEL_BACKEND=faux FAUX_COMMAND="$FAUX_COMMAND" FAUX_EVERY_TURN=true \
      GITHUB_API_URL="http://127.0.0.1:$GH_PORT" GITHUB_TOKEN="$TOKEN" \
      SESSION_ROOT="$SESSION_ROOT" SESSION_IDLE_TIMEOUT_MS=600000 \
      DATABASE_URL="$DATABASE_URL" \
      bun run src/index.ts ) >> "$LOG" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
  for _ in $(seq 1 60); do
    curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "api did not become ready — see $LOG" >&2
  exit 1
}

cli() { # evidence-name, args...
  local name="$1"; shift
  "${FACTORY[@]}" "$@" --api "$API_URL" > "$EVIDENCE_DIR/pr-settle-$name.txt" 2>&1
  echo $? > "$RUN_DIR/$name.rc"
}
rc() { cat "$RUN_DIR/$1.rc"; }
out() { cat "$EVIDENCE_DIR/pr-settle-$1.txt"; }
probe() { # evidence-name, env...
  local name="$1"; shift
  env API_URL="$API_URL" "$@" bun "$PROBE" > "$EVIDENCE_DIR/pr-settle-$name.txt" 2>"$RUN_DIR/$name.err"
  echo $? > "$RUN_DIR/$name.rc"
}
field() { # evidence-name, key: a string or null field of a probe's JSON line
  bun -e 'const v = JSON.parse(await Bun.file(process.argv[1]).text())[process.argv[2]]; console.log(v === undefined || v === null ? "none" : typeof v === "string" ? v : JSON.stringify(v));' \
    "$EVIDENCE_DIR/pr-settle-$1.txt" "$2" 2>/dev/null || echo none
}
gh_count() { # what: creates | pulls, head
  bun -e '
    const ledger = await Bun.file(process.argv[1]).json();
    const [what, head] = [process.argv[2], process.argv[3]];
    console.log(what === "pulls"
      ? ledger.pulls.filter((p) => p.head === head).length
      : ledger.requests.filter((r) => r.method === "POST" && r.body?.head === head).length);
  ' "$GH_LEDGER" "$1" "$2"
}
requests() { # ledger: how many requests it holds
  bun -e 'console.log((await Bun.file(process.argv[1]).json()).requests.length)' "$1"
}

start_api

# --- F16: the API dies inside the settled run's PR step ---------------------------------------------
cli add repo add "$SLUG" --path "$CHECKOUT" --url "http://127.0.0.1:$GIT_PORT/$SLUG.git"
check "repo add registers the checkout with the loopback forge" "$(rc add)" "exit=$(rc add)"
probe seed MODE=seed REPO="$SLUG"
TASK_ID="$(field seed taskId)"
check "a card is seeded in building" "$(yes_if '[ "$(rc seed)" = 0 ] && [ "$TASK_ID" != none ]')" "task=$TASK_ID"
cli start board start --task "$TASK_ID" --prompt "build this card"
SESSION="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/pr-settle-start.txt" | head -1)"
check "board start opens the building run" "$(yes_if '[ "$(rc start)" = 0 ] && [ -n "$SESSION" ]')" "session=${SESSION:-none}"
HEAD="factory/$SESSION"
for _ in $(seq 1 300); do
  [ "$(gh_count creates "$HEAD")" -ge 1 ] && break
  sleep 0.2
done
check "the run settled and its step pushed, then asked GitHub for the PR (held open)" \
  "$(yes_if '[ "$(gh_count creates "$HEAD")" = 1 ] && [ "$(sha "$BARE" "refs/heads/$HEAD")" != none ]')" \
  "creates=$(gh_count creates "$HEAD") forge=$(sha "$BARE" "refs/heads/$HEAD")"
stop_pid "$RUN_DIR/api.pid" KILL
probe killed MODE=record SESSION_ID="$SESSION"
check "the SIGKILL left the session with no factory.pr record" \
  "$(yes_if '[ "$(rc killed)" = 0 ] && [ "$(field killed url)" = none ]')" "$(out killed)"

start_api
for _ in $(seq 1 150); do
  probe booted MODE=record SESSION_ID="$SESSION"
  [ "$(field booted url)" != none ] && break
  sleep 0.2
done
PR_URL="$(field booted url)"
TIP1="$(field booted commit)"
check "the next boot took the step it was owed: the session records the PR" \
  "$(yes_if '[ "$PR_URL" != none ] && [ "$TIP1" = "$(sha "$BARE" "refs/heads/$HEAD")" ]')" \
  "pr=$PR_URL commit=$TIP1"
check "the boot's log names the session among its settled PR steps" \
  "$(yes_if 'grep -q "settled PR steps: resumed [0-9]* in flight: .*$SESSION" "$LOG"')" \
  "$(grep -o 'settled PR steps: [^"]*' "$LOG" | tail -1 | cut -c1-120)"
check "and the PR opened once: GitHub holds one PR for the head" \
  "$(yes_if '[ "$(gh_count pulls "$HEAD")" = 1 ]')" "pulls=$(gh_count pulls "$HEAD") creates=$(gh_count creates "$HEAD")"
cli pr1 pr "$SESSION" --title "factory: pr-settle"
check "factory pr answers that PR, already-open" \
  "$(yes_if '[ "$(rc pr1)" = 0 ] && out pr1 | grep -Eq "^outcome +already-open$" && out pr1 | grep -qF "$PR_URL"')" \
  "exit=$(rc pr1) $(out pr1 | tr '\n' ' ')"

CREATES="$(gh_count creates "$HEAD")"
BOOTS="$(grep -c "settled PR steps:" "$LOG")"
stop_pid "$RUN_DIR/api.pid"
start_api
for _ in $(seq 1 100); do
  [ "$(grep -c "settled PR steps:" "$LOG")" -gt "$BOOTS" ] && break
  sleep 0.2
done
check "a second boot steps nothing more for it" \
  "$(yes_if '[ "$(grep -c "settled PR steps:" "$LOG")" -gt "$BOOTS" ] && [ "$(gh_count creates "$HEAD")" = "$CREATES" ] && ! grep "settled PR steps:" "$LOG" | tail -1 | grep -q "$SESSION"')" \
  "creates=$(gh_count creates "$HEAD") $(grep -o 'settled PR steps: [^"]*' "$LOG" | tail -1 | cut -c1-80)"

# --- F14: later commits reach the open PR ----------------------------------------------------------
probe where MODE=wait SESSION_ID="$SESSION"
WORKTREE="$(field where worktree)"
echo "by hand" >> "$WORKTREE/work.txt"
g -C "$WORKTREE" add work.txt && g -C "$WORKTREE" commit -q -m "by hand"
revision() { # the card's revision, as `board show` prints it
  "${FACTORY[@]}" board show --task "$TASK_ID" --api "$API_URL" 2>/dev/null | sed -n 's/^revision  *\([0-9]*\)$/\1/p'
}
cli refused board move --task "$TASK_ID" --to review --expect-revision "$(revision)"
check "a commit the PR does not carry: building → review is refused naming pr_link" \
  "$(yes_if '[ "$(rc refused)" != 0 ] && out refused | grep -q "pr_link" && out refused | grep -q "where that PR was published"')" \
  "exit=$(rc refused) $(head -1 "$EVIDENCE_DIR/pr-settle-refused.txt" | cut -c1-140)"

cli send send "$SESSION" "and once more"
probe again MODE=wait SESSION_ID="$SESSION" ANSWERS=2 UNTIL="pushed "
TIP2="$(g -C "$WORKTREE" rev-parse HEAD)"
check "the session's next settle pushed the new tip: the forge's branch is the worktree's commit" \
  "$(yes_if '[ "$(rc again)" = 0 ] && [ "$(sha "$BARE" "refs/heads/$HEAD")" = "$TIP2" ] && [ "$TIP2" != "$TIP1" ]')" \
  "forge=$(sha "$BARE" "refs/heads/$HEAD") tip=$TIP2"
check "fast-forward: the PR's earlier commit is an ancestor of the new tip" \
  "$(yes_if 'g --git-dir "$BARE" merge-base --is-ancestor "$TIP1" "$TIP2"')" "$TIP1 ⊂ $TIP2"
check "the transcript says the PR was updated, and GitHub was asked for no new PR" \
  "$(yes_if 'out again | grep -qF "pushed ${TIP2:0:12} to $PR_URL" && [ "$(gh_count creates "$HEAD")" = "$CREATES" ] && [ "$(gh_count pulls "$HEAD")" = 1 ]')" \
  "creates=$(gh_count creates "$HEAD") pulls=$(gh_count pulls "$HEAD")"
probe moved MODE=record SESSION_ID="$SESSION"
check "the record moved to the new tip" "$(yes_if '[ "$(field moved commit)" = "$TIP2" ]')" "commit=$(field moved commit)"

GIT_BEFORE="$(requests "$GIT_LEDGER")"
GH_BEFORE="$(requests "$GH_LEDGER")"
cli pr2 pr "$SESSION" --title "factory: pr-settle"
check "with no new commit, factory pr answers already-open and reaches no forge" \
  "$(yes_if '[ "$(rc pr2)" = 0 ] && out pr2 | grep -Eq "^outcome +already-open$" && [ "$(requests "$GIT_LEDGER")" = "$GIT_BEFORE" ] && [ "$(requests "$GH_LEDGER")" = "$GH_BEFORE" ]')" \
  "exit=$(rc pr2) git=$GIT_BEFORE→$(requests "$GIT_LEDGER") github=$GH_BEFORE→$(requests "$GH_LEDGER")"
cli review board move --task "$TASK_ID" --to review --expect-revision "$(revision)"
check "at the published tip, building → review goes through" \
  "$(yes_if '[ "$(rc review)" = 0 ] && out review | grep -q "moved $TASK_ID to review"')" \
  "exit=$(rc review) $(head -1 "$EVIDENCE_DIR/pr-settle-review.txt")"

# Someone else pushes to the PR's branch; the session commits again on its own.
g -C "$UPSTREAM" fetch -q origin "$HEAD"
g -C "$UPSTREAM" checkout -q -b "$HEAD" "origin/$HEAD"
echo theirs > "$UPSTREAM/THEIRS.md"
g -C "$UPSTREAM" add THEIRS.md && g -C "$UPSTREAM" commit -q -m theirs
g -C "$UPSTREAM" push -q origin "$HEAD"
THEIRS="$(sha "$BARE" "refs/heads/$HEAD")"
cli send2 send "$SESSION" "one more"
probe diverged MODE=wait SESSION_ID="$SESSION" ANSWERS=3 UNTIL="pushed nothing to"
check "a diverged remote: the settle is refused non-fast-forward, naming the PR it left as it was" \
  "$(yes_if '[ "$(rc diverged)" = 0 ] && out diverged | grep -qF "pushed nothing to $PR_URL: the remote" && out diverged | grep -q "push is never forced"')" \
  "exit=$(rc diverged)"
check "and nothing was forced: the forge's branch keeps their commit, the PR stays the card's" \
  "$(yes_if '[ "$(sha "$BARE" "refs/heads/$HEAD")" = "$THEIRS" ] && [ "$(field diverged prUrl)" = "$PR_URL" ]')" \
  "forge=$(sha "$BARE" "refs/heads/$HEAD") theirs=$THEIRS pr=$(field diverged prUrl)"
cli pr3 pr "$SESSION" --title "factory: pr-settle"
check "factory pr says non_fast_forward too, exit non-zero, naming the PR it pushed nothing to" \
  "$(yes_if '[ "$(rc pr3)" != 0 ] && out pr3 | grep -q non_fast_forward && out pr3 | grep -qF "Nothing was pushed to $PR_URL" && ! out pr3 | grep -qi "no PR was opened"')" "exit=$(rc pr3)"
check "no line of the API's log, nor any CLI output, carries the token" \
  "$(yes_if '! grep -rqF "$TOKEN" "$LOG" "$EVIDENCE_DIR"/pr-settle-*.txt')" "grep -F token"

cp "$GH_LEDGER" "$EVIDENCE_DIR/pr-settle-github.json"
cp "$GIT_LEDGER" "$EVIDENCE_DIR/pr-settle-git.json"
cp "$LOG" "$EVIDENCE_DIR/pr-settle-api.log"
{
  printf '{\n  "repo": "%s",\n  "session": "%s",\n  "task": "%s",\n  "checks": {\n' "$SLUG" "$SESSION" "$TASK_ID"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/pr-settle.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "pr-settle: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "pr-settle: FAILURES — see $EVIDENCE_DIR/pr-settle.json" >&2
fi
exit "$failed"
