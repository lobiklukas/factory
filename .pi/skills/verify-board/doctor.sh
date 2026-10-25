#!/usr/bin/env bash
# Read-only check: is this instance worth driving?
#
# Three things have to hold before a drive means anything: our API is the process on our port, it
# says it is ready, and the database it reads is up. The database check is **loud on purpose**
# (LOB-61 acceptance): Postgres on host port 5442 is the cards themselves, so a drive that quietly
# skipped it would report a board it never read. tmux is required because a command line is only
# proven in a real terminal.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
PG_PORT="${PG_PORT:-5442}"
RUN_DIR="$ROOT/.verify/run"

fail=0
note() { printf '%-24s %s\n' "$1" "$2"; }

pidfile="$RUN_DIR/api.pid"
if [ ! -f "$pidfile" ]; then
  note "api pid:" "MISSING — run ./up.sh"
  exit 1
fi

pid="$(cat "$pidfile")"
if kill -0 "$pid" 2>/dev/null; then
  note "api pid:" "$pid alive"
else
  note "api pid:" "$pid DEAD (see $RUN_DIR/api.log)"
  fail=1
fi

owner="$(lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}')"
if [ "$owner" = "$pid" ]; then
  note "api port $API_PORT:" "owned by us ($owner)"
else
  note "api port $API_PORT:" "owned by ${owner:-nobody}, not $pid"
  fail=1
fi

readyz="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/readyz" || echo 000)"
if [ "$readyz" = "200" ]; then note "GET /readyz:" "200"; else note "GET /readyz:" "$readyz"; fail=1; fi

# The cards are rows, not a log, so the database is not optional here: say so and fail rather than
# start a drive against a control plane whose every read is an error.
if (exec 3<>"/dev/tcp/127.0.0.1/$PG_PORT") 2>/dev/null; then
  note "postgres :$PG_PORT:" "accepting connections"
else
  note "postgres :$PG_PORT:" "DOWN — start it: docker compose up -d --wait postgres"
  fail=1
fi

if command -v tmux >/dev/null 2>&1; then
  note "tmux:" "$(tmux -V)"
else
  note "tmux:" "MISSING — the drive needs a real terminal"
  fail=1
fi

if [ -s "$RUN_DIR/board.json" ]; then
  note "seeded board:" "$(cat "$RUN_DIR/board.json")"
else
  note "seeded board:" "MISSING — ./up.sh seeds one board and one card"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "doctor: OK"
else
  echo "doctor: NOT HEALTHY — do not trust a drive run against this instance" >&2
fi
exit "$fail"
