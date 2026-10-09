#!/usr/bin/env bash
# Prove readiness degrades honestly (LOB-21): with Postgres stopped, the API still binds and serves
# `/livez` 200 while `/readyz` reports 503 naming what is missing; when Postgres returns, readiness
# recovers without a restart.
#
#   ./degraded.sh
#
# This script stops and starts the local Postgres container — the container publishing 5442, by
# name, whichever compose project owns it. It always brings it back up — a trap,
# so a failure half way through does not leave the database down — and it leaves no API running.
#
# Evidence: .verify/evidence/latest/api/degraded-{down,up}.json, degraded-process.json, and
# degraded-api.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${DEGRADED_PORT:-9500}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/degraded"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
DRIVER="$ROOT/.pi/skills/verify-api/degraded.ts"
LOG="$RUN_DIR/api.log"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-52s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-52s %s\n' "$1" "$3"
  fi
}

# The checks as a JSON object keyed by name, matching the drivers' evidence files.
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

start_api() {
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      SESSION_ROOT="$RUN_DIR/sessions" \
      bun run src/index.ts ) >> "$LOG" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
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

source "$ROOT/.pi/skills/lib/postgres.sh"

# The database has to come down and go back up, so this needs the container that actually serves
# 5442, addressed by name: `docker compose stop postgres` names this directory's project, which in
# a ralph worktree is `factory-ralph` and owns no such container, while the human's
# `factory-postgres-1` keeps the port (LOB-57).
ensure_postgres || exit 1
PG_CONTAINER="$(pg_port_owner)"
if [ -z "$PG_CONTAINER" ]; then
  echo "port $PG_PORT answers but no container publishes it; stop that database yourself and re-run" >&2
  exit 1
fi

postgres_down() { pg_docker stop "$PG_CONTAINER" >/dev/null 2>&1; }
postgres_up() {
  pg_docker start "$PG_CONTAINER" >/dev/null 2>&1 || return 1
  # Up means the port answers again; the healthcheck is not visible from here and the `up` phase
  # polls `/readyz` for the rest of the recovery.
  for _ in $(seq 1 120); do pg_port_open && return 0; sleep 0.5; done
  return 1
}

# The database comes back whatever happens: leaving it down would break every other suite here.
trap 'stop_api || true; postgres_up || echo "warning: $PG_CONTAINER did not come back" >&2' EXIT

: > "$LOG"

postgres_down
check "postgres is stopped for the test" "$(pg_docker ps --format '{{.Names}}' | grep -qxF "$PG_CONTAINER" && echo 1 || echo 0)" "container $PG_CONTAINER absent from docker ps"

start_api
# The server must bind with no database at all: wait for the liveness probe, not readiness.
bound=0
for _ in $(seq 1 60); do
  curl -sf -m 1 "$API_URL/livez" >/dev/null 2>&1 && { bound=1; break; }
  sleep 0.5
done
check "the server binds with the database down" \
  "$([ "$bound" = "1" ] && echo 0 || echo 1)" \
  "livez reachable=$bound"
API_PID="$(cat "$RUN_DIR/api.pid")"

MODE=down API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" bun "$DRIVER" > "$RUN_DIR/down.log" 2>&1
DOWN_RC=$?
cat "$RUN_DIR/down.log"
check "the degraded phase passes its checks" "$([ "$DOWN_RC" = "0" ] && echo 0 || echo 1)" "exit=$DOWN_RC"

postgres_up || { echo "postgres did not come back" >&2; exit 1; }

MODE=up API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_DIR" bun "$DRIVER" > "$RUN_DIR/up.log" 2>&1
UP_RC=$?
cat "$RUN_DIR/up.log"
check "the recovery phase passes its checks" "$([ "$UP_RC" = "0" ] && echo 0 || echo 1)" "exit=$UP_RC"
check "the same process served both phases (no restart)" \
  "$([ "$(cat "$RUN_DIR/api.pid")" = "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null && echo 0 || echo 1)" \
  "pid=$API_PID"

cp "$LOG" "$EVIDENCE_DIR/degraded-api.log"
{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/degraded-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "degraded: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "degraded: FAILURES — see $EVIDENCE_DIR/degraded-process.json" >&2
fi
exit "$failed"
