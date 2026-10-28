#!/usr/bin/env bash
# Prove a repository's AGENTS.md and SKILL.md skills reach every run, over the real API
# (S-repo-instructions-and-skills).
#
# The claim: a session on a repo is told its AGENTS.md as the `repo_instructions` section of its
# recorded prompt, and the log's `factory.repo.prompt` record says how big it is and what it cost; its
# `.pi/skills` / `.agents/skills` are an index of names and paths, and the run reads a listed skill
# from its worktree with its own `bash` — a skill `listSkills` (the factory's table) does not know; a
# repo with neither file is told nothing new; and a session on a clone of this repository is told this
# repository's own AGENTS.md and verify skills. See `features/repo-context.md`.
#
# Its own API (./up.sh, on API_PORT, with its own run directory), the faux model scripted to `cat`
# the fixture's skill, and fixture repos with no remote under .verify/run/repo-context/.
#
#   ./repo-context.sh
#   API_PORT=9530 ./repo-context.sh
#
# Env: DATABASE_URL (the run's own database), API_PORT, EVIDENCE_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9440}"
RUN_DIR="$ROOT/.verify/run/repo-context"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"

if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $API_PORT is already in use — set API_PORT to a free one" >&2
  exit 1
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/repos" "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api"

# The faux run's first turn reads the fixture's skill by the path its index names.
export REPO_CONTEXT_SKILL="verify-fixture-$(date +%s)"
export FAUX_COMMAND="cat .pi/skills/$REPO_CONTEXT_SKILL/SKILL.md 2>/dev/null || echo no-skill-here"
# Long enough that the idle sweep never releases an owner between the drive's calls.
export SESSION_IDLE_TIMEOUT_MS=600000

stop() { VERIFY_RUN_DIR="$RUN_DIR" ./down.sh >/dev/null 2>&1 || true; }
trap 'cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/repo-context-api.log" 2>/dev/null || true; stop' EXIT

VERIFY_RUN_DIR="$RUN_DIR" API_PORT="$API_PORT" ./up.sh || exit 1

env \
  API_URL="http://localhost:$API_PORT" \
  DATABASE_URL="${DATABASE_URL:?repo-context needs DATABASE_URL from the run}" \
  REPO_CONTEXT_REPOS="$RUN_DIR/repos" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$ROOT/.pi/skills/verify-api/repo-context.ts" 2>&1 | tee "$RUN_DIR/driver.log"
RC=${PIPESTATUS[0]}
cp "$RUN_DIR/driver.log" "$EVIDENCE_DIR/repo-context.log" 2>/dev/null || true
exit "$RC"
