#!/usr/bin/env bash
# Prove one documentation run end to end (LOB-228, part 4 of LOB-195).
#
# The claim: a run whose column holds the `docs` skill edits three markdown files, is refused when it
# reaches for a source file, opens exactly one PR whose body lists the three paths, and a control run
# over the diff cap opens nothing. Everything but GitHub is real — the board rows the column is read
# from, `openSession` selecting the docs rule, the service on the run's `DATABASE_URL`, and a real
# git worktree under its own `SESSION_ROOT`.
#
# The script owns everything it starts — its own fake on its own port, its own repo checkout, its own
# session root — because a run must not touch the instance `./up.sh` started. It leaves nothing
# running, and no driver process outlives it: each phase builds the service in-process, exactly as
# `./pr-once.sh` does, so no API instance is started at all.
#
#   ./docs-run.sh
#
# Env: API_PORT (the port the fake uses; 9410 when unset), DOCS_RUN_PORT (override), DATABASE_URL,
# DOCS_RUN_REPO, EVIDENCE_DIR.
#
# What the fake cannot prove: that GitHub really answers a create the way this one does, or what its
# 422 body looks like for a duplicate head. The request shape is asserted in
# `packages/core/src/pr.test.ts`; the fake is only as right as that contract. And nothing here covers
# writes a `bash` command makes — `docsPolicy` reads the `write`/`edit` path argument only, which is
# the shell-write gap the feature docs name.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# The fake takes the run's `API_PORT` when one is set: there is no API in this script (the driver
# builds the service in-process), so the port a run reserved for this surface is the port the fake
# listens on. `DOCS_RUN_PORT` overrides it for a second concurrent run.
PORT="${DOCS_RUN_PORT:-${API_PORT:-9410}}"
GH_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/docs-run"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LEDGER="$RUN_DIR/github-ledger.json"
SESSION_ROOT="$RUN_DIR/sessions"
REPO_DIR="$RUN_DIR/repo"
DRIVER="$ROOT/.pi/skills/verify-api/docs-run.ts"
FAKE="$ROOT/.pi/skills/verify-api/github-fake.ts"
REPO="${DOCS_RUN_REPO:-lobiklukas/factory}"

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

# A count out of the ledger: `posts` (create requests), `gets` (lookups), or `pulls` (PRs that exist).
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

# The `body` field of the first create request: the PR body GitHub was given.
pr_body() {
  bun -e '
    const ledger = await Bun.file(process.argv[1]).json();
    const post = ledger.requests.find((request) => request.method === "POST");
    console.log(post?.body?.body ?? "");
  ' "$LEDGER" 2>/dev/null || echo ""
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

# The repo the run is bound to: a real git checkout with a `main` commit, so the service cuts a real
# worktree and the PR step measures a real branch. No remote is configured, so no git call can reach
# a network (LOB-94).
if [ ! -d "$REPO_DIR/.git" ]; then
  rm -rf "$REPO_DIR"
  mkdir -p "$REPO_DIR"
  git init -q -b main "$REPO_DIR"
  git -C "$REPO_DIR" config user.email docs-run@localhost
  git -C "$REPO_DIR" config user.name "docs-run"
  printf '# factory\n' > "$REPO_DIR/README.md"
  git -C "$REPO_DIR" add README.md
  git -C "$REPO_DIR" commit -q -m "docs-run repo"
fi

# --- the fake -------------------------------------------------------------------------------------
: > "$RUN_DIR/fake.log"
( exec env \
    GITHUB_FAKE_PORT="$PORT" \
    GITHUB_FAKE_LEDGER="$LEDGER" \
    bun "$FAKE" ) >> "$RUN_DIR/fake.log" 2>&1 &
echo $! > "$RUN_DIR/fake.pid"
# Wait for the *listener*, not for the ledger: the fake writes the empty ledger before `Bun.serve`
# runs, so a port something else already holds leaves a ledger on disk and a dead fake. Waiting for
# its "listening" line and for the process to still be alive is what makes "this script owns its
# port" a checked claim rather than an assumption.
for _ in $(seq 1 60); do
  grep -q "github-fake listening" "$RUN_DIR/fake.log" 2>/dev/null && \
    kill -0 "$(cat "$RUN_DIR/fake.pid")" 2>/dev/null && break
  sleep 0.1
done
if ! grep -q "github-fake listening" "$RUN_DIR/fake.log" 2>/dev/null; then
  echo "the fake GitHub did not start on $PORT — see $RUN_DIR/fake.log" >&2
  exit 1
fi

driver_env=( env
  GITHUB_API_URL="$GH_URL"
  SESSION_ROOT="$SESSION_ROOT"
  DOCS_RUN_REPO_DIR="$REPO_DIR"
  DOCS_RUN_REPO="$REPO"
  EVIDENCE_DIR="$EVIDENCE_DIR"
  DATABASE_URL="${DATABASE_URL:?docs-run needs DATABASE_URL from the run}" )

# --- the run: three docs, one refused source write, one PR ----------------------------------------
"${driver_env[@]}" MODE=docs bun "$DRIVER" > "$RUN_DIR/docs.log" 2>&1
DOCS_RC=$?
cat "$RUN_DIR/docs.log"
check "the docs run passes its checks" \
  "$([ "$DOCS_RC" = "0" ] && echo 0 || echo 1)" "exit=$DOCS_RC"

POSTS="$(ledger_count posts)"
check "the run asked GitHub for exactly one PR" \
  "$([ "$POSTS" = "1" ] && [ "$(ledger_count pulls)" = "1" ] && echo 0 || echo 1)" \
  "posts=$POSTS prs=$(ledger_count pulls)"

BODY="$(pr_body)"
MISSING=""
for file in docs/session.md docs/board.md docs/policy.md; do
  printf '%s' "$BODY" | grep -q -- "- $file" || MISSING="$MISSING $file"
done
printf '%s' "$BODY" | grep -q '## Changed files' || MISSING="$MISSING (no section)"
check "the PR body lists the three changed paths" \
  "$([ -z "$MISSING" ] && echo 0 || echo 1)" \
  "missing:${MISSING:-none}"

# --- the control: a run over the cap opens nothing ------------------------------------------------
"${driver_env[@]}" MODE=over-cap bun "$DRIVER" > "$RUN_DIR/over-cap.log" 2>&1
CAP_RC=$?
cat "$RUN_DIR/over-cap.log"
check "the over-cap control passes its checks" \
  "$([ "$CAP_RC" = "0" ] && echo 0 || echo 1)" "exit=$CAP_RC"
check "and it left the ledger where it was: no second request, no second PR" \
  "$([ "$(ledger_count posts)" = "1" ] && [ "$(ledger_count pulls)" = "1" ] && echo 0 || echo 1)" \
  "posts=$(ledger_count posts) prs=$(ledger_count pulls)"

cp "$LEDGER" "$EVIDENCE_DIR/docs-run-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/fake.log" "$EVIDENCE_DIR/docs-run-fake.log" 2>/dev/null || true
{
  printf '{\n'
  printf '  "githubUrl": "%s",\n' "$GH_URL"
  printf '  "posts": %s,\n' "$(ledger_count posts)"
  printf '  "pulls": %s,\n' "$(ledger_count pulls)"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/docs-run-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "docs-run: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "docs-run: FAILURES — see $EVIDENCE_DIR/docs-run-process.json" >&2
fi
exit "$failed"
