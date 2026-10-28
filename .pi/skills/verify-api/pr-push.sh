#!/usr/bin/env bash
# Prove the PR step publishes the branch it names, and the worktree starts at the remote's base
# (C17), through the CLI an operator types: `factory repo add`, `factory run`, `factory pr`.
#
# The forge is two loopback fakes that are one forge: `git-forge-fake.ts` serves bare repositories
# over git's smart HTTP with the real `git http-backend`, refusing any request without the token, and
# `github-fake.ts` runs with `GITHUB_FAKE_GIT_ROOT` at the same repositories, so it refuses a PR whose
# head the git side does not hold — `422`, as GitHub does — and records the head's sha when it opens
# one. Before C17 the step never pushed, and this drive's `factory pr` failed on that `422`.
#
#   ./pr-push.sh
#   PR_PUSH_PORT=9510 PR_PUSH_GITHUB_PORT=9511 PR_PUSH_GIT_PORT=9512 ./pr-push.sh
#
# The repo's default branch is `trunk`, and nothing names a base ref: `repo add` records what the
# forge's `HEAD` says, and `run` cuts from it. The forge's `trunk` moves on after the operator's
# checkout was cloned, so a worktree cut from the checkout's own `trunk` would start one commit
# behind.
#
#   repo add      registers the checkout with the forge URL and no --base-ref; it prints `trunk`
#   run           cuts the worktree at the forge's moved `trunk`, not the checkout's stale one, and
#                 leaves the checkout's own `trunk` where it was
#   pr            pushes `factory/<id>` with the token, then opens the PR onto `trunk`; the forge holds
#                 the worktree's commit, the PR names that sha, and the fake saw no unauthorized push
#   pr (again)    after someone else pushed to `factory/<id>`: on a second session, `non_fast_forward`
#                 and no PR
#
# Env: PR_PUSH_PORT (API, 9440), PR_PUSH_GITHUB_PORT (9441), PR_PUSH_GIT_PORT (9442), DATABASE_URL,
# EVIDENCE_DIR. Evidence: .verify/evidence/latest/api/pr-push.json (every check), pr-push-github.json
# and pr-push-git.json (the fakes' ledgers), pr-push-*.txt (what each CLI call printed) and
# pr-push-api.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${PR_PUSH_PORT:-9440}"
GH_PORT="${PR_PUSH_GITHUB_PORT:-9441}"
GIT_PORT="${PR_PUSH_GIT_PORT:-9442}"
API_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/pr-push"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
GH_LEDGER="$RUN_DIR/github-ledger.json"
GIT_LEDGER="$RUN_DIR/git-ledger.json"
FORGE="$RUN_DIR/forge"
SESSION_ROOT="$RUN_DIR/sessions"
# Never a real token: the fakes are the only things it is sent to.
TOKEN="pr-push-fake-$(date +%s)$$"
SLUG="c17/pr-push-$(date +%s)$$"
BARE="$FORGE/$SLUG.git"
UPSTREAM="$RUN_DIR/upstream"
CHECKOUT="$RUN_DIR/checkout"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
GIT_ENV=(env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  GIT_AUTHOR_NAME=pr-push GIT_AUTHOR_EMAIL=pr-push@localhost
  GIT_COMMITTER_NAME=pr-push GIT_COMMITTER_EMAIL=pr-push@localhost)

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR" "$EVIDENCE_DIR" "$FORGE/c17" "$SESSION_ROOT"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"${3//\"/\'}\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-72s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-72s %s\n' "$1" "$3"
  fi
}
g() { "${GIT_ENV[@]}" git "$@"; }
sha() { g --git-dir "$1" rev-parse --verify --quiet "$2" 2>/dev/null || echo none; }

for port in "$PORT" "$GH_PORT" "$GIT_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set PR_PUSH_PORT / PR_PUSH_GITHUB_PORT / PR_PUSH_GIT_PORT" >&2
    exit 1
  fi
done

stop_pid() {
  [ -f "$1" ] || return 0
  local pid; pid="$(cat "$1")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$1"
}
trap 'stop_pid "$RUN_DIR/api.pid"; stop_pid "$RUN_DIR/github.pid"; stop_pid "$RUN_DIR/git.pid"' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# --- the forge's repository, an upstream that moves it, and the operator's checkout --------------------
g init -q --bare -b trunk "$BARE"
g --git-dir "$BARE" config http.receivepack true
g clone -q "$BARE" "$UPSTREAM" 2>/dev/null
g -C "$UPSTREAM" checkout -q -b trunk
echo seed > "$UPSTREAM/README.md"
g -C "$UPSTREAM" add README.md && g -C "$UPSTREAM" commit -q -m seed
g -C "$UPSTREAM" push -q origin trunk
g clone -q "$BARE" "$CHECKOUT"
STALE="$(sha "$CHECKOUT/.git" refs/heads/trunk)"
echo moved > "$UPSTREAM/UPSTREAM.md"
g -C "$UPSTREAM" add UPSTREAM.md && g -C "$UPSTREAM" commit -q -m "the forge moves on"
g -C "$UPSTREAM" push -q origin trunk
MOVED="$(sha "$BARE" refs/heads/trunk)"

