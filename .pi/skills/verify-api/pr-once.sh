#!/usr/bin/env bash
# Prove one PR across a kill between the call and its acknowledgement (LOB-179).
#
# The window this closes: a process that dies *after* GitHub created the PR but *before* its
# acknowledgement was committed leaves nothing local that remembers the PR — the `factory.pr`
# document was never written — so the retry has no record to read. GitHub, asked again, refuses the
# duplicate, and the client has to answer with the PR that already exists. That is what the replayed
# step does here, against a loopback fake, with the ledger on disk as the witness.
#
# The script owns everything it starts — its own fake on its own port, its own session root, its own
# driver processes — because the point of one phase is to kill it. It never touches the instance
# ./up.sh started, and it leaves nothing running.
#
#   ./pr-once.sh
#
# Env: PR_ONCE_PORT (9411), PR_ONCE_DB (a database name to use on the run's server), DATABASE_URL,
# PR_ONCE_REPO, EVIDENCE_DIR. The run's `DATABASE_URL` is what the driver connects with; the session
# root is a throwaway git repo whose origin is a local bare repository, so no git call can reach a
# real remote (LOB-94).
#
# What the fake cannot prove: that GitHub really answers 422 for a duplicate head, or that its
# lookup query is spelled the way this fake accepts. The request shape is asserted in
# `packages/core/src/pr.test.ts`; the fake is only as right as that contract.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${PR_ONCE_PORT:-9411}"
GH_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/pr-once"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
STATE="$RUN_DIR/session-id"
LEDGER="$RUN_DIR/github-ledger.json"
SESSION_ROOT="$RUN_DIR/sessions"
ORIGIN_DIR="$RUN_DIR/origin.git"
DRIVER="$ROOT/.pi/skills/verify-api/pr-once.ts"
FAKE="$ROOT/.pi/skills/verify-api/github-fake.ts"
REPO="${PR_ONCE_REPO:-lobiklukas/factory}"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR" "$SESSION_ROOT"
rm -f "$STATE" "$LEDGER"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-58s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-58s %s\n' "$1" "$3"
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

# A count out of the ledger: `posts` (requests the client made), `gets`, or `pulls` (PRs that exist).
ledger_count() {
  bun -e '
    const ledger = await Bun.file(process.argv[1]).json();
    const kind = process.argv[2];
    const out =
      kind === "posts"
        ? ledger.requests.filter((request) => request.method === "POST").length
        : kind === "gets"
          ? ledger.requests.filter((request) => request.method === "GET").length
          : ledger.pulls.length;
    console.log(out);
  ' "$LEDGER" "$1" 2>/dev/null || echo "0"
}

stop_fake() {
  [ -f "$RUN_DIR/fake.pid" ] || return 0
  local pid; pid="$(cat "$RUN_DIR/fake.pid")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$RUN_DIR/fake.pid"
}

trap 'stop_fake' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# The session root the service opens workspaces under: a real git repo with a local origin.
if [ ! -d "$SESSION_ROOT/.git" ]; then
  rm -rf "$SESSION_ROOT" "$ORIGIN_DIR"
  mkdir -p "$SESSION_ROOT"
  git init -q -b main "$SESSION_ROOT"
  git -C "$SESSION_ROOT" config user.email pr-once@localhost
  git -C "$SESSION_ROOT" config user.name "pr-once"
  git -C "$SESSION_ROOT" commit -q --allow-empty -m "pr-once session root"
  git init -q -b main --bare "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" remote add origin "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" push -q origin main
fi

# --- the fake, holding the first create request open ----------------------------------------------
: > "$RUN_DIR/fake.log"
( exec env \
    GITHUB_FAKE_PORT="$PORT" \
    GITHUB_FAKE_LEDGER="$LEDGER" \
    GITHUB_FAKE_HANG_FIRST=1 \
    bun "$FAKE" ) >> "$RUN_DIR/fake.log" 2>&1 &
echo $! > "$RUN_DIR/fake.pid"
for _ in $(seq 1 60); do
  [ -s "$LEDGER" ] && break
  sleep 0.1
done
if [ ! -s "$LEDGER" ]; then
  echo "the fake GitHub did not start — see $RUN_DIR/fake.log" >&2
  exit 1
fi

# Every driver process talks to the fake, not to github.com, and to the run's database.
driver_env=( env
  GITHUB_API_URL="$GH_URL"
  PR_ONCE_STATE="$STATE"
  SESSION_ROOT="$SESSION_ROOT"
  PR_ONCE_REPO="$REPO"
  EVIDENCE_DIR="$EVIDENCE_DIR"
  DATABASE_URL="${DATABASE_URL:?pr-once needs DATABASE_URL from the run}" )

# --- arm: a step inside its GitHub call, then a kill ----------------------------------------------
"${driver_env[@]}" MODE=arm bun "$DRIVER" > "$RUN_DIR/arm.log" 2>&1 &
ARM_PID=$!

