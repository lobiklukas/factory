#!/usr/bin/env bash
# Drive the Linear write-back end to end (LOB-15): a delegated issue reaches In Review with its PR
# on it, a failed run explains itself, and no retry writes anything twice.
#
#   ./linear-writeback.sh
#
# The driver builds the seam and the session layer in-process (`linear-writeback.ts`), so there is
# no API instance here: the two ports are the two loopback fakes — Linear's GraphQL API
# (`linear-api-fake.ts`) and GitHub's PR endpoint (`github-fake.ts`). Only Linear and GitHub are
# fake: the seam, the session layer, the PR step's worktree and the run's Postgres are real.
#
# The repo the session works in is a throwaway git repository with a `main` branch, registered with
# a local path, so the PR step measures a real branch; no git call reaches a remote.
#
# Env: LINEAR_WRITEBACK_PORT (the Linear fake; `API_PORT`, else 9416), LINEAR_WRITEBACK_GITHUB_PORT
# (the GitHub fake; the Linear port + 1), DATABASE_URL, EVIDENCE_DIR.
#
# What the fakes cannot prove: that Linear accepts these GraphQL documents as spelled, that its
# `attachmentCreate` and `issueUpdate` answer as read here, or that `comments(first: 250)` is the
# thread a retry needs to see. The request shapes are asserted in
# `packages/core/src/LinearSync.test.ts` from Linear's documented schema; the fakes are only as
# right as that reading. See `docs/testing-third-parties.md`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${LINEAR_WRITEBACK_PORT:-${API_PORT:-9416}}"
GH_PORT="${LINEAR_WRITEBACK_GITHUB_PORT:-$((PORT + 1))}"
RUN_DIR="$ROOT/.verify/run/linear-writeback"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/lob-15}"
LEDGER="$RUN_DIR/linear-ledger.json"
GH_LEDGER="$RUN_DIR/github-ledger.json"
SESSION_ROOT="$RUN_DIR/sessions"
REPO_DIR="$RUN_DIR/repo"
DRIVER="$ROOT/.pi/skills/verify-api/linear-writeback.ts"
FAKE="$ROOT/.pi/skills/verify-api/linear-api-fake.ts"
GH_FAKE="$ROOT/.pi/skills/verify-api/github-fake.ts"
RUN_STAMP="$(date +%s)$(printf '%03d' $((RANDOM % 1000)))"
LOSE_ACK_ISSUE="LOSE-$RUN_STAMP"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR" "$SESSION_ROOT"
rm -f "$LEDGER" "$GH_LEDGER"

stop() { # pid file
  [ -f "$1" ] || return 0
  local pid; pid="$(cat "$1")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$1"
}

trap 'stop "$RUN_DIR/linear.pid"; stop "$RUN_DIR/github.pid"' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

for port in "$PORT" "$GH_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use; set LINEAR_WRITEBACK_PORT to a free block" >&2
    exit 1
  fi
done

# The repo the session works in: a real `main`, so the PR step has a branch to measure.
if [ ! -d "$REPO_DIR/.git" ]; then
  rm -rf "$REPO_DIR"
  mkdir -p "$REPO_DIR"
  git init -q -b main "$REPO_DIR"
  git -C "$REPO_DIR" config user.email linear-writeback@localhost
  git -C "$REPO_DIR" config user.name "linear-writeback-drive"
  echo "# drive repo" > "$REPO_DIR/README.md"
  git -C "$REPO_DIR" add README.md
  git -C "$REPO_DIR" commit -q -m "linear write-back drive repo"
fi

# --- the two loopback vendors -----------------------------------------------------------------
: > "$RUN_DIR/linear-fake.log"
( exec env LINEAR_FAKE_PORT="$PORT" LINEAR_FAKE_LEDGER="$LEDGER" \
    LINEAR_FAKE_LOSE_ACK="$LOSE_ACK_ISSUE" bun "$FAKE" ) >> "$RUN_DIR/linear-fake.log" 2>&1 &
echo $! > "$RUN_DIR/linear.pid"
: > "$RUN_DIR/github-fake.log"
( exec env GITHUB_FAKE_PORT="$GH_PORT" GITHUB_FAKE_LEDGER="$GH_LEDGER" \
    bun "$GH_FAKE" ) >> "$RUN_DIR/github-fake.log" 2>&1 &
echo $! > "$RUN_DIR/github.pid"
for _ in $(seq 1 60); do
  [ -s "$LEDGER" ] && [ -s "$GH_LEDGER" ] && break
  sleep 0.1
done
if [ ! -s "$LEDGER" ] || [ ! -s "$GH_LEDGER" ]; then
  echo "a fake did not start — see $RUN_DIR/*-fake.log" >&2
  exit 1
fi

# --- the drive ---------------------------------------------------------------------------------
env \
  LINEAR_FAKE_URL="http://127.0.0.1:$PORT" \
  LINEAR_FAKE_LEDGER="$LEDGER" \
  LINEAR_RUN_STAMP="$RUN_STAMP" \
  LINEAR_LOSE_ACK_ISSUE="$LOSE_ACK_ISSUE" \
  GITHUB_API_URL="http://127.0.0.1:$GH_PORT" \
  SESSION_ROOT="$SESSION_ROOT" \
  REPO_DIR="$REPO_DIR" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  DATABASE_URL="${DATABASE_URL:?linear-writeback.sh needs DATABASE_URL from the run}" \
  bun "$DRIVER" 2>&1 | tee "$EVIDENCE_DIR/linear-writeback.log"
STATUS="${PIPESTATUS[0]}"

cp "$LEDGER" "$EVIDENCE_DIR/linear-ledger.json" 2>/dev/null || true
cp "$GH_LEDGER" "$EVIDENCE_DIR/github-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/linear-fake.log" "$EVIDENCE_DIR/linear-fake.log" 2>/dev/null || true

echo
if [ "$STATUS" -eq 0 ]; then
  echo "linear-writeback: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "linear-writeback: FAILURES — see $EVIDENCE_DIR/linear-writeback.log" >&2
fi
exit "$STATUS"
