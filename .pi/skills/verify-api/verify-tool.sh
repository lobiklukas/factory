#!/usr/bin/env bash
# Prove the `verify` tool through the real service (LOB-78, part 1 of LOB-16).
#
# The claim: a run that changes a surface and calls `verify` leaves the surface's verdict in its log —
# exit 0 with the skill's output, a non-zero exit with the output's tail and no crash, a typed
# no-evidence result for a surface with no skill, and the repo's declared `verify` command preferred
# over a skill that disagrees with it. See `features/verify-tool.md`.
#
# The script owns everything it touches — its own fixture repos and its own session root under
# `.verify/run/verify-tool/` — and starts no server: the driver builds `SessionService` in-process,
# as `./docs-run.sh` does, so there is no port to collide on. The model is the faux provider, and the
# fixture repos have no remote, so nothing here reaches a network.
#
#   ./verify-tool.sh
#
# Env: DATABASE_URL (required: the run's own database), EVIDENCE_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN_DIR="$ROOT/.verify/run/verify-tool"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/sessions" "$RUN_DIR/repos" "$EVIDENCE_DIR"

# The driver runs from its own directory: the root declares the workspace packages it imports
# (`@repo/core`, `@repo/harness`, `@repo/storage-postgres`), so they resolve from `.pi/`.
env \
  DATABASE_URL="${DATABASE_URL:?verify-tool needs DATABASE_URL from the run}" \
  SESSION_ROOT="$RUN_DIR/sessions" \
  VERIFY_TOOL_REPOS="$RUN_DIR/repos" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$ROOT/.pi/skills/verify-api/verify-tool.ts" 2>&1 | tee "$RUN_DIR/driver.log"
RC=${PIPESTATUS[0]}
cp "$RUN_DIR/driver.log" "$EVIDENCE_DIR/verify-tool.log" 2>/dev/null || true
exit "$RC"
