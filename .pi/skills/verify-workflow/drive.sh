#!/usr/bin/env bash
# Drive the whole loop on one card (LOB-40) against the instance ./up.sh started: `drive.ts` holds the
# phases and their checks, and runs verify-board's probes (`build.ts`, `review.ts`, `merge.ts`) for the
# facts they already prove. Exits non-zero when any check fails.
#
#   ./drive.sh           the faux instance (./up.sh)
#   ./drive.sh --live    the owner's live instance (./up.sh --live); refuses, naming each variable,
#                        without live-env.sh's variables — before it reads or starts anything
#
# DATABASE_URL is the base URL ./up.sh was given (the drive reads the instance's scratch database from
# it); EVIDENCE_DIR overrides .verify/evidence/latest.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL="$ROOT/.pi/skills/verify-workflow"

# This suite runs its API with auth off (LOB-20), as verify-board's does.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

# shellcheck source=live-env.sh
source "$SKILL/live-env.sh"
if [ "${1:-}" = "--live" ]; then
  live_refusal "drive.sh" || exit $?
fi

if [ ! -s "$ROOT/.verify/run/workflow/instance.json" ]; then
  echo "no workflow instance — run ./up.sh${1:+ $1} first" >&2
  exit 1
fi
WF_DIR="$ROOT/.verify/run/workflow"
# shellcheck source=instance-env.sh
source "$SKILL/instance-env.sh"
if ! curl -sf -m 2 "$(workflow_field apiUrl)/readyz" >/dev/null 2>&1; then
  echo "the instance's API is not ready — ./doctor.sh says why" >&2
  exit 1
fi

export LANG="${LANG:-en_US.UTF-8}" LC_ALL="${LC_ALL:-en_US.UTF-8}"
exec bun "$SKILL/drive.ts" "$@"
