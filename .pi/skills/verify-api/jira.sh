#!/usr/bin/env bash
# Drive the Jira adapter end to end (LOB-189): a Jira issue event creates one session and one Jira
# comment, and the same event replayed creates neither a second session nor a second comment.
#
#   ./jira.sh
#
# The driver builds the adapter in-process (`jira.ts`), so there is no API instance here: the port a
# run reserved for this surface is the port the loopback Jira fake listens on. Only Jira is fake —
# the seam, the session layer and the run's Postgres are real.
#
# The session root is a throwaway git repo whose origin is a local bare repository, so no git call
# can reach a real remote (LOB-94), and the run's `DATABASE_URL` is the database the driver opens.
#
# What the fake cannot prove: that Jira Cloud accepts the ADF document, the Basic-auth header or the
# comment path as spelled. The request shape is asserted in `packages/core/src/Jira.test.ts` from
# the documented API; the fake is only as right as that reading. See `docs/testing-third-parties.md`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${JIRA_PORT:-${API_PORT:-9412}}"
JIRA_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/jira"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-189}"
LEDGER="$RUN_DIR/jira-ledger.json"
SESSION_ROOT="$RUN_DIR/sessions"
ORIGIN_DIR="$RUN_DIR/origin.git"
DRIVER="$ROOT/.pi/skills/verify-api/jira.ts"
FAKE="$ROOT/.pi/skills/verify-api/jira-fake.ts"
REPO="${JIRA_TRIGGER_REPO:-acme/verify-api-jira}"

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
  git -C "$SESSION_ROOT" config user.email jira@localhost
  git -C "$SESSION_ROOT" config user.name "jira-drive"
  git -C "$SESSION_ROOT" commit -q --allow-empty -m "jira drive session root"
  git init -q -b main --bare "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" remote add origin "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" push -q origin main
fi

# --- the loopback Jira ------------------------------------------------------------------------
: > "$RUN_DIR/fake.log"
( exec env \
    JIRA_FAKE_PORT="$PORT" \
    JIRA_FAKE_LEDGER="$LEDGER" \
    JIRA_FAKE_FAIL_AFTER_WRITE=FAC-2 \
    bun "$FAKE" ) >> "$RUN_DIR/fake.log" 2>&1 &
echo $! > "$RUN_DIR/fake.pid"
for _ in $(seq 1 60); do
  [ -s "$LEDGER" ] && break
  sleep 0.1
done
if [ ! -s "$LEDGER" ]; then
  echo "the fake Jira did not start — see $RUN_DIR/fake.log" >&2
  exit 1
fi

# --- the drive ---------------------------------------------------------------------------------
env \
  JIRA_FAKE_URL="$JIRA_URL" \
  JIRA_FAKE_LEDGER="$LEDGER" \
  JIRA_TRIGGER_REPO="$REPO" \
  SESSION_ROOT="$SESSION_ROOT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  DATABASE_URL="${DATABASE_URL:?jira.sh needs DATABASE_URL from the run}" \
  bun "$DRIVER" 2>&1 | tee "$EVIDENCE_DIR/jira.log"
STATUS="${PIPESTATUS[0]}"

cp "$LEDGER" "$EVIDENCE_DIR/jira-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/fake.log" "$EVIDENCE_DIR/jira-fake.log" 2>/dev/null || true

echo
if [ "$STATUS" -eq 0 ]; then
  echo "jira: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "jira: FAILURES — see $EVIDENCE_DIR/jira.log" >&2
fi
exit "$STATUS"
