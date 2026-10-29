#!/usr/bin/env bash
# Drive `factory run --open-pr` (F17): a person's session opts in, at the start, to its PR being opened
# when the run settles. Against a loopback GitHub fake, whose ledger is the oracle for what the forge was
# asked, and a faux model whose one command commits a file only in a repo that carries a `.verify-ship`
# marker on its base:
#
#   --open-pr on a repo whose run commits   the run prints `pr <link>`; the ledger holds exactly one create,
#                                           for `factory/<session>`; `factory ls` and `factory show` name it
#   no flag on the same repo                no `pr` line, the forge is asked nothing, `factory show` says `pr -`
#   --open-pr on a repo whose run changes   `pr none: no change: ...`; the forge is asked nothing
#   nothing
#   --open-pr with no --repo                refused as invalid_input before any session exists
#
# Not ./up.sh's instance: this script starts and stops its own API, fake, session root and fixture
# checkouts, and leaves nothing running.
#
#   ./open-pr.sh                       # API on :9392, the fake GitHub on :9393
#   OPEN_PR_PORT=9552 OPEN_PR_GITHUB_PORT=9553 ./open-pr.sh
#
# Evidence: .verify/evidence/latest/cli/open-pr-*.txt (each command's output), open-pr.json (every check),
# open-pr-ledger.json (the fake's ledger) and open-pr-api.log.
set -uo pipefail

# Auth off, as every CLI drive runs its API (LOB-20).
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${OPEN_PR_PORT:-9392}"
GH_PORT="${OPEN_PR_GITHUB_PORT:-9393}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-open-pr"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LEDGER="$RUN_DIR/github-ledger.json"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
TAG="$(date +%s)$$"
SHIP="verify-open-pr-$TAG/ship"
QUIET="verify-open-pr-$TAG/quiet"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"${3//\"/\'}\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-84s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-84s %s\n' "$1" "$3"
  fi
}
yes_if() { if eval "$1"; then echo 0; else echo 1; fi; }

for port in "$PORT" "$GH_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set OPEN_PR_PORT / OPEN_PR_GITHUB_PORT to free ones" >&2
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
cleanup() {
  stop_pid "$RUN_DIR/api.pid"
  stop_pid "$RUN_DIR/github.pid"
  cp "$LEDGER" "$EVIDENCE_DIR/open-pr-ledger.json" 2>/dev/null || true
  cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/open-pr-api.log" 2>/dev/null || true
  # The registry has no delete RPC: take back the rows this run registered, over TCP.
  bun -e '
    const sql = new Bun.SQL(process.argv[1]);
    try { await sql`DELETE FROM repos WHERE slug LIKE ${"verify-open-pr-%"}`; } finally { await sql.close(); }
  ' "${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

rm -rf "$RUN_DIR/sessions" "$RUN_DIR/checkouts" "$LEDGER"
mkdir -p "$RUN_DIR/sessions" "$RUN_DIR/checkouts"
: > "$RUN_DIR/api.log"

fixture() { # name, [marker]
  local dir="$RUN_DIR/checkouts/$1"
  git init -q -b main "$dir"
  echo "$1" > "$dir/README.md"
  [ -n "${2:-}" ] && echo 1 > "$dir/$2"
  git -C "$dir" add -A
  git -C "$dir" -c user.email=verify-open-pr@localhost -c user.name=verify-open-pr commit -q -m seed
}
fixture ship .verify-ship
fixture quiet

( exec env GITHUB_FAKE_PORT="$GH_PORT" GITHUB_FAKE_LEDGER="$LEDGER" \
    bun "$ROOT/.pi/skills/verify-api/github-fake.ts" ) > "$RUN_DIR/github.log" 2>&1 &
echo $! > "$RUN_DIR/github.pid"
for _ in $(seq 1 60); do
  grep -q "github-fake listening" "$RUN_DIR/github.log" 2>/dev/null && break
  sleep 0.1
done
grep -q "github-fake listening" "$RUN_DIR/github.log" 2>/dev/null || {
  echo "the fake GitHub did not start — see $RUN_DIR/github.log" >&2
  exit 1
}

FAUX_COMMAND="if [ -f .verify-ship ]; then echo ship > ship.txt; git add -A && git -c user.email=verify-open-pr@localhost -c user.name=verify-open-pr commit -q -m run; fi; echo faux-ok"
( cd "$ROOT/apps/api" && exec env \
    -u GITHUB_TOKEN -u GITHUB_APP_ID -u GITHUB_APP_PRIVATE_KEY -u GITHUB_APP_INSTALLATION_ID \
    PORT="$PORT" HOST="127.0.0.1" ALLOWED_ORIGINS="http://localhost:$PORT" \
    MODEL_BACKEND=faux FAUX_COMMAND="$FAUX_COMMAND" \
    GITHUB_API_URL="http://127.0.0.1:$GH_PORT" GITHUB_TOKEN="verify-open-pr-fake-token" \
    SESSION_ROOT="$RUN_DIR/sessions" SESSION_IDLE_TIMEOUT_MS=600000 \
    bun run src/index.ts ) >> "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"
ready=0
for _ in $(seq 1 60); do
  curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 0.5
done
[ "$ready" -eq 1 ] || { echo "api did not become ready — see $RUN_DIR/api.log" >&2; exit 1; }

# No CLI verb registers a checkout with a path yet, so the repos are registered over the RPC the CLI
# speaks (a request line keeps its newline, so it is piped).
register() { # slug, path
  printf '{"_tag":"Request","id":"1","tag":"registerRepo","payload":{"repo":"%s","localPath":"%s"},"headers":[]}\n' "$1" "$2" |
    curl -s -m 10 -H 'content-type: application/ndjson' --data-binary @- "$API_URL/rpc" | grep -q '"_tag":"Success"'
}
register "$SHIP" "$RUN_DIR/checkouts/ship" && register "$QUIET" "$RUN_DIR/checkouts/quiet" || {
  echo "could not register the fixture repos" >&2
  exit 1
}

cli() { "${FACTORY[@]}" "$@" --api "$API_URL"; }
ledger_pulls() { bun -e 'const l = JSON.parse(await Bun.file(process.argv[1]).text()); console.log(l.pulls.filter((p) => p.head === process.argv[2]).length)' "$LEDGER" "$1"; }
ledger_requests() { bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).requests.length)' "$LEDGER"; }
session_of() { grep -o '^session ses_[0-9a-z]\{26\}' "$1" | head -1 | cut -d' ' -f2; }

