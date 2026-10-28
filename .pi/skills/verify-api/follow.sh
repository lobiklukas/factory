#!/usr/bin/env bash
# Prove cross-process streaming (LOB-18, D12): two API processes over one database, one owning a
# session and one not, both streaming it live. The owner holds the session's presence lease; the
# follower sees the lease, follows the log — woken by the commit bus (`LISTEN factory_commits`) and
# a poll under it — and its stream carries what the owner's transcript holds, entry for entry. When
# the owner is stopped its lease goes, the follower's stream ends, and the session is the follower's
# to take. The steps and checks are in follow.ts.
#
# This script owns both API instances — their own ports, session roots, logs and pid files — and
# leaves nothing running. Both run with MISSION_RESUME=false, so neither boot reopens a session the
# database already had: the drive's session is the only one either process touches.
#
#   DATABASE_URL=postgres://…/factory_mine ./follow.sh
#   DATABASE_URL=… FOLLOW_OWNER_PORT=9510 FOLLOW_FOLLOWER_PORT=9511 ./follow.sh
#
# Env: DATABASE_URL (required, never defaulted: the database both processes write, migrated by the
# first to boot), FOLLOW_OWNER_PORT (9438), FOLLOW_FOLLOWER_PORT (9439), EVIDENCE_DIR.
#
# Evidence: .verify/evidence/latest/api/follow.json (the checks and every event the follower's stream
# carried, from the driver) and follow-owner.log / follow-follower.log (the two API logs).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OWNER_PORT="${FOLLOW_OWNER_PORT:-9438}"
FOLLOWER_PORT="${FOLLOW_FOLLOWER_PORT:-9439}"
RUN_DIR="$ROOT/.verify/run/follow"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
DRIVER="$ROOT/.pi/skills/verify-api/follow.ts"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "follow.sh: set DATABASE_URL to the database both API processes should share" >&2
  exit 1
fi

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

start_api() { # name, port
  local name="$1" port="$2"
  rm -rf "$RUN_DIR/$name-sessions"
  : > "$RUN_DIR/$name.log"
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$port" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      FAUX_SLEEP_MS=300 \
      SESSION_ROOT="$RUN_DIR/$name-sessions" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      MISSION_RESUME=false \
      DATABASE_URL="$DATABASE_URL" \
      bun run src/index.ts ) >> "$RUN_DIR/$name.log" 2>&1 &
  echo $! > "$RUN_DIR/$name.pid"
}

wait_ready() { # port
  for _ in $(seq 1 60); do
    curl -sf -m 1 "http://127.0.0.1:$1/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

stop_api() { # name
  local pidfile="$RUN_DIR/$1.pid"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

trap 'stop_api owner; stop_api follower' EXIT

for port in "$OWNER_PORT" "$FOLLOWER_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set FOLLOW_OWNER_PORT / FOLLOW_FOLLOWER_PORT to free ones" >&2
    exit 1
  fi
done

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# The owner first, so its boot is the one that migrates; the follower boots against a current schema.
start_api owner "$OWNER_PORT"
wait_ready "$OWNER_PORT" || { echo "the owner api did not become ready — see $RUN_DIR/owner.log" >&2; exit 1; }
start_api follower "$FOLLOWER_PORT"
wait_ready "$FOLLOWER_PORT" || { echo "the follower api did not become ready — see $RUN_DIR/follower.log" >&2; exit 1; }

OWNER_URL="http://127.0.0.1:$OWNER_PORT" \
FOLLOWER_URL="http://127.0.0.1:$FOLLOWER_PORT" \
OWNER_PID="$(cat "$RUN_DIR/owner.pid")" \
EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$DRIVER"
RC=$?

# The driver stopped the owner; the pid file is stale either way.
stop_api owner
stop_api follower
cp "$RUN_DIR/owner.log" "$EVIDENCE_DIR/follow-owner.log"
cp "$RUN_DIR/follower.log" "$EVIDENCE_DIR/follow-follower.log"

echo
if [ "$RC" -eq 0 ]; then
  echo "follow: all checks passed — evidence in $EVIDENCE_DIR/follow.json"
else
  echo "follow: FAILURES — see $EVIDENCE_DIR/follow.json" >&2
fi
exit "$RC"
