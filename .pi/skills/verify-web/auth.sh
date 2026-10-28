#!/usr/bin/env bash
# Prove the dashboard sends the control-plane credential (LOB-20).
#
# Boots one API that requires a token (`FACTORY_API_TOKENS=dashboard-op=<token>`) and two dashboards
# against it: one built with `VITE_FACTORY_API_TOKEN` set to that token, one without. `auth.mjs` then
# checks, in a headless browser, that the first lists a session the API holds, sends
# `Authorization: Bearer` on its RPCs, and that its **New session** — whose body still says
# `actor: "dashboard"` — is recorded as `dashboard-op`; and that the second is refused
# `Unauthenticated` and shows no session. The token is minted per run and never written to evidence.
#
# This script owns its API and dashboards (its own ports, session root, logs and pid files), so the
# instance ./up.sh starts is not touched and nothing is left running.
#
#   DATABASE_URL=… ./auth.sh
#   AUTH_API_PORT=9520 AUTH_WEB_PORT=3520 AUTH_OPEN_WEB_PORT=3521 ./auth.sh
#
# Evidence: .verify/evidence/latest/auth/ — auth-*.png, observed.json, api.log, web*.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${AUTH_API_PORT:-9445}"
WEB_PORT="${AUTH_WEB_PORT:-3445}"
OPEN_WEB_PORT="${AUTH_OPEN_WEB_PORT:-3446}"
RUN_DIR="$ROOT/.verify/run/auth"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/auth"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT" "$OPEN_WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set AUTH_API_PORT / AUTH_WEB_PORT / AUTH_OPEN_WEB_PORT to free ones" >&2
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
  stop web-open
  stop web
  stop api
  cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/api.log" 2>/dev/null || true
  cp "$RUN_DIR/web.log" "$EVIDENCE_DIR/web.log" 2>/dev/null || true
  cp "$RUN_DIR/web-open.log" "$EVIDENCE_DIR/web-open.log" 2>/dev/null || true
  rm -rf "$RUN_DIR/sessions"
}
trap cleanup EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

AUTH_TOKEN="dashboard-op-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
export AUTH_TOKEN
rm -rf "$RUN_DIR/sessions"

( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    ALLOWED_ORIGINS="http://localhost:$WEB_PORT,http://localhost:$OPEN_WEB_PORT" \
    MODEL_BACKEND=faux \
    FAUX_COMMAND="echo faux-ok" \
    SESSION_ROOT="$RUN_DIR/sessions" \
    FACTORY_API_TOKEN= \
    FACTORY_API_TOKENS="dashboard-op=$AUTH_TOKEN" \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

( cd "$ROOT/apps/web" && exec env \
    VITE_PORT="$WEB_PORT" \
    VITE_SERVER_URL="http://localhost:$API_PORT" \
    VITE_FACTORY_API_TOKEN="$AUTH_TOKEN" \
    bun run dev ) > "$RUN_DIR/web.log" 2>&1 &
echo $! > "$RUN_DIR/web.pid"

( cd "$ROOT/apps/web" && exec env \
    VITE_PORT="$OPEN_WEB_PORT" \
    VITE_SERVER_URL="http://localhost:$API_PORT" \
    VITE_FACTORY_API_TOKEN= \
    bun run dev ) > "$RUN_DIR/web-open.log" 2>&1 &
echo $! > "$RUN_DIR/web-open.pid"

ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1 &&
     curl -sf -m 1 "http://localhost:$WEB_PORT/" >/dev/null 2>&1 &&
     curl -sf -m 1 "http://localhost:$OPEN_WEB_PORT/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "auth: the instance did not become ready in 30s — see $RUN_DIR/*.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" \
  OPEN_WEB_URL="http://localhost:$OPEN_WEB_PORT" \
  API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  node "$ROOT/.pi/skills/verify-web/auth.mjs"
status=$?
if grep -rqF -- "$AUTH_TOKEN" "$EVIDENCE_DIR/observed.json" "$RUN_DIR/api.log" 2>/dev/null; then
  echo "FAIL  the token's value is in the evidence or the API log" >&2
  status=1
else
  echo "PASS  the token's value is in neither the evidence nor the API log"
fi
exit "$status"
