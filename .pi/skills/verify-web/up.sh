#!/usr/bin/env bash
# Launch an isolated instance of the web dashboard and the API behind it.
#
# Runs on its own ports so it never competes with a dev server you already have
# open. Kill it with ./down.sh — never by process name.
set -euo pipefail

# This suite runs its API with auth off (LOB-20): its clients send no credential, and it declares
# actors (a run's session id) that only an open control plane keeps. A token exported for the
# rest of the verify skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9100}"
WEB_PORT="${WEB_PORT:-3100}"
RUN_DIR="$ROOT/.verify/run"

mkdir -p "$RUN_DIR"

if [ -f "$RUN_DIR/api.pid" ] && kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null; then
  echo "already running (api pid $(cat "$RUN_DIR/api.pid")); run ./down.sh first" >&2
  exit 1
fi

# The dashboard reads the session log, which is Postgres: a dashboard on a database-less API has
# nothing worth driving. Shared with the other skills; it asks the port before it asks compose, so
# it works from a ralph worktree (LOB-57).
source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# API. ALLOWED_ORIGINS must name the web port or the browser's RPC call is blocked
# by CORS. MODEL_BACKEND=faux keeps the dashboard drive offline, deterministic, and
# free: the session card still runs a real bash tool call, but the model is scripted.
# The idle timeout is long so the card stays on the live read path for the whole drive.
#
# FAUX_COMMAND sleeps on purpose: the live-tasks panel (LOB-184) can only be driven
# while a task is on screen, and the bash tool's own task lasts exactly as long as the
# command it runs. `echo faux-ok` still ends the run, so the transcript checks are
# unaffected. This default applies to every verify-web drive, not only the live-tasks
# one: the run takes ~12s longer and up.sh's readiness wait is unaffected.
( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    ALLOWED_ORIGINS="http://localhost:$WEB_PORT" \
    MODEL_BACKEND="${MODEL_BACKEND:-faux}" \
    FAUX_COMMAND="${FAUX_COMMAND:-sleep 12; echo faux-ok}" \
    SESSION_ROOT="$RUN_DIR/sessions" \
    SESSION_IDLE_TIMEOUT_MS="${SESSION_IDLE_TIMEOUT_MS:-600000}" \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

# Sessions from a previous drive run would be re-read as historical folds; start clean.
rm -rf "$RUN_DIR/sessions"

# Web dashboard.
( cd "$ROOT/apps/web" && exec env \
    VITE_PORT="$WEB_PORT" \
    VITE_SERVER_URL="http://localhost:$API_PORT" \
    bun run dev ) > "$RUN_DIR/web.log" 2>&1 &
echo $! > "$RUN_DIR/web.pid"

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
  echo "failed to become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

echo "api  http://localhost:$API_PORT  (pid $(cat "$RUN_DIR/api.pid"))"
echo "web  http://localhost:$WEB_PORT  (pid $(cat "$RUN_DIR/web.pid"))"
