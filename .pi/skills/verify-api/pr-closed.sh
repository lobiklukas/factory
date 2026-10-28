#!/usr/bin/env bash
# Prove a card's PR closed without merging is recorded, and the card's next run opens a new PR
# rather than adopting the closed one (F12), against the loopback GitHub fake.
#
# The driver (`pr-closed.ts`) builds the session and task services in-process over the run's
# database, as `pr-once.ts` does, and runs the card's first building run, the person's close on the
# fake, GitHub's signed closed delivery through the functions the webhook route runs, the unblock,
# and two more runs. This script owns its fake, its checkout and its session root, and reads the
# fake's ledger back: what GitHub was asked is the evidence, not what the driver says it did.
#
#   ./pr-closed.sh
#   PR_CLOSED_PORT=9521 ./pr-closed.sh
#
# Env: PR_CLOSED_PORT (the fake's port; API_PORT, then 9411, when unset), DATABASE_URL, EVIDENCE_DIR.
# Evidence: .verify/evidence/latest/api/pr-closed.json (the driver's checks), pr-closed-ledger.json,
# pr-closed-process.json (this script's checks).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${PR_CLOSED_PORT:-${API_PORT:-9411}}"
GH_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/pr-closed"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LEDGER="$RUN_DIR/github-ledger.json"
SESSION_ROOT="$RUN_DIR/sessions"
CHECKOUT="$RUN_DIR/checkout"
DRIVER="$ROOT/.pi/skills/verify-api/pr-closed.ts"
FAKE="$ROOT/.pi/skills/verify-api/github-fake.ts"
RUN_ID="$(date +%s)$$"
# A slug of this run's own: one board per repository, and a fresh board per run.
REPO="lobiklukas/factory-pr-closed-$RUN_ID"

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR" "$EVIDENCE_DIR" "$SESSION_ROOT"

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

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is taken; set PR_CLOSED_PORT to a free one" >&2
  exit 1
fi

# The checkout the card's runs are cut from: a real repository with nothing to push to.
git init -q -b main "$CHECKOUT"
git -C "$CHECKOUT" -c user.email=pr-closed@localhost -c user.name=pr-closed \
  commit -q --allow-empty -m "pr-closed checkout"

: > "$RUN_DIR/fake.log"
( exec env GITHUB_FAKE_PORT="$PORT" GITHUB_FAKE_LEDGER="$LEDGER" bun "$FAKE" ) \
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

env GITHUB_API_URL="$GH_URL" GH_FAKE_URL="$GH_URL" SESSION_ROOT="$SESSION_ROOT" \
  CHECKOUT="$CHECKOUT" PR_CLOSED_REPO="$REPO" EVIDENCE_DIR="$EVIDENCE_DIR" \
  DATABASE_URL="${DATABASE_URL:?pr-closed needs DATABASE_URL from the run}" \
  bun "$DRIVER" > "$RUN_DIR/drive.log" 2>&1
DRIVE_RC=$?
cat "$RUN_DIR/drive.log"
check "the driver's checks pass" "$([ "$DRIVE_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVE_RC"

# The ledger: what GitHub was asked, and the PRs it holds.
read -r POSTS PULLS FIRST_STATE SECOND_STATE SAME_HEAD < <(bun -e '
  const ledger = await Bun.file(process.argv[1]).json();
  const posts = ledger.requests.filter((r) => r.method === "POST").length;
  const [first, second] = ledger.pulls;
  console.log(
    posts,
    ledger.pulls.length,
    first?.state ?? "open",
    second?.state ?? "open",
    first !== undefined && second !== undefined && first.head === second.head ? "yes" : "no",
  );
' "$LEDGER" 2>/dev/null || echo "0 0 none none no")
check "GitHub was asked for two PRs, the closed one and its successor, and no third" \
  "$([ "$POSTS" = "2" ] && [ "$PULLS" = "2" ] && echo 0 || echo 1)" "posts=$POSTS pulls=$PULLS"
check "the first PR is closed and the second open, both from the card's one branch" \
  "$([ "$FIRST_STATE" = "closed" ] && [ "$SECOND_STATE" = "open" ] && [ "$SAME_HEAD" = "yes" ] && echo 0 || echo 1)" \
  "first=$FIRST_STATE second=$SECOND_STATE sameHead=$SAME_HEAD"

cp "$LEDGER" "$EVIDENCE_DIR/pr-closed-ledger.json" 2>/dev/null || true
{
  printf '{\n  "githubUrl": "%s",\n  "repo": "%s",\n  "checks": {\n' "$GH_URL" "$REPO"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/pr-closed-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "pr-closed: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "pr-closed: FAILURES — see $EVIDENCE_DIR/pr-closed-process.json" >&2
fi
exit "$failed"
