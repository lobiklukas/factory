#!/usr/bin/env bash
# Prove the outcome metrics' read and the merge record behind it (LOB-44), across the real surfaces.
#
#   DATABASE_URL=postgres://…/factory_<slug> API_PORT=9200 ./outcomes.sh
#
# Boots this skill's API (./up.sh, faux) with a GitHub webhook secret and `GITHUB_API_URL` at a
# loopback port nothing listens on, so no delivery can reach github.com. `outcomes.ts` then creates a
# Linear-delegated session and a direct one over RPC, links the first to a PR, delivers a signed
# merge of that PR and a signed merge of a person's revert of it to `POST /webhooks/github`, and asks
# `factory outcomes --json` (the CLI, over RPC) for the window: the delegation's lead time, the
# revert, adoption by trigger and cost are checked against what the drive itself wrote, and the
# merge is read back from the session's log (`factory.merge`).
#
# Env: API_PORT (9200 when unset), DATABASE_URL (required: up.sh migrates it), EVIDENCE_DIR.
# Evidence: .verify/evidence/latest/api/outcomes.json (every check, the report, the log's record),
# outcomes-report.txt (the CLI's table) and outcomes-api.log (the API's own log).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "outcomes.sh needs DATABASE_URL naming this worktree's own database (never the shared default)" >&2
  exit 1
fi
mkdir -p "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api" || exit 1

export OUTCOMES_WEBHOOK_SECRET="verify-api-outcomes-secret-$(date +%s)$$"

./down.sh >/dev/null 2>&1 || true
trap './down.sh >/dev/null 2>&1 || true' EXIT

API_PORT="$API_PORT" \
  MODEL_BACKEND=faux \
  GITHUB_WEBHOOK_SECRET="$OUTCOMES_WEBHOOK_SECRET" \
  GITHUB_API_URL="http://127.0.0.1:$((API_PORT + 1))" \
  ./up.sh || exit 1

API_URL="http://localhost:$API_PORT" EVIDENCE_DIR="$EVIDENCE_DIR" ROOT="$ROOT" bun outcomes.ts
status=$?
cp "$ROOT/.verify/run/api.log" "$EVIDENCE_DIR/outcomes-api.log"
if grep -qF "github: recorded a merge on 1 session(s)" "$EVIDENCE_DIR/outcomes-api.log"; then
  echo "PASS  the API log says it recorded the merge"
else
  echo "FAIL  the API log does not say it recorded the merge" >&2
  status=1
fi
echo "evidence: $EVIDENCE_DIR/outcomes.json"
exit "$status"
