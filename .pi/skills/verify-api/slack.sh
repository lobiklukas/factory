#!/usr/bin/env bash
# Drive the Slack adapter over HTTP (LOB-191, served by LOB-259): a signed Events API delivery posted
# at `POST /webhooks/slack` of a booted API opens one session and one threaded reply, its replay
# opens neither, the `url_verification` handshake is answered, a stale or tampered delivery is
# refused, the PR link lands in the thread when the session's PR opens, and the same API booted with
# `SLACK_SIGNING_SECRET` unset answers 503.
#
#   ./slack.sh
#   API_PORT=9580 SLACK_FAKE_PORT=9582 SLACK_GITHUB_PORT=9583 ./slack.sh     # other ports
#
# Only Slack and GitHub are fake: the loopback `slack-fake.ts` answers the Web API's two calls, and
# the loopback `github-fake.ts` answers the PR step's, so the drive can open the session's PR and
# watch the link arrive in the thread. The API, its signature check, the seam, the session layer and
# the run's Postgres are real (`adapter-lib.sh` boots them).
#
# Env: API_PORT (or SLACK_API_PORT; 9425), SLACK_FAKE_PORT (9414), SLACK_GITHUB_PORT (9427),
# DATABASE_URL, SLACK_TRIGGER_REPO, SLACK_SIGNING_SECRET, EVIDENCE_DIR.
#
# What the fakes cannot prove: that Slack accepts `chat.postMessage` with these parameters, that the
# Events API really re-sends a failed delivery with the same `event.ts`, that it also delivers a
# mention in a watched channel as both a `message` and an `app_mention`, or that
# `conversations.replies` pages the way this reads it. The request shape is asserted in
# `packages/core/src/Slack.test.ts` from the documented API; the fakes are only as right as that
# reading. See `docs/testing-third-parties.md`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT/.pi/skills/verify-api/adapter-lib.sh"
API_PORT="${SLACK_API_PORT:-${API_PORT:-9425}}"
FAKE_PORT="${SLACK_FAKE_PORT:-9414}"
GITHUB_PORT="${SLACK_GITHUB_PORT:-9427}"
API_URL="http://127.0.0.1:$API_PORT"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-259}"
DRIVER="$ROOT/.pi/skills/verify-api/slack.ts"
SIGNING_SECRET="${SLACK_SIGNING_SECRET:-lob259-drive-signing-secret}"
BOT_TOKEN="xoxb-drive-token"
# The run's message stamp. Slack's `ts` is what the seam dedupes a message by, so it has to be new
# per run or a second run against the same database replays the first run's deliveries; `slack.ts`
# reads the same value and derives every message from it (`messageTs(n)`).
RUN_STAMP="$(date +%s)$(printf '%03d' $((RANDOM % 1000)))"
REPO="${SLACK_TRIGGER_REPO:-acme/verify-api-slack}-$RUN_STAMP"
# The message whose reply the fake records and then answers 500 for: `slack.ts`'s `messageTs(9)`.
LOST_ACK_TS="$RUN_STAMP.0009"

mkdir -p "$EVIDENCE_DIR"
adapter_init slack
LEDGER="$RUN_DIR/slack-ledger.json"
GITHUB_LEDGER="$RUN_DIR/github-ledger.json"
rm -f "$LEDGER" "$GITHUB_LEDGER"
trap adapter_cleanup EXIT
adapter_check_ports "$API_PORT" "$FAKE_PORT" "$GITHUB_PORT"

adapter_start_fake slack "$LEDGER" "$ROOT/.pi/skills/verify-api/slack-fake.ts" \
  SLACK_FAKE_PORT="$FAKE_PORT" SLACK_FAKE_LEDGER="$LEDGER" SLACK_FAKE_FAIL_AFTER_WRITE="$LOST_ACK_TS" || exit 1
adapter_start_fake github "$GITHUB_LEDGER" "$ROOT/.pi/skills/verify-api/github-fake.ts" \
  GITHUB_FAKE_PORT="$GITHUB_PORT" GITHUB_FAKE_LEDGER="$GITHUB_LEDGER" || exit 1

# `C0RANDOM` has a rule too, but is not a watched channel: the filter is the only thing standing
# between that message and a session, which is what the drive's check on it is about.
RULES="$(printf '[{"label":"C0ENG","repo":"%s","baseRef":"main","prompt":"Work on {{title}}:\\n{{body}}"},{"label":"C0RANDOM","repo":"%s","prompt":"Work on {{title}}:\\n{{body}}"}]' "$REPO" "$REPO")"
status=0

drive() { # mode
  MODE="$1" API_URL="$API_URL" SLACK_FAKE_LEDGER="$LEDGER" SLACK_GITHUB_LEDGER="$GITHUB_LEDGER" \
    SLACK_RUN_STAMP="$RUN_STAMP" SLACK_TRIGGER_REPO="$REPO" SLACK_SIGNING_SECRET="$SIGNING_SECRET" \
    SLACK_BOT_TOKEN="$BOT_TOKEN" EVIDENCE_DIR="$EVIDENCE_DIR" DATABASE_URL="$DATABASE_URL" \
    bun "$DRIVER" 2>&1 | tee "$EVIDENCE_DIR/slack-$1.log"
  return "${PIPESTATUS[0]}"
}

# --- configured: the route armed, the write-backs pointed at the fakes ----------------------------
adapter_start_api "$API_PORT" \
  TRIGGER_RULES="$RULES" \
  SLACK_SIGNING_SECRET="$SIGNING_SECRET" SLACK_BOT_TOKEN="$BOT_TOKEN" SLACK_CHANNELS="C0ENG" \
  SLACK_API_URL="http://127.0.0.1:$FAKE_PORT" SLACK_SESSION_URL_BASE="http://localhost:3000/sessions" \
  GITHUB_API_URL="http://127.0.0.1:$GITHUB_PORT" || exit 1
drive configured || status=1
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/slack-api.log"
adapter_stop_api

# --- unconfigured: the same API with no signing secret: every delivery, handshake included, is refused
adapter_start_api "$API_PORT" TRIGGER_RULES="$RULES" SLACK_SIGNING_SECRET="" SLACK_CHANNELS="C0ENG" || exit 1
drive unconfigured || status=1
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/slack-api-unconfigured.log"

cp "$LEDGER" "$EVIDENCE_DIR/slack-ledger.json" 2>/dev/null || true
cp "$GITHUB_LEDGER" "$EVIDENCE_DIR/slack-github-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/slack.log" "$EVIDENCE_DIR/slack-fake.log" 2>/dev/null || true

echo
if [ "$status" -eq 0 ]; then
  echo "slack: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "slack: FAILURES — see $EVIDENCE_DIR/slack-*.log" >&2
fi
exit "$status"
