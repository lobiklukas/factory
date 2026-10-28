#!/usr/bin/env bash
# Prove admission control (LOB-70): with SESSION_MAX_CONCURRENT=N, the N-th concurrent createSession
# succeeds, the N+1th is refused with the typed `at_capacity` code naming the cap, a signed trigger
# delivery is answered 503 at-capacity with Retry-After, and once the idle sweep releases the owners
# the same create succeeds and the same delivery is processed.
#
# This script owns its own API instance — its own port, session root, log and pid file — because the
# instance needs the cap, a short idle timeout and a signed generic route with a rule, none of which
# the instance ./up.sh starts carries. It leaves nothing running.
#
#   DATABASE_URL=postgres://…/factory_<slug> ./admission.sh
#   ADMISSION_PORT=9500 ADMISSION_CAP=3 ./admission.sh
#
# Env: ADMISSION_PORT (9432 when unset), ADMISSION_CAP (2; at least 2), ADMISSION_IDLE_MS (3000), DATABASE_URL
# (the API's database; the shell's own when unset, as every skill), EVIDENCE_DIR.
# Evidence: .verify/evidence/latest/api/admission.json (every check the driver made, the refusal and
# the webhook answers), admission-process.json (this script's checks) and admission-api.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${ADMISSION_PORT:-9432}"
CAP="${ADMISSION_CAP:-2}"
IDLE_MS="${ADMISSION_IDLE_MS:-3000}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/admission"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
SECRET="verify-admission-secret"
REPO="acme/verify-admission"
CHECKOUT="$RUN_DIR/checkout"

# The retried create takes one slot once the sweep frees them, and the redelivery needs another, so
# a cap of 1 would refuse the drive's own last check.
case "$CAP" in
  ''|*[!0-9]*) echo "ADMISSION_CAP must be a whole number, at least 2 (got '$CAP')" >&2; exit 1 ;;
esac
if [ "$CAP" -lt 2 ]; then
  echo "ADMISSION_CAP must be at least 2 (got $CAP): the retried create and the redelivery each take a slot" >&2
  exit 1
fi

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-60s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-60s %s\n' "$1" "$3"
  fi
}

write_checks() {
  local first=1
  local row
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n'
}

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — set ADMISSION_PORT to a free one" >&2
  exit 1
fi

# The repo the trigger rule maps to: a checkout on `main` the drive registers by its path.
rm -rf "$CHECKOUT" "$RUN_DIR/sessions"
git init -q -b main "$CHECKOUT"
git -C "$CHECKOUT" -c user.email=verify@localhost -c user.name=verify commit -q --allow-empty -m base

start_api() {
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS="$IDLE_MS" \
      SESSION_MAX_CONCURRENT="$CAP" \
      TRIGGER_SECRET="$SECRET" \
      TRIGGER_RULES="[{\"label\":\"factory\",\"repo\":\"$REPO\",\"baseRef\":\"main\",\"prompt\":\"Work on {{title}}: {{body}}\"}]" \
      bun run src/index.ts ) >> "$LOG" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
}

wait_ready() {
  for _ in $(seq 1 60); do
    curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

stop_api() {
  local pidfile="$RUN_DIR/api.pid"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

trap 'stop_api' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

: > "$LOG"
start_api
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

check "the API logs the cap it was started with" \
  "$(grep -q "session admission: at most $CAP concurrent sessions (SESSION_MAX_CONCURRENT)" "$LOG" && echo 0 || echo 1)" \
  "SESSION_MAX_CONCURRENT=$CAP"

# --- the driver: the RPC client the CLI and the dashboard build, and a signed trigger delivery ------
API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" CAP="$CAP" IDLE_TIMEOUT_MS="$IDLE_MS" \
  TRIGGER_SECRET="$SECRET" ADMISSION_REPO="$REPO" ADMISSION_CHECKOUT="$CHECKOUT" \
  bun "$ROOT/.pi/skills/verify-api/admission.ts" > "$RUN_DIR/driver.log" 2>&1
DRIVER_RC=$?
cat "$RUN_DIR/driver.log"
check "the driver passes its checks" "$([ "$DRIVER_RC" = "0" ] && echo 0 || echo 1)" "exit=$DRIVER_RC"

# The route's refusal is logged with its code, as every refusal before the seam is.
check "the API log records the at-capacity refusal on the trigger route" \
  "$(grep -q 'webhook /webhooks/generic: refused at-capacity' "$LOG" && echo 0 || echo 1)" \
  "refused at-capacity"

cp "$LOG" "$EVIDENCE_DIR/admission-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "cap": %s,\n' "$CAP"
  printf '  "idleTimeoutMs": %s,\n' "$IDLE_MS"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/admission-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "admission: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "admission: FAILURES — see $EVIDENCE_DIR/admission-process.json" >&2
fi
exit "$failed"
