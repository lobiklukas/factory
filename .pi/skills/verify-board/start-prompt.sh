#!/usr/bin/env bash
# The start phase's first message (C6, docs/board.md B1): a card started from the board page's **Start
# run** (a prompt field pre-filled from the card, then **Send**) and the same card started with
# `factory board start` and no `--prompt` hand the run the same first `pi.user` entry — the card's
# title, its body and the column's instruction — and the run is busy. `--idle` still opens a run that
# waits. `start-prompt.mjs` does the work (browser, terminal and the server's reads); this is its
# prerequisites check, as `card-create.sh` is for `card-create.mjs`.
#
# Requires the instance from ./up.sh (API on API_PORT, default 9400; web on WEB_PORT, read from
# .verify/run/web-port; a seeded board in .verify/run/board.json):
#
#   ./up.sh && ./start-prompt.sh && ./down.sh
#
# Evidence: .verify/evidence/latest/board/start-prompt-web.json, start-prompt-{form,sent}.png.
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
rm -f "$EVIDENCE_DIR/start-prompt-web.json" "$EVIDENCE_DIR"/start-prompt-*.png

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
  node "$SKILL/start-prompt.mjs"
exit $?
