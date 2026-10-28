#!/usr/bin/env bash
# Prove a repository's `.factory/config` policy, read at the base, governs its sessions' runs, over
# the real API (S-factory-config-as-code).
#
# The claim: a repo whose config requires approval for `bun publish` gets an approval prompt for it,
# and a repo without that config does not; a config that denies it refuses it outright; a config that
# tries to allow a host the deployment denies is rejected at load (`policy_rejected`); and an agent
# that rewrites `.factory/config` in its worktree — or a base that relaxes under a running session —
# does not change the policy of that session's run, across a restart, while a new session reads the
# base as it is now. See `features/repo-policy.md`.
#
# Its own API (./up.sh, on API_PORT, with its own run directory), booted twice — the second boot is
# a fresh process reopening the same logs — the faux model calling `./bin/bun publish` on every
# turn, and fixture repos with no remote under .verify/run/repo-policy/.
#
#   ./repo-policy.sh
#   API_PORT=9530 ./repo-policy.sh
#
# Env: DATABASE_URL (the run's own database), API_PORT, EVIDENCE_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9441}"
RUN_DIR="$ROOT/.verify/run/repo-policy"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"

if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $API_PORT is already in use — set API_PORT to a free one" >&2
  exit 1
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/repos" "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api"

# Every fixture commits `bin/bun`, which only echoes this marker: the gate reads `./bin/bun publish`
# as `bun publish`, and where nothing gates it the run executes the fixture's script, nothing else.
export REPO_POLICY_MARKER="fake-bun-publish-ran-$(date +%s)"
export FAUX_COMMAND="./bin/bun publish"
export FAUX_EVERY_TURN=true
# Long enough that the idle sweep never releases an owner between the drive's calls: the restart is
# what reopens them.
export SESSION_IDLE_TIMEOUT_MS=600000

stop() { VERIFY_RUN_DIR="$RUN_DIR" ./down.sh >/dev/null 2>&1 || true; }
# The restart between the phases stops the process and nothing else: `down.sh` also removes the
# session root, which holds the worktree the second phase reopens.
restart_stop() {
  local pid
  pid="$(cat "$RUN_DIR/api.pid" 2>/dev/null)" || return 0
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$RUN_DIR/api.pid"
}
trap 'cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/repo-policy-api.log" 2>/dev/null || true; stop' EXIT

drive() { # phase
  env \
    API_URL="http://localhost:$API_PORT" \
    DATABASE_URL="${DATABASE_URL:?repo-policy needs DATABASE_URL from the run}" \
    PHASE="$1" \
    REPO_POLICY_REPOS="$RUN_DIR/repos" \
    REPO_POLICY_STATE="$RUN_DIR/state.json" \
    EVIDENCE_DIR="$EVIDENCE_DIR" \
    bun "$ROOT/.pi/skills/verify-api/repo-policy.ts" 2>&1 | tee -a "$RUN_DIR/driver.log"
  return "${PIPESTATUS[0]}"
}

VERIFY_RUN_DIR="$RUN_DIR" API_PORT="$API_PORT" ./up.sh || exit 1
drive arm
ARM=$?
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/repo-policy-api-arm.log" 2>/dev/null || true
restart_stop
RC=1
if [ "$ARM" -eq 0 ] && VERIFY_RUN_DIR="$RUN_DIR" API_PORT="$API_PORT" ./up.sh; then
  drive verify
  RC=$?
fi
cp "$RUN_DIR/driver.log" "$EVIDENCE_DIR/repo-policy.log" 2>/dev/null || true
[ "$ARM" -eq 0 ] && [ "$RC" -eq 0 ]
