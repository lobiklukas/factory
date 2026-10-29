#!/usr/bin/env bash
# Stop only what ./up.sh started (LOB-40): the two loopback fakes by the pids it recorded, then
# verify-board's own instance through its `down.sh` (API, dashboard, GitHub fake, tmux, fixtures),
# then the scratch database it made — by the name it recorded, never by a pattern. Evidence in
# .verify/evidence/ is left alone.
#
# Safe to run after an `up.sh` that failed part-way, and twice: every step reads what was recorded and
# skips what is not there. It exits non-zero if the scratch database is still there afterwards.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL="$ROOT/.pi/skills/verify-workflow"
WF_DIR="$ROOT/.verify/run/workflow"
BASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
status=0

for name in linear git; do
  pidfile="$WF_DIR/$name.pid"
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped the $name fake (pid $pid)"
  fi
  rm -f "$pidfile"
done

"$ROOT/.pi/skills/verify-board/down.sh" || status=1

if [ -s "$WF_DIR/database" ]; then
  name="$(cat "$WF_DIR/database")"
  # The scratch database lives on the base URL's server; the statement connects to the base one.
  DATABASE_URL="$BASE_URL" bun "$SKILL/scratch-db.ts" drop "$name" || status=1
  if [ "$(DATABASE_URL="$BASE_URL" bun "$SKILL/scratch-db.ts" exists "$name" 2>/dev/null)" != "no" ]; then
    echo "the scratch database $name is still there" >&2
    status=1
  fi
fi

[ "$status" -eq 0 ] && rm -rf "$WF_DIR"
echo "workflow down; evidence kept in $ROOT/.verify/evidence"
exit "$status"
