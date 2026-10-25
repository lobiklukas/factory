#!/usr/bin/env bash
# Prove a docs run starts without a person (LOB-197, part 3 of LOB-37).
#
# The claim: a GitHub `push` to the default branch starts exactly one docs session on a
# `factory/doc-<delivery id>` branch (and a redelivery starts none), the interval schedule starts one
# per interval and none when disabled, and nothing the run does writes the default branch — the
# ledger of a loopback GitHub fake is where that last one is counted rather than asserted.
#
# Everything but GitHub and the model is real: the seam, the docs session port, `SessionService` on
# the run's `DATABASE_URL`, a real git worktree under this script's own `SESSION_ROOT`, and the real
# PR step. The service is built in-process by the driver, so no API instance is started and no
# driver process outlives the script.
#
#   ./docs-trigger.sh
#
# Env: API_PORT (the port the fake uses; 9410 when unset), DOCS_TRIGGER_PORT (override),
# DATABASE_URL, DOCS_TRIGGER_REPO, EVIDENCE_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${DOCS_TRIGGER_PORT:-${API_PORT:-9410}}"
GH_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/docs-trigger"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LEDGER="$RUN_DIR/github-ledger.json"
SESSION_ROOT="$RUN_DIR/sessions"
REPO_DIR="$RUN_DIR/repo"
DRIVER="$ROOT/.pi/skills/verify-api/docs-trigger.ts"
FAKE="$ROOT/.pi/skills/verify-api/github-fake.ts"
# A repo slug this run owns. Every row the drive writes is scoped to it — sessions, the branch, the
# registered checkout — so a database a previous run drove against (or another suite shares) cannot
# answer "how many docs runs did this prove?" with someone else's rows.
RUN_ID="$(date +%s)$$"
REPO="${DOCS_TRIGGER_REPO:-lobiklukas/factory-docs-$RUN_ID}"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR" "$SESSION_ROOT"
rm -f "$LEDGER"

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

# A count out of the ledger: `posts` (PR creates), `pulls` (PRs that exist), `refs` (requests that
# write a git ref or a file — the shape a push to the default branch would have).
ledger_count() {
  bun -e '
    const ledger = await Bun.file(process.argv[1]).json();
    const kind = process.argv[2];
    const requests = ledger.requests;
    const out =
      kind === "posts"
        ? requests.filter((request) => request.method === "POST").length
        : kind === "pulls"
          ? ledger.pulls.length
          : requests.filter(
              (request) =>
                request.path.includes("/git/refs") ||
                request.path.includes("/contents") ||
                request.path.includes("/merges"),
            ).length;
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

# The repo the run is bound to: a real git checkout with one `main` commit, so the service cuts a
# real worktree at a real commit and `git rev-parse --abbrev-ref HEAD` there is a fact. No remote is
# configured, so no git call can reach a network (LOB-94) — which is also why "nothing pushed to
# main" is a claim about the GitHub client, not about git.
if [ ! -d "$REPO_DIR/.git" ]; then
  rm -rf "$REPO_DIR"
  mkdir -p "$REPO_DIR"
  git init -q -b main "$REPO_DIR"
  git -C "$REPO_DIR" config user.email docs-trigger@localhost
  git -C "$REPO_DIR" config user.name "docs-trigger"
  mkdir -p "$REPO_DIR/docs"
  printf '# factory\n' > "$REPO_DIR/README.md"
  git -C "$REPO_DIR" add README.md
  git -C "$REPO_DIR" commit -q -m "docs-trigger repo"
fi

# --- the fake -------------------------------------------------------------------------------------
: > "$RUN_DIR/fake.log"
( exec env \
    GITHUB_FAKE_PORT="$PORT" \
    GITHUB_FAKE_LEDGER="$LEDGER" \
    bun "$FAKE" ) >> "$RUN_DIR/fake.log" 2>&1 &
echo $! > "$RUN_DIR/fake.pid"
# Wait for the *listener*, not for the ledger: the fake writes the empty ledger before `Bun.serve`
# runs, so a port something else already holds leaves a ledger on disk and a dead fake.
for _ in $(seq 1 60); do
  grep -q "github-fake listening" "$RUN_DIR/fake.log" 2>/dev/null && \
    kill -0 "$(cat "$RUN_DIR/fake.pid")" 2>/dev/null && break
  sleep 0.1
done
if ! grep -q "github-fake listening" "$RUN_DIR/fake.log" 2>/dev/null; then
  echo "the fake GitHub did not start on $PORT — see $RUN_DIR/fake.log" >&2
  exit 1
fi

# --- the run --------------------------------------------------------------------------------------
env \
  GITHUB_API_URL="$GH_URL" \
  GITHUB_FAKE_LEDGER="$LEDGER" \
  SESSION_ROOT="$SESSION_ROOT" \
  DOCS_TRIGGER_REPO_DIR="$REPO_DIR" \
  DOCS_TRIGGER_REPO="$REPO" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  DATABASE_URL="${DATABASE_URL:?docs-trigger needs DATABASE_URL from the run}" \
  bun "$DRIVER" > "$RUN_DIR/docs-trigger.log" 2>&1
DRIVER_RC=$?
cat "$RUN_DIR/docs-trigger.log"
check "the driver passes its checks" \
  "$([ "$DRIVER_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVER_RC"

POSTS="$(ledger_count posts)"
PULLS="$(ledger_count pulls)"
REFS="$(ledger_count refs)"
check "GitHub was asked for exactly one PR and nothing else" \
  "$([ "$POSTS" = "1" ] && [ "$PULLS" = "1" ] && echo 0 || echo 1)" \
  "posts=$POSTS pulls=$PULLS"
check "and it was never asked to write a ref or a file" \
  "$([ "$REFS" = "0" ] && echo 0 || echo 1)" "refWrites=$REFS"

cp "$LEDGER" "$EVIDENCE_DIR/docs-trigger-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/fake.log" "$EVIDENCE_DIR/docs-trigger-fake.log" 2>/dev/null || true
{
  printf '{\n'
  printf '  "githubUrl": "%s",\n' "$GH_URL"
  printf '  "posts": %s,\n' "$POSTS"
  printf '  "pulls": %s,\n' "$PULLS"
  printf '  "refWrites": %s,\n' "$REFS"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/docs-trigger-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "docs-trigger: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "docs-trigger: FAILURES — see $EVIDENCE_DIR/docs-trigger-process.json" >&2
fi
exit "$failed"
