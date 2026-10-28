#!/usr/bin/env bash
# Prove the Triggers page (T4): `/triggers` lists what the trigger seam recorded for each delivery,
# newest first, with its outcome, source, session and the seam's reason verbatim; the outcome and
# source filters narrow it; "Show older" pages past the first fifty; and a delivery that arrives while
# the page is open shows up without a reload.
#
# This script owns its own API and dashboard (its own ports, session root, logs and pid files),
# because the deliveries need a signing secret and a label → repo rule, both deployment settings. The
# instance ./up.sh starts is not touched, and nothing is left running. The webhooks are posted from
# the drive, signed with the secret this script booted the API with; nothing leaves loopback.
#
#   ./triggers.sh
#   TRIGGERS_API_PORT=9553 TRIGGERS_WEB_PORT=3553 ./triggers.sh      # another port pair
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does.
# Evidence: .verify/evidence/latest/triggers/ — triggers-*.png, observed.json, api.log, web.log.
set -uo pipefail

# This suite runs its API with auth off (LOB-20): its clients send no credential.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${TRIGGERS_API_PORT:-9475}"
WEB_PORT="${TRIGGERS_WEB_PORT:-3475}"
RUN_DIR="$ROOT/.verify/run/triggers"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/triggers"
SECRET="verify-web-triggers-secret"
TAG="$(date +%s)$$"
REPO="acme/web-triggers-$TAG"
GHOST="acme/web-triggers-ghost-$TAG"
RULES="[{\"label\":\"t4-ok\",\"repo\":\"$REPO\",\"baseRef\":\"main\",\"prompt\":\"{{title}}\"},{\"label\":\"t4-ghost\",\"repo\":\"$GHOST\",\"prompt\":\"{{title}}\"}]"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set TRIGGERS_API_PORT / TRIGGERS_WEB_PORT to free ones" >&2
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
    FAUX_COMMAND="echo faux-ok" \
    TRIGGER_SECRET="$SECRET" \
    TRIGGER_RULES="$RULES" \
    SESSION_ROOT="$RUN_DIR/sessions" \
    SESSION_IDLE_TIMEOUT_MS=600000 \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

( cd "$ROOT/apps/web" && exec env \
    VITE_PORT="$WEB_PORT" \
    VITE_SERVER_URL="http://localhost:$API_PORT" \
    bun run dev ) > "$RUN_DIR/web.log" 2>&1 &
echo $! > "$RUN_DIR/web.pid"

ready=0
for _ in $(seq 1 240); do
  if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1 &&
     curl -sf -m 1 "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "triggers: the instance did not become ready in 120s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" RUN_DIR="$RUN_DIR" \
  TRIGGER_SECRET="$SECRET" TRIGGERS_REPO="$REPO" TRIGGERS_GHOST="$GHOST" \
  node "$ROOT/.pi/skills/verify-web/triggers.mjs"
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "triggers: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "triggers: FAILURES — see $EVIDENCE_DIR/observed.json" >&2
fi
exit "$rc"
