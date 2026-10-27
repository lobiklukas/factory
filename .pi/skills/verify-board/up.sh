#!/usr/bin/env bash
# Launch an isolated API and dashboard for the board drive, then seed one board.
#
# `factory board` is a client, so the skill starts its own control plane: its own port (9400 by
# default), its own session root under .verify/run, and a pid in .verify/run/api.pid so ./down.sh
# stops exactly this one. The dashboard runs beside it on WEB_PORT (3400 by default, pid in
# .verify/run/web.pid): the drive's last phase reads the board back in a browser (LOB-84).
#
# MODEL_BACKEND=faux keeps `board start` offline: opening a run is real (a session, a worktree, a
# `factory.task` document), only the model behind it is scripted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
WEB_PORT="${WEB_PORT:-3400}"
RUN_DIR="$ROOT/.verify/run"
DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
export DATABASE_URL

mkdir -p "$RUN_DIR"

if [ -f "$RUN_DIR/api.pid" ] && kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null; then
  echo "already running (api pid $(cat "$RUN_DIR/api.pid")); run ./down.sh first" >&2
  exit 1
fi

# Postgres holds the cards themselves, so a drive without it proves nothing. The shared check asks
# the port before it asks compose (LOB-57): compose derives its project name from the directory it
# runs in, and a ralph worktree asking for 5442 a second time fights the human's container.
source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# A throwaway git repo whose `origin` is a local bare repository, so a scripted git command can
# never reach a real remote (LOB-94) — `board start` cuts a worktree here.
SESSION_ROOT="$RUN_DIR/sessions"
ORIGIN_DIR="$RUN_DIR/origin.git"
if [ ! -d "$SESSION_ROOT/.git" ]; then
  rm -rf "$SESSION_ROOT" "$ORIGIN_DIR"
  mkdir -p "$SESSION_ROOT"
  git init -q -b main "$SESSION_ROOT"
  git -C "$SESSION_ROOT" config user.email verify-board@localhost
  git -C "$SESSION_ROOT" config user.name "verify-board"
  git -C "$SESSION_ROOT" commit -q --allow-empty -m "verify-board session root"
  git init -q -b main --bare "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" remote add origin "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" push -q origin main
fi

( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    HOST="127.0.0.1" \
    ALLOWED_ORIGINS="http://localhost:$API_PORT,http://localhost:$WEB_PORT" \
    MODEL_BACKEND="${MODEL_BACKEND:-faux}" \
    SESSION_ROOT="$SESSION_ROOT" \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"
echo "$WEB_PORT" > "$RUN_DIR/web-port"

# The dashboard, pointed at this API. ALLOWED_ORIGINS above names its origin, or the browser's RPC
# call is blocked by CORS.
( cd "$ROOT/apps/web" && exec env \
    VITE_PORT="$WEB_PORT" \
    VITE_SERVER_URL="http://localhost:$API_PORT" \
    bun run dev ) > "$RUN_DIR/web.log" 2>&1 &
echo $! > "$RUN_DIR/web.pid"

# Ready means `/readyz` says so, not that the port answers: the server binds before its migrations
# are applied (LOB-21), so `/` is true a moment before a card can be read.
ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1 &&
     curl -sf -m 1 "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "api or web did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

# One board, through the service rather than SQL string-building. The drive creates its own card
# through the API (create.ts), so the seed makes none.
if ! SEED_CARD=0 bun run "$ROOT/.pi/skills/verify-board/seed.ts" > "$RUN_DIR/board.json"; then
  echo "seed failed — see $RUN_DIR/board.json" >&2
  exit 1
fi

echo "api  http://localhost:$API_PORT  (pid $(cat "$RUN_DIR/api.pid"))"
echo "web  http://localhost:$WEB_PORT  (pid $(cat "$RUN_DIR/web.pid"))"
echo "board $(cat "$RUN_DIR/board.json")"