# --- the two fakes --------------------------------------------------------------------------------
( exec env GIT_FORGE_PORT="$GIT_PORT" GIT_FORGE_ROOT="$FORGE" GIT_FORGE_TOKEN="$TOKEN" \
    GIT_FORGE_LEDGER="$GIT_LEDGER" bun "$ROOT/.pi/skills/verify-api/git-forge-fake.ts" ) \
  > "$RUN_DIR/git.log" 2>&1 &
echo $! > "$RUN_DIR/git.pid"
( exec env GITHUB_FAKE_PORT="$GH_PORT" GITHUB_FAKE_LEDGER="$GH_LEDGER" GITHUB_FAKE_GIT_ROOT="$FORGE" \
    bun "$ROOT/.pi/skills/verify-api/github-fake.ts" ) > "$RUN_DIR/github.log" 2>&1 &
echo $! > "$RUN_DIR/github.pid"
for _ in $(seq 1 60); do
  [ -s "$GH_LEDGER" ] && [ -s "$GIT_LEDGER" ] && break
  sleep 0.1
done
[ -s "$GH_LEDGER" ] && [ -s "$GIT_LEDGER" ] || { echo "a fake did not start — see $RUN_DIR/*.log" >&2; exit 1; }

# --- the API, pointed at the fake GitHub, with the token the git fake accepts --------------------------
( cd "$ROOT/apps/api" && exec env \
    -u GITHUB_APP_ID -u GITHUB_APP_PRIVATE_KEY -u GITHUB_APP_INSTALLATION_ID \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    PORT="$PORT" HOST="127.0.0.1" MODEL_BACKEND=faux \
    GITHUB_API_URL="http://127.0.0.1:$GH_PORT" GITHUB_TOKEN="$TOKEN" \
    SESSION_ROOT="$SESSION_ROOT" SESSION_IDLE_TIMEOUT_MS=600000 \
    DATABASE_URL="${DATABASE_URL:?pr-push needs DATABASE_URL from the run}" \
    bun run src/index.ts ) > "$LOG" 2>&1 &
echo $! > "$RUN_DIR/api.pid"
ready=1
for _ in $(seq 1 60); do
  curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && { ready=0; break; }
  sleep 0.5
done
[ "$ready" = "0" ] || { echo "api did not become ready — see $LOG" >&2; exit 1; }

cli() { # evidence-name, args...
  local name="$1"; shift
  "${FACTORY[@]}" "$@" --api "$API_URL" > "$EVIDENCE_DIR/pr-push-$name.txt" 2>&1
  echo $? > "$RUN_DIR/$name.rc"
}
rc() { cat "$RUN_DIR/$1.rc"; }
out() { cat "$EVIDENCE_DIR/pr-push-$1.txt"; }

# --- repo add: no --base-ref -------------------------------------------------------------------------
cli add repo add "$SLUG" --path "$CHECKOUT" --url "http://127.0.0.1:$GIT_PORT/$SLUG.git"
check "repo add exits 0" "$([ "$(rc add)" = 0 ] && echo 0 || echo 1)" "exit=$(rc add)"
check "with no --base-ref it records the forge's default branch, trunk" \
  "$(out add | grep -Eq '^base-ref +trunk$' && echo 0 || echo 1)" "$(out add | grep base-ref)"

# --- run: the worktree is cut at the forge's moved trunk --------------------------------------------
cli run run "pr-push probe" --repo "$SLUG"
SESSION="$(out run | sed -n 's/^session //p' | head -1)"
WORKTREE="$(out run | sed -n 's/^workspace //p' | head -1)"
check "run opens a session on the repo, based on trunk" \
  "$([ -n "$SESSION" ] && out run | grep -q "^repo $SLUG base-ref trunk$" && echo 0 || echo 1)" \
  "session=$SESSION $(out run | grep '^repo ')"
CUT="$(g -C "$WORKTREE" rev-parse HEAD 2>/dev/null || echo none)"
check "the worktree starts at the forge's moved trunk, not the checkout's stale one" \
  "$([ "$CUT" = "$MOVED" ] && [ "$MOVED" != "$STALE" ] && echo 0 || echo 1)" \
  "cut=$CUT moved=$MOVED stale=$STALE"
check "the fetch left the checkout's own trunk where it was, and tracked the forge's under factory/" \
  "$([ "$(sha "$CHECKOUT/.git" refs/heads/trunk)" = "$STALE" ] && [ "$(sha "$CHECKOUT/.git" refs/remotes/factory/trunk)" = "$MOVED" ] && echo 0 || echo 1)" \
  "trunk=$(sha "$CHECKOUT/.git" refs/heads/trunk) factory/trunk=$(sha "$CHECKOUT/.git" refs/remotes/factory/trunk)"

