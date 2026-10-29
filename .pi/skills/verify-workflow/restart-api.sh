#!/usr/bin/env bash
# Restart the workflow instance's API mid-run (LOB-40): verify-board's `up.sh --restart-api`, under the
# environment `up.sh` launched it with (`instance-env.sh`), so the process that comes back serves the
# same label mapping, Linear, forge, approval gate and model. The dashboard, the fakes and the
# database are not touched — what the restart may not lose is in Postgres.
#
#   ./restart-api.sh [KILL|TERM]   KILL by default: the process gets no chance to tidy up
#
# DATABASE_URL is the base URL `up.sh` was given; the scratch database is read from the instance. In
# live mode the owner's credentials must still be exported, as for `up.sh --live`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL="$ROOT/.pi/skills/verify-workflow"
WF_DIR="$ROOT/.verify/run/workflow"
WORKFLOW_BASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"

if [ ! -s "$WF_DIR/instance.json" ]; then
  echo "no workflow instance in $WF_DIR — run ./up.sh first" >&2
  exit 1
fi
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH
# shellcheck source=instance-env.sh
source "$SKILL/instance-env.sh"
if [ "$(workflow_field mode)" = "live" ]; then
  # shellcheck source=live-env.sh
  source "$SKILL/live-env.sh"
  live_refusal "restart-api.sh" || exit $?
fi
workflow_export_env
exec "$ROOT/.pi/skills/verify-board/up.sh" --restart-api "${1:-KILL}"
