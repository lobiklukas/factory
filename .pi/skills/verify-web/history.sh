#!/usr/bin/env bash
# Prove a long session's earlier history in the dashboard (LOB-243): once its owner is released, the
# transcript pane shows the newest entries the historical read carries and a **Show earlier
# entries** control, and pressing it pages back until the first message is on screen.
#
# This script owns its own API and dashboard (its own ports, session root, logs and pid files),
# because the API needs a short idle timeout — the fold is the read under test — while ./up.sh keeps
# it long so its pane stays live. That instance is not touched, and this script leaves nothing
# running. The session is grown and released by the API drive `../verify-api/history.ts`, which
# checks the RPC half on the way; this drive is the browser half.
#
#   ./history.sh
#   HISTORY_API_PORT=9531 HISTORY_WEB_PORT=3531 ./history.sh      # another port pair
#
# Evidence: .verify/evidence/latest/history/ — history-*.png, observed.json, the API drive's
# history.json, api.log, web.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${HISTORY_API_PORT:-9437}"
WEB_PORT="${HISTORY_WEB_PORT:-3437}"
RUN_DIR="$ROOT/.verify/run/web-history"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/history"
WINDOW=200

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set HISTORY_API_PORT / HISTORY_WEB_PORT to free ones" >&2
    exit 1
  fi
done

stop() { # name
  local pidfile="$RUN_DIR/$1.pid"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

cleanup() {
  stop web
  stop api
  cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/api.log" 2>/dev/null || true
  cp "$RUN_DIR/web.log" "$EVIDENCE_DIR/web.log" 2>/dev/null || true
  rm -rf "$RUN_DIR/sessions"
}
trap cleanup EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

rm -rf "$RUN_DIR/sessions"

( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    ALLOWED_ORIGINS="http://localhost:$WEB_PORT" \
    MODEL_BACKEND=faux \
    SESSION_ROOT="$RUN_DIR/sessions" \
    SESSION_IDLE_TIMEOUT_MS=4000 \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

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
  echo "history: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

# Grow one session past the window and let its owner go, checking the RPC half as it does.
API_URL="http://localhost:$API_PORT" EVIDENCE_DIR="$EVIDENCE_DIR" HISTORY_WINDOW="$WINDOW" \
  bun "$ROOT/.pi/skills/verify-api/history.ts"
seeded=$?
if [ "$seeded" -ne 0 ]; then
  echo "history: the API drive failed — see $EVIDENCE_DIR/history.json" >&2
  exit 1
fi
SESSION="$(sed -n 's/^SESSION=//p' "$EVIDENCE_DIR/history-session.env")"
TURNS="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).turns)' "$EVIDENCE_DIR/history.json")"

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" SESSION="$SESSION" TURNS="$TURNS" \
  node "$ROOT/.pi/skills/verify-web/history.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "history: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "history: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
