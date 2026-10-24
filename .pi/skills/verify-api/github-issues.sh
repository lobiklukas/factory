#!/usr/bin/env bash
# Drive the GitHub issues/labels adapter end to end (LOB-190): an issue event creates one session
# and one issue comment, and neither GitHub's `labeled` twin nor a redelivery creates a second one.
#
#   ./github-issues.sh
#
# The driver builds the adapter in-process (`github-issues.ts`), so there is no API instance here:
# the port a run reserved for this surface is the port the loopback GitHub fake listens on. Only
# GitHub is fake — the seam, the session layer and the run's Postgres are real.
#
# The session root is a throwaway git repo whose origin is a local bare repository, so no git call
# can reach a real remote (LOB-94), and the run's `DATABASE_URL` is the database the driver opens.
#
# What the fake cannot prove: that GitHub accepts the comment path, the App token or
# `X-GitHub-Api-Version` as spelled, or that creating an issue with a label really emits both the
# `opened` and the `labeled` delivery the idempotency key collapses. The request shape is asserted
# in `packages/core/src/GitHub.test.ts` from the documented API; the fake is only as right as that
# reading. See `docs/testing-third-parties.md`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${GITHUB_ISSUES_PORT:-${API_PORT:-9413}}"
FAKE_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/github-issues"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-190}"
LEDGER="$RUN_DIR/github-issues-ledger.json"
SESSION_ROOT="$RUN_DIR/sessions"
ORIGIN_DIR="$RUN_DIR/origin.git"
DRIVER="$ROOT/.pi/skills/verify-api/github-issues.ts"
FAKE="$ROOT/.pi/skills/verify-api/github-issues-fake.ts"
REPO="${GITHUB_TRIGGER_REPO:-acme/verify-api-github}"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR" "$SESSION_ROOT"
rm -f "$LEDGER"

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
  git -C "$SESSION_ROOT" config user.email github@localhost
  git -C "$SESSION_ROOT" config user.name "github-issues-drive"
  git -C "$SESSION_ROOT" commit -q --allow-empty -m "github issues drive session root"
  git init -q -b main --bare "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" remote add origin "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" push -q origin main
fi

# --- the loopback GitHub ----------------------------------------------------------------------
: > "$RUN_DIR/fake.log"
( exec env \
    GITHUB_ISSUES_FAKE_PORT="$PORT" \
    GITHUB_ISSUES_FAKE_LEDGER="$LEDGER" \
    GITHUB_ISSUES_FAKE_FAIL_AFTER_WRITE="#9" \
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

# --- the drive ---------------------------------------------------------------------------------
env \
  GITHUB_ISSUES_FAKE_URL="$FAKE_URL" \
  GITHUB_ISSUES_FAKE_LEDGER="$LEDGER" \
  GITHUB_TRIGGER_REPO="$REPO" \
  SESSION_ROOT="$SESSION_ROOT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  DATABASE_URL="${DATABASE_URL:?github-issues.sh needs DATABASE_URL from the run}" \
  bun "$DRIVER" 2>&1 | tee "$EVIDENCE_DIR/github-issues.log"
STATUS="${PIPESTATUS[0]}"

cp "$LEDGER" "$EVIDENCE_DIR/github-issues-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/fake.log" "$EVIDENCE_DIR/github-issues-fake.log" 2>/dev/null || true

echo
if [ "$STATUS" -eq 0 ]; then
  echo "github-issues: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "github-issues: FAILURES — see $EVIDENCE_DIR/github-issues.log" >&2
fi
exit "$STATUS"
