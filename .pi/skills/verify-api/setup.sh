#!/usr/bin/env bash
# Prove a worktree's declared setup over the real API (S-env-setup).
#
# The claim: a session on a repo whose `.factory/config` declares `install` and `build` gets them run
# in its fresh worktree before the agent's first turn, so the run's `verify` passes without the agent
# installing anything; a failing install refuses the first message `setup_failed`, parks the card
# with that reason and the output's tail, keeps the tail in the log, and calls no model; and the
# registry answers each checkout's readiness score; a webhook delivery is answered before its
# session's install finishes, and its prompt sent after; a session on a clone of this repo runs
# the repo's own `bun install`; a replay is set up before its first model call (F23); and, once the
# API is restarted with `SETUP_TIMEOUT_SECONDS=1`, a session whose worktree directory was deleted is
# cut and set up again, and an install that sleeps 5 s fails with the timeout and parks its card
# (F23, F24). See `features/setup.md`.
#
# Its own API (./up.sh, on API_PORT, with its own run directory), the faux model scripted to probe
# for `node_modules` and then call `verify`, and fixture repos with no remote under
# .verify/run/setup/: the install is `bun install` of a `file:` dependency, so nothing leaves the
# machine.
#
#   ./setup.sh
#   API_PORT=9520 ./setup.sh
#
# Env: DATABASE_URL (the run's own database), API_PORT, EVIDENCE_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
RUN_DIR="$ROOT/.verify/run/setup"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"

if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $API_PORT is already in use — set API_PORT to a free one" >&2
  exit 1
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/repos" "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api"

# The faux run's first turn: did its worktree have the dependencies when the agent started? Then a
# change for `verify` to measure, and `FAUX_VERIFY` makes the next turn call it.
export FAUX_COMMAND='if [ -d node_modules/local-dep ] || [ -d node_modules/effect ]; then echo "deps-present"; else echo "deps-missing"; fi; mkdir -p src && echo 1 > src/feature.txt'
export FAUX_VERIFY=true
# The `triggered` scenario's generic webhook route: one rule mapping the `factory` label to a repo
# of this run's own, whose install sleeps, and the secret the drive signs with.
export SETUP_TRIGGER_REPO="verify-setup-$(date +%s)/triggered"
export TRIGGER_SECRET="verify-setup-trigger-secret"
TRIGGER_RULES="$(printf '[{"label":"factory","repo":"%s","baseRef":"main","prompt":"Work on {{title}}: {{body}}"}]' "$SETUP_TRIGGER_REPO")"
export TRIGGER_RULES
# Long enough that the idle sweep never releases an owner between the drive's calls.
export SESSION_IDLE_TIMEOUT_MS=600000

stop() { VERIFY_RUN_DIR="$RUN_DIR" ./down.sh >/dev/null 2>&1 || true; }
trap 'cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/setup-api.log" 2>/dev/null || true; stop' EXIT

VERIFY_RUN_DIR="$RUN_DIR" API_PORT="$API_PORT" ./up.sh || exit 1

env \
  API_URL="http://localhost:$API_PORT" \
  DATABASE_URL="${DATABASE_URL:?setup needs DATABASE_URL from the run}" \
  SETUP_REPOS="$RUN_DIR/repos" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$ROOT/.pi/skills/verify-api/setup.ts" 2>&1 | tee "$RUN_DIR/driver.log"
RC=${PIPESTATUS[0]}
cp "$RUN_DIR/driver.log" "$EVIDENCE_DIR/setup.log" 2>/dev/null || true

# The parked card as the CLI shows it: `blocked   setup_failed …`, and the note's lines under it.
TASK_ID="$(bun -e 'const o = await Bun.file(process.argv[1]).json(); console.log(o.broken?.taskId ?? "")' "$EVIDENCE_DIR/setup.json" 2>/dev/null)"
bun "$ROOT/apps/cli/src/index.ts" board show --task "$TASK_ID" --api "http://localhost:$API_PORT" \
  > "$EVIDENCE_DIR/setup-board-show.txt" 2>&1
if grep -qE '^blocked   setup_failed from ' "$EVIDENCE_DIR/setup-board-show.txt" &&
   grep -qE '^ +setup failed: install .* exited 7 in ' "$EVIDENCE_DIR/setup-board-show.txt" &&
   grep -qE '^ +error: registry unreachable$' "$EVIDENCE_DIR/setup-board-show.txt"; then
  echo "PASS  factory board show prints the setup_failed block and its note"
else
  echo "FAIL  factory board show prints the setup_failed block and its note (see setup-board-show.txt)" >&2
  RC=1
fi

# --- the restarted API: SETUP_TIMEOUT_SECONDS=1, and no owner holding any session (F23, F24) -------
# A fresh process holds no owner, which is what lets the drive delete a session's worktree directory
# and have its next send cut it again; and the bound is the deployment's setting, so the API is
# started the way `bun run dev` starts it (API_VIA_TURBO=1, whose strict env mode strips a variable
# apps/api/turbo.json does not declare) with SETUP_TIMEOUT_SECONDS=1.
cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/setup-api-first-boot.log" 2>/dev/null || true
# Not ./down.sh: it removes the session root, and the sessions (their worktrees among them) are
# what the restarted phase drives.
if [ -f "$RUN_DIR/api.pid" ]; then
  pid="$(cat "$RUN_DIR/api.pid")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$RUN_DIR/api.pid"
fi
VERIFY_RUN_DIR="$RUN_DIR" API_PORT="$API_PORT" SETUP_TIMEOUT_SECONDS=1 API_VIA_TURBO=1 ./up.sh || exit 1
env \
  PHASE=restarted \
  API_URL="http://localhost:$API_PORT" \
  DATABASE_URL="${DATABASE_URL:?setup needs DATABASE_URL from the run}" \
  SETUP_REPOS="$RUN_DIR/repos" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$ROOT/.pi/skills/verify-api/setup.ts" 2>&1 | tee "$RUN_DIR/driver-restarted.log"
RESTARTED_RC=${PIPESTATUS[0]}
cp "$RUN_DIR/driver-restarted.log" "$EVIDENCE_DIR/setup-restarted.log" 2>/dev/null || true
[ "$RESTARTED_RC" -eq 0 ] || RC=1
exit "$RC"