for _ in $(seq 1 300); do
  [ "$(ledger_count posts)" -ge 1 ] && break
  sleep 0.1
done
POSTS_ARMED="$(ledger_count posts)"
if [ "$POSTS_ARMED" -lt 1 ]; then
  echo "the arm phase never reached GitHub — see $RUN_DIR/arm.log and $RUN_DIR/fake.log" >&2
  kill -9 "$ARM_PID" 2>/dev/null || true
  exit 1
fi
if [ ! -s "$STATE" ]; then
  echo "the arm phase never wrote its session id — see $RUN_DIR/arm.log" >&2
  kill -9 "$ARM_PID" 2>/dev/null || true
  exit 1
fi
SESSION_ID="$(cat "$STATE")"
# SIGKILL, not SIGTERM: a graceful shutdown could still commit the acknowledgement, which is the
# window this script exists to prove closed.
kill -9 "$ARM_PID" 2>/dev/null || true
wait "$ARM_PID" 2>/dev/null || true

check "the kill landed after the request and before its acknowledgement" \
  "$([ "$POSTS_ARMED" = "1" ] && [ "$(ledger_count pulls)" = "1" ] && echo 0 || echo 1)" \
  "posts=$POSTS_ARMED prs=$(ledger_count pulls) session=$SESSION_ID"

# --- reopen: a fresh process replays the step ------------------------------------------------------
"${driver_env[@]}" MODE=reopen bun "$DRIVER" > "$RUN_DIR/reopen.log" 2>&1
REOPEN_RC=$?
cat "$RUN_DIR/reopen.log"
check "the replayed step passes its checks" \
  "$([ "$REOPEN_RC" = "0" ] && echo 0 || echo 1)" "exit=$REOPEN_RC"

POSTS_AFTER_REOPEN="$(ledger_count posts)"
# The replay *must* reach GitHub: the killed process never committed its record, so this is the
# window itself — one create that GitHub refuses, one adopted PR, and the repeat inside the same
# process adds nothing on top of that (which is why the count is 2 and not 3).
check "the replayed step asks GitHub once and creates nothing new" \
  "$([ "$POSTS_AFTER_REOPEN" = "2" ] && [ "$(ledger_count pulls)" = "1" ] && echo 0 || echo 1)" \
  "posts=$POSTS_AFTER_REOPEN prs=$(ledger_count pulls) (2 = the killed attempt + the replay)"
check "the repeat inside that process reads the record and makes no create call" \
  "$([ "$POSTS_AFTER_REOPEN" -le 2 ] && echo 0 || echo 1)" \
  "posts=$POSTS_AFTER_REOPEN after three step calls in one process"

# --- the negative control: the call the step makes with its guard removed ---------------------------
"${driver_env[@]}" MODE=unguarded bun "$DRIVER" > "$RUN_DIR/unguarded.log" 2>&1
UNGUARDED_RC=$?
cat "$RUN_DIR/unguarded.log"
check "the unguarded call passes its own checks (it adopts the same PR)" \
  "$([ "$UNGUARDED_RC" = "0" ] && echo 0 || echo 1)" "exit=$UNGUARDED_RC"
# One more create, and still one PR: the call the step would make with its recorded-document read
# removed reaches GitHub again. That extra POST is exactly what the two checks above would see, so
# this proves those checks are not vacuous.
check "removing the guard does reach GitHub again: the checks above are not vacuous" \
  "$([ "$(ledger_count posts)" = "3" ] && [ "$(ledger_count pulls)" = "1" ] && echo 0 || echo 1)" \
  "posts=$(ledger_count posts) prs=$(ledger_count pulls) (3 = the killed attempt + the replay + the unguarded call)"

# --- a genuinely second session --------------------------------------------------------------------
"${driver_env[@]}" MODE=second bun "$DRIVER" > "$RUN_DIR/second.log" 2>&1
SECOND_RC=$?
cat "$RUN_DIR/second.log"
check "a second session passes its checks" \
  "$([ "$SECOND_RC" = "0" ] && echo 0 || echo 1)" "exit=$SECOND_RC"
check "a second session opens a second PR" \
  "$([ "$(ledger_count pulls)" = "2" ] && echo 0 || echo 1)" \
  "prs=$(ledger_count pulls) posts=$(ledger_count posts)"

cp "$LEDGER" "$EVIDENCE_DIR/pr-once-ledger.json" 2>/dev/null || true
{
  printf '{\n'
  printf '  "githubUrl": "%s",\n' "$GH_URL"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "posts": %s,\n' "$(ledger_count posts)"
  printf '  "pulls": %s,\n' "$(ledger_count pulls)"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/pr-once-process.json"
cp "$RUN_DIR/fake.log" "$EVIDENCE_DIR/pr-once-fake.log"

echo
if [ "$failed" -eq 0 ]; then
  echo "pr-once: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "pr-once: FAILURES — see $EVIDENCE_DIR/pr-once-process.json" >&2
fi
exit "$failed"
