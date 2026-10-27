#!/usr/bin/env bash
# Prove the PR step's RPC member (LOB-213): a client opens a session's PR over the real Effect RPC
# client, a repeat answers the same PR tagged `already-open`, and the fake GitHub's ledger holds one
# request for the two calls.
#
# This script owns its own API instance and its own loopback GitHub fake — its own ports, session
# root, log, ledger and pid files — because the API has to be started with `GITHUB_API_URL` pointing
# at the fake and a `GITHUB_TOKEN` the fake never reads; the instance ./up.sh starts has neither. It
# does not touch that instance, and it leaves nothing running.
#
#   ./pr-rpc.sh
#   PR_RPC_PORT=9520 PR_RPC_GITHUB_PORT=9521 ./pr-rpc.sh     # another pair of ports
#
# Env: PR_RPC_PORT (the API; 9420 when unset), PR_RPC_GITHUB_PORT (the fake; 9421 when unset),
# DATABASE_URL, PR_RPC_REPO (a fresh slug per run when unset), EVIDENCE_DIR.
#
# Evidence: .verify/evidence/latest/api/pr-rpc.json (every check the driver made, both answers and
# the refusals), pr-rpc-ledger.json (every request the fake saw and every PR that exists),
# pr-rpc-process.json (this script's checks) and pr-rpc-api.log.
#
# What the fake cannot prove: that GitHub accepts the request as the fake does. The request shape is
# asserted in `packages/core/src/pr.test.ts`; this drive proves the wire between a client and the step.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${PR_RPC_PORT:-9420}"
GH_PORT="${PR_RPC_GITHUB_PORT:-9421}"
API_URL="http://127.0.0.1:$PORT"
GH_URL="http://127.0.0.1:$GH_PORT"
RUN_DIR="$ROOT/.verify/run/pr-rpc"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
LEDGER="$RUN_DIR/github-ledger.json"
SESSION_ROOT="$RUN_DIR/sessions"
ORIGIN_DIR="$RUN_DIR/origin.git"
FAKE="$ROOT/.pi/skills/verify-api/github-fake.ts"
# A slug this run owns, as pr-once.sh does: a slug another drive registered with a real checkout
# would hand this session that checkout, and an even branch answers `no-change` instead of a PR.
RUN_ID="$(date +%s)$$"
REPO="${PR_RPC_REPO:-lobiklukas/factory-pr-rpc-$RUN_ID}"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"
rm -f "$LEDGER"

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

# A count out of the ledger for this run's repo: `posts`, `gets`, or `pulls` (PRs that exist).
ledger_count() {
  bun -e '
    const ledger = await Bun.file(process.argv[1]).json();
    const [kind, repo] = [process.argv[2], process.argv[3]];
    const path = `/repos/${repo}/pulls`;
    const ours = ledger.requests.filter((request) => request.path === path);
    console.log(
      kind === "posts"
        ? ours.filter((request) => request.method === "POST").length
        : kind === "gets"
          ? ours.filter((request) => request.method === "GET").length
          : ledger.pulls.filter((pull) => pull.url.includes(`/${repo}/pull/`)).length,
    );
  ' "$LEDGER" "$1" "$REPO" 2>/dev/null || echo "-1"
}

for port in "$PORT" "$GH_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set PR_RPC_PORT / PR_RPC_GITHUB_PORT to free ones" >&2
    exit 1
  fi
done

stop_pid() { # pid file
  [ -f "$1" ] || return 0
  local pid; pid="$(cat "$1")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$1"
}

trap 'stop_pid "$RUN_DIR/api.pid"; stop_pid "$RUN_DIR/fake.pid"' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# The session root the API opens workspaces under: a real git repo with a local origin, so no git
# call a session makes can reach a real remote (LOB-94).
if [ ! -d "$SESSION_ROOT/.git" ]; then
  rm -rf "$SESSION_ROOT" "$ORIGIN_DIR"
  mkdir -p "$SESSION_ROOT"
  git init -q -b main "$SESSION_ROOT"
  git -C "$SESSION_ROOT" config user.email pr-rpc@localhost
  git -C "$SESSION_ROOT" config user.name "pr-rpc"
  git -C "$SESSION_ROOT" commit -q --allow-empty -m "pr-rpc session root"
  git init -q -b main --bare "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" remote add origin "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" push -q origin main
