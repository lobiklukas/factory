#!/usr/bin/env bash
# Read-only check: is this instance worth driving?
#
# Four things have to hold before a drive means anything: the database it reads is up, our API is
# the process on our port and says it is ready, and our dashboard answers on its port. The database
# check is **loud on purpose** (LOB-61, LOB-84 acceptance): Postgres on host port 5442 is the cards
# themselves, so a drive that quietly skipped it would report a board it never read. It runs first
# and unconditionally — a missing API is never a reason to stop before saying the database is down.
# tmux is required because a command line is only proven in a real terminal.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
RUN_DIR="$ROOT/.verify/run"
WEB_PORT="${WEB_PORT:-$(cat "$RUN_DIR/web-port" 2>/dev/null || echo 3400)}"
# The port comes from the same URL `up.sh` hands the API, so the check cannot disagree with the
# instance it is checking; 5442 is only the fallback.
DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
PG_PORT="${PG_PORT:-$(printf '%s' "$DATABASE_URL" | sed -n 's#.*@[^:/]*:\([0-9][0-9]*\)/.*#\1#p')}"
PG_PORT="${PG_PORT:-5442}"

fail=0
note() { printf '%-24s %s\n' "$1" "$2"; }

# The cards are rows, not a log, so the database is not optional here: say so and fail rather than
# start a drive against a control plane whose every read is an error.
if (exec 3<>"/dev/tcp/127.0.0.1/$PG_PORT") 2>/dev/null; then
  note "postgres :$PG_PORT:" "accepting connections"
else
  note "postgres :$PG_PORT:" "DOWN — start it: docker compose up -d --wait postgres"
  echo "doctor: Postgres on :$PG_PORT is DOWN — the board is rows, nothing here is worth driving" >&2
  fail=1
fi

pid="$(cat "$RUN_DIR/api.pid" 2>/dev/null || true)"
if [ -z "$pid" ]; then
  note "api pid:" "MISSING — run ./up.sh"
  fail=1
elif kill -0 "$pid" 2>/dev/null; then
  note "api pid:" "$pid alive"
else
  note "api pid:" "$pid DEAD (see $RUN_DIR/api.log)"
  fail=1
fi

owner="$(lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}')"
if [ -n "$pid" ] && [ "$owner" = "$pid" ]; then
  note "api port $API_PORT:" "owned by us ($owner)"
else
  note "api port $API_PORT:" "owned by ${owner:-nobody}, not ${pid:-a recorded pid}"
  fail=1
fi

readyz="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/readyz" || echo 000)"
if [ "$readyz" = "200" ]; then note "GET /readyz:" "200"; else note "GET /readyz:" "$readyz"; fail=1; fi

# `bun run dev` starts Vite as a child, so the listener is usually a descendant of the recorded pid;
# the dashboard is checked by its pid being alive and its port answering.
web_pid="$(cat "$RUN_DIR/web.pid" 2>/dev/null || true)"
if [ -n "$web_pid" ] && kill -0 "$web_pid" 2>/dev/null; then
  note "web pid:" "$web_pid alive"
else
  note "web pid:" "${web_pid:-MISSING} — run ./up.sh"
  fail=1
fi
webcode="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$WEB_PORT/" || echo 000)"
if [ "$webcode" = "200" ]; then note "web :$WEB_PORT GET /:" "200"; else note "web :$WEB_PORT GET /:" "$webcode"; fail=1; fi

if command -v tmux >/dev/null 2>&1; then
  note "tmux:" "$(tmux -V)"
else
  note "tmux:" "MISSING — the drive needs a real terminal"
  fail=1
fi

if [ -s "$RUN_DIR/board.json" ]; then
  note "seeded board:" "$(cat "$RUN_DIR/board.json")"
else
  note "seeded board:" "MISSING — ./up.sh seeds one board"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "doctor: OK"
else
  echo "doctor: NOT HEALTHY — do not trust a drive run against this instance" >&2
fi
exit "$fail"
