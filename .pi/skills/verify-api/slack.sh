#!/usr/bin/env bash
# Drive the Slack adapter end to end (LOB-191): a signed message creates one session and one
# threaded reply, its replay creates neither, a stale delivery is refused, and a filtered message is
# recorded rather than dropped.
#
#   ./slack.sh
#
# The driver builds the adapter in-process (`slack.ts`), so there is no API instance here: the port
# a run reserved for this surface is the port the loopback Slack fake listens on. Only the Slack Web
# API is fake — the seam, the signature check, the session layer and the run's Postgres are real.
#
# The session root is a throwaway git repo whose origin is a local bare repository, so no git call
# can reach a real remote (LOB-94), and the run's `DATABASE_URL` is the database the driver opens.
#
# What the fake cannot prove: that Slack accepts `chat.postMessage` with these parameters, that the
# Events API really re-sends a failed delivery with the same `event.ts`, or that `conversations.replies`
# pages the way this reads it. The request shape is asserted in `packages/core/src/Slack.test.ts`
# from the documented API; the fake is only as right as that reading. See
# `docs/testing-third-parties.md`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${SLACK_PORT:-${API_PORT:-9414}}"
FAKE_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/slack"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-191}"
LEDGER="$RUN_DIR/slack-ledger.json"
SESSION_ROOT="$RUN_DIR/sessions"
ORIGIN_DIR="$RUN_DIR/origin.git"
DRIVER="$ROOT/.pi/skills/verify-api/slack.ts"
FAKE="$ROOT/.pi/skills/verify-api/slack-fake.ts"
REPO="${SLACK_TRIGGER_REPO:-acme/verify-api-slack}"
SIGNING_SECRET="${SLACK_SIGNING_SECRET:-lob191-drive-signing-secret}"
# The run's message stamp. Slack's `ts` is what the seam dedupes a message by, so it has to be new
# per run or a second run against the same database replays the first run's deliveries; `slack.ts`
# reads the same value and derives every message from it (`messageTs(n)`).
RUN_STAMP="$(date +%s)$(printf '%03d' $((RANDOM % 1000)))"
# The message whose reply the fake records and then answers 500 for: `slack.ts`'s `messageTs(9)`.
LOST_ACK_TS="$RUN_STAMP.0009"

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
  git -C "$SESSION_ROOT" config user.email slack@localhost
  git -C "$SESSION_ROOT" config user.name "slack-drive"
  git -C "$SESSION_ROOT" commit -q --allow-empty -m "slack drive session root"
  git init -q -b main --bare "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" remote add origin "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" push -q origin main
fi

# --- the loopback Slack -----------------------------------------------------------------------
: > "$RUN_DIR/fake.log"
( exec env \
    SLACK_FAKE_PORT="$PORT" \
    SLACK_FAKE_LEDGER="$LEDGER" \
    SLACK_FAKE_FAIL_AFTER_WRITE="$LOST_ACK_TS" \
    bun "$FAKE" ) >> "$RUN_DIR/fake.log" 2>&1 &
echo $! > "$RUN_DIR/fake.pid"
for _ in $(seq 1 60); do
  [ -s "$LEDGER" ] && break
  sleep 0.1
done
if [ ! -s "$LEDGER" ]; then
  echo "the fake Slack did not start — see $RUN_DIR/fake.log" >&2
  exit 1
fi

# --- the drive ---------------------------------------------------------------------------------
env \
  SLACK_FAKE_URL="$FAKE_URL" \
  SLACK_FAKE_LEDGER="$LEDGER" \
  SLACK_RUN_STAMP="$RUN_STAMP" \
  SLACK_TRIGGER_REPO="$REPO" \
  SLACK_SIGNING_SECRET="$SIGNING_SECRET" \
  SESSION_ROOT="$SESSION_ROOT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  DATABASE_URL="${DATABASE_URL:?slack.sh needs DATABASE_URL from the run}" \
  bun "$DRIVER" 2>&1 | tee "$EVIDENCE_DIR/slack.log"
STATUS="${PIPESTATUS[0]}"

cp "$LEDGER" "$EVIDENCE_DIR/slack-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/fake.log" "$EVIDENCE_DIR/slack-fake.log" 2>/dev/null || true

echo
if [ "$STATUS" -eq 0 ]; then
  echo "slack: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "slack: FAILURES — see $EVIDENCE_DIR/slack.log" >&2
fi
exit "$STATUS"