fi

# --- the fake GitHub ---------------------------------------------------------------------------------
: > "$RUN_DIR/fake.log"
( exec env GITHUB_FAKE_PORT="$GH_PORT" GITHUB_FAKE_LEDGER="$LEDGER" bun "$FAKE" ) \
  >> "$RUN_DIR/fake.log" 2>&1 &
echo $! > "$RUN_DIR/fake.pid"
for _ in $(seq 1 60); do
  [ -s "$LEDGER" ] && break
  sleep 0.1
done
if [ ! -s "$LEDGER" ]; then
  echo "the fake GitHub did not start — see $RUN_DIR/fake.log" >&2
  exit 1
fi

# --- the API, pointed at the fake ---------------------------------------------------------------------
# `env -u` for the App variables: a shell that has them set would select the App flow, whose token
# exchange the fake does not answer, and the drive would fail for a reason that is not this one.
: > "$LOG"
( cd "$ROOT/apps/api" && exec env \
    -u GITHUB_APP_ID -u GITHUB_APP_PRIVATE_KEY -u GITHUB_APP_INSTALLATION_ID \
    PORT="$PORT" \
    HOST="127.0.0.1" \
    MODEL_BACKEND=faux \
    GITHUB_API_URL="$GH_URL" \
    GITHUB_TOKEN="pr-rpc-fake-token" \
    SESSION_ROOT="$SESSION_ROOT" \
    SESSION_IDLE_TIMEOUT_MS=600000 \
    DATABASE_URL="${DATABASE_URL:?pr-rpc needs DATABASE_URL from the run}" \
    bun run src/index.ts ) >> "$LOG" 2>&1 &
echo $! > "$RUN_DIR/api.pid"
ready=1
for _ in $(seq 1 60); do
  curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && { ready=0; break; }
  sleep 0.5
done
[ "$ready" = "0" ] || { echo "api did not become ready — see $LOG" >&2; exit 1; }

check "the API selected the static token the fake is handed" \
  "$(grep -q 'credentials: static-token' "$LOG" && echo 0 || echo 1)" "credentials line"

# --- the driver: the RPC client the CLI and the dashboard build ---------------------------------------
API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" PR_RPC_REPO="$REPO" \
  bun "$ROOT/.pi/skills/verify-api/pr-rpc.ts" > "$RUN_DIR/driver.log" 2>&1
DRIVER_RC=$?
cat "$RUN_DIR/driver.log"
check "the driver passes its checks" "$([ "$DRIVER_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVER_RC"

# Two `openPullRequest` calls, one request: the first went to the forge, the repeat was the log's.
POSTS="$(ledger_count posts)"
PULLS="$(ledger_count pulls)"
check "the fake's ledger holds one create request for the two calls" \
  "$([ "$POSTS" = "1" ] && echo 0 || echo 1)" "posts=$POSTS"
check "and exactly one PR exists for the session's repo" \
  "$([ "$PULLS" = "1" ] && echo 0 || echo 1)" "pulls=$PULLS"
check "and nothing else reached the fake: no lookup, no stray route" \
  "$([ "$(ledger_count gets)" = "0" ] && bun -e '
    const ledger = await Bun.file(process.argv[1]).json();
    process.exit(ledger.requests.length === 1 ? 0 : 1);
  ' "$LEDGER" && echo 0 || echo 1)" "requests=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).requests.length)' "$LEDGER" 2>/dev/null)"

cp "$LEDGER" "$EVIDENCE_DIR/pr-rpc-ledger.json" 2>/dev/null || true
cp "$LOG" "$EVIDENCE_DIR/pr-rpc-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "githubUrl": "%s",\n' "$GH_URL"
  printf '  "repo": "%s",\n' "$REPO"
  printf '  "posts": %s,\n' "$POSTS"
  printf '  "pulls": %s,\n' "$PULLS"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/pr-rpc-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "pr-rpc: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "pr-rpc: FAILURES — see $EVIDENCE_DIR/pr-rpc-process.json" >&2
fi
exit "$failed"
