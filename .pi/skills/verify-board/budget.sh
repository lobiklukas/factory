#!/usr/bin/env bash
# The budget on a board run, and raising a stopped session's cap (C23, docs/board.md B1): a run
# started with `factory board start --budget` or from the card pane's Start run (a Budget field) records
# its cap on the session; a cap that stops the run can be raised from the run's transcript (the
# **Raise cap** action under the stop) or with `factory budget`, and the session then runs again.
# `budget.mjs` does the work (browser, terminal and the server's reads); this is its prerequisites
# check, as `start-prompt.sh` is for `start-prompt.mjs`.
#
# Requires the instance from ./up.sh with a priced model, so a cap can be reached (API on API_PORT,
# default 9400; web on WEB_PORT, read from .verify/run/web-port; a seeded board in
# .verify/run/board.json):
#
#   FAUX_COST=0.01 ./up.sh && ./budget.sh && ./down.sh
#
# Evidence: .verify/evidence/latest/board/budget-web.json, budget-{stopped,raised}.png.
set -uo pipefail

# This suite runs its API with auth off (LOB-20): see up.sh.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run"
WEB_PORT="${WEB_PORT:-$(cat "$RUN_DIR/web-port" 2>/dev/null || echo 3400)}"
WEB_URL="${WEB_URL:-http://localhost:$WEB_PORT}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/board"
SKILL="$ROOT/.pi/skills/verify-board"

mkdir -p "$EVIDENCE_DIR"
rm -f "$EVIDENCE_DIR/budget-web.json" "$EVIDENCE_DIR"/budget-*.png

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi
if ! curl -sf -m 2 "$WEB_URL/" >/dev/null 2>&1; then
  echo "no dashboard at $WEB_URL — run ./up.sh first" >&2
  exit 1
fi
if [ ! -s "$RUN_DIR/board.json" ]; then
  echo "no seeded board in $RUN_DIR/board.json — run ./up.sh first" >&2
  exit 1
fi
BOARD_ID="$(sed -n 's/.*"boardId":"\([^"]*\)".*/\1/p' "$RUN_DIR/board.json")"

WEB_URL="$WEB_URL" API_URL="$API_URL" BOARD_ID="$BOARD_ID" EVIDENCE_DIR="$EVIDENCE_DIR" \
  node "$SKILL/budget.mjs"
exit $?