# --- pr: push, then open ---------------------------------------------------------------------------
echo change > "$WORKTREE/CHANGE.md"
g -C "$WORKTREE" add CHANGE.md && g -C "$WORKTREE" commit -q -m "the run's change"
TIP="$(g -C "$WORKTREE" rev-parse HEAD)"
cli pr pr "$SESSION" --title "factory: pr-push probe"
check "factory pr exits 0 and prints the opened PR" \
  "$([ "$(rc pr)" = 0 ] && out pr | grep -Eq '^outcome +opened$' && echo 0 || echo 1)" \
  "exit=$(rc pr) $(out pr | tr '\n' ' ')"
check "the forge holds factory/<id> at the worktree's commit" \
  "$([ "$(sha "$BARE" "refs/heads/factory/$SESSION")" = "$TIP" ] && echo 0 || echo 1)" \
  "forge=$(sha "$BARE" "refs/heads/factory/$SESSION") tip=$TIP"
PULL="$(bun -e '
  const ledger = await Bun.file(process.argv[1]).json();
  const pull = ledger.pulls.find((p) => p.head === process.argv[2]);
  console.log(pull === undefined ? "none" : `${pull.head} ${pull.base} ${pull.headSha ?? "nosha"}`);
' "$GH_LEDGER" "factory/$SESSION")"
check "the PR names factory/<id> onto trunk, and the sha the forge held when it opened is the tip" \
  "$([ "$PULL" = "factory/$SESSION trunk $TIP" ] && echo 0 || echo 1)" "$PULL"
PUSHES="$(bun -e '
  const ledger = await Bun.file(process.argv[1]).json();
  const sent = ledger.requests.filter((r) => r.credential !== "none");
  const pushed = sent.filter((r) => r.method === "POST" && r.service === "git-receive-pack");
  console.log(`${pushed.filter((r) => r.credential === "token").length} ${sent.filter((r) => r.credential !== "token").length}`);
' "$GIT_LEDGER")"
check "the push reached the forge with the provider's token, and no other credential was ever sent" \
  "$([ "${PUSHES%% *}" -gt 0 ] && [ "${PUSHES##* }" = 0 ] && echo 0 || echo 1)" "token-pushes other-credentials=$PUSHES"

# --- a branch the forge would not take ---------------------------------------------------------------
cli run2 run "pr-push probe two" --repo "$SLUG"
SESSION2="$(out run2 | sed -n 's/^session //p' | head -1)"
WORKTREE2="$(out run2 | sed -n 's/^workspace //p' | head -1)"
echo mine > "$WORKTREE2/MINE.md"
g -C "$WORKTREE2" add MINE.md && g -C "$WORKTREE2" commit -q -m mine
g -C "$UPSTREAM" checkout -q -b "factory/$SESSION2"
echo theirs > "$UPSTREAM/THEIRS.md"
g -C "$UPSTREAM" add THEIRS.md && g -C "$UPSTREAM" commit -q -m theirs
g -C "$UPSTREAM" push -q origin "factory/$SESSION2"
THEIRS="$(sha "$BARE" "refs/heads/factory/$SESSION2")"
cli rejected pr "$SESSION2" --title "factory: rejected"
check "a remote branch that moved past the session's is non_fast_forward, exit non-zero" \
  "$([ "$(rc rejected)" != 0 ] && out rejected | grep -q non_fast_forward && echo 0 || echo 1)" \
  "exit=$(rc rejected) $(out rejected | tr '\n' ' ')"
OPENED2="$(bun -e '
  const ledger = await Bun.file(process.argv[1]).json();
  console.log(ledger.requests.filter((r) => r.method === "POST" && r.body?.head === process.argv[2]).length);
' "$GH_LEDGER" "factory/$SESSION2")"
check "and GitHub was never asked, and the forge's branch was not forced" \
  "$([ "$OPENED2" = 0 ] && [ "$(sha "$BARE" "refs/heads/factory/$SESSION2")" = "$THEIRS" ] && echo 0 || echo 1)" \
  "creates=$OPENED2 forge=$(sha "$BARE" "refs/heads/factory/$SESSION2") theirs=$THEIRS"
check "no line of the API's log, nor any CLI output, carries the token" \
  "$(! grep -rqF "$TOKEN" "$LOG" "$EVIDENCE_DIR"/pr-push-*.txt && echo 0 || echo 1)" "grep -F token"

cp "$GH_LEDGER" "$EVIDENCE_DIR/pr-push-github.json"
cp "$GIT_LEDGER" "$EVIDENCE_DIR/pr-push-git.json"
cp "$LOG" "$EVIDENCE_DIR/pr-push-api.log"
{
  printf '{\n  "repo": "%s",\n  "session": "%s",\n  "checks": {\n' "$SLUG" "$SESSION"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/pr-push.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "pr-push: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "pr-push: FAILURES — see $EVIDENCE_DIR/pr-push.json" >&2
fi
exit "$failed"