# --- --open-pr on a repo whose run commits ---------------------------------------------------------------
cli run "ship it" --repo "$SHIP" --open-pr > "$EVIDENCE_DIR/open-pr-ship.txt" 2>&1
RC=$?
SHIP_ID="$(session_of "$EVIDENCE_DIR/open-pr-ship.txt")"
PR_LINE="$(grep '^pr ' "$EVIDENCE_DIR/open-pr-ship.txt" | head -1)"
check "run --open-pr on a repo whose run commits prints the PR's link and exits 0" \
  "$(yes_if "[ $RC -eq 0 ] && [ -n '$SHIP_ID' ] && [ '$PR_LINE' = 'pr https://github.com/$SHIP/pull/1' ]")" \
  "exit=$RC ${PR_LINE:-no pr line}"
check "the forge was asked for exactly one PR, from the session's own branch" \
  "$(yes_if "[ '$(ledger_pulls "factory/$SHIP_ID")' = '1' ]")" \
  "creates for factory/$SHIP_ID: $(ledger_pulls "factory/$SHIP_ID")"
cli ls > "$EVIDENCE_DIR/open-pr-ls.txt" 2>&1
check "factory ls shows the PR in the session's row" \
  "$(yes_if "grep -E '^$SHIP_ID ' '$EVIDENCE_DIR/open-pr-ls.txt' | grep -q 'https://github.com/$SHIP/pull/1'")" \
  "$(grep -E "^$SHIP_ID " "$EVIDENCE_DIR/open-pr-ls.txt" | cut -c1-140)"
cli show "$SHIP_ID" > "$EVIDENCE_DIR/open-pr-show.txt" 2>&1
check "factory show names the PR" \
  "$(yes_if "grep -qx 'pr https://github.com/$SHIP/pull/1' '$EVIDENCE_DIR/open-pr-show.txt'")" \
  "$(grep '^pr ' "$EVIDENCE_DIR/open-pr-show.txt")"

# --- no flag: the person's call, as before ------------------------------------------------------------------
REQUESTS_BEFORE="$(ledger_requests)"
cli run "ship it again" --repo "$SHIP" > "$EVIDENCE_DIR/open-pr-plain.txt" 2>&1
RC=$?
PLAIN_ID="$(session_of "$EVIDENCE_DIR/open-pr-plain.txt")"
sleep 4
cli show "$PLAIN_ID" > "$EVIDENCE_DIR/open-pr-plain-show.txt" 2>&1
check "run without --open-pr prints no pr line, asks the forge nothing and leaves pr -" \
  "$(yes_if "[ $RC -eq 0 ] && ! grep -q '^pr ' '$EVIDENCE_DIR/open-pr-plain.txt' && [ '$(ledger_requests)' = '$REQUESTS_BEFORE' ] && grep -qx 'pr -' '$EVIDENCE_DIR/open-pr-plain-show.txt'")" \
  "exit=$RC requests=$(ledger_requests) (was $REQUESTS_BEFORE)"

# --- --open-pr on a repo whose run changes nothing ----------------------------------------------------------------
REQUESTS_BEFORE="$(ledger_requests)"
cli run "look around" --repo "$QUIET" --open-pr > "$EVIDENCE_DIR/open-pr-quiet.txt" 2>&1
RC=$?
check "run --open-pr on a run that changes nothing says why there is no PR, and the forge is asked nothing" \
  "$(yes_if "[ $RC -eq 0 ] && grep -q '^pr none: no change' '$EVIDENCE_DIR/open-pr-quiet.txt' && [ '$(ledger_requests)' = '$REQUESTS_BEFORE' ]")" \
  "exit=$RC $(grep '^pr ' "$EVIDENCE_DIR/open-pr-quiet.txt" | cut -c1-90)"

# --- --open-pr with no repo --------------------------------------------------------------------------------------
cli run "scratch" --open-pr > "$EVIDENCE_DIR/open-pr-scratch.txt" 2>&1
RC=$?
check "run --open-pr with no --repo is refused as invalid_input, before a session exists" \
  "$(yes_if "[ $RC -ne 0 ] && grep -q '^error: invalid_input' '$EVIDENCE_DIR/open-pr-scratch.txt' && ! grep -q '^session ' '$EVIDENCE_DIR/open-pr-scratch.txt'")" \
  "exit=$RC $(head -1 "$EVIDENCE_DIR/open-pr-scratch.txt" | cut -c1-90)"

{
  printf '{\n  "apiUrl": "%s",\n  "checks": {\n' "$API_URL"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/open-pr.json"

if [ "$failed" -eq 0 ]; then
  echo "open-pr: all checks passed"
else
  echo "open-pr: some checks failed — see $EVIDENCE_DIR" >&2
fi
exit "$failed"
