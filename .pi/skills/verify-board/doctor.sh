#!/usr/bin/env bash
# Read-only check: is this instance worth driving?
#
# Four things have to hold before a drive means anything: the database it reads is up, our API is
# the process on our port and says it is ready, and our dashboard is the process on its port and
# answers. The database
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

# `bun run dev` starts Vite as a child, so the listener is usually a descendant of the recorded pid
# rather than the pid itself: walk the port owner's parents, to a bounded depth, looking for ours
# (as verify-web's doctor does). A port answering 200 is not enough — Vite runs with strictPort, so
# when a stranger holds WEB_PORT ours exits and the stranger's dashboard, pointed at some other API,
# keeps answering.
is_ours() { # candidate pid, ancestor pid
  local candidate="$1" ancestor="$2" i=0
  while [ -n "$candidate" ] && [ "$candidate" != "0" ] && [ "$candidate" != "1" ] && [ "$i" -lt 10 ]; do
    [ "$candidate" = "$ancestor" ] && return 0
    candidate="$(ps -o ppid= -p "$candidate" 2>/dev/null | tr -d ' ')"
    i=$((i + 1))
  done
  return 1
}

web_pid="$(cat "$RUN_DIR/web.pid" 2>/dev/null || true)"
if [ -n "$web_pid" ] && kill -0 "$web_pid" 2>/dev/null; then
  note "web pid:" "$web_pid alive"
else
  note "web pid:" "${web_pid:-MISSING} — run ./up.sh"
  fail=1
fi
web_owner="$(lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}')"
if [ -n "$web_pid" ] && is_ours "$web_owner" "$web_pid"; then
  note "web port $WEB_PORT:" "owned by us ($web_owner)"
else
  note "web port $WEB_PORT:" "owned by ${web_owner:-nobody}, not under ${web_pid:-a recorded pid}"
  fail=1
fi
webcode="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$WEB_PORT/" || echo 000)"
if [ "$webcode" = "200" ]; then note "web :$WEB_PORT GET /:" "200"; else note "web :$WEB_PORT GET /:" "$webcode"; fail=1; fi

# The forge the build phase opens its PR on (LOB-86): the loopback fake, unless ./up.sh was told
# BOARD_GITHUB=off — then the doctor says so, because a drive against it is meant to fail.
github_mode="$(cat "$RUN_DIR/github-mode" 2>/dev/null || echo missing)"
if [ "$github_mode" = "fake" ]; then
  github_pid="$(cat "$RUN_DIR/github.pid" 2>/dev/null || true)"
  if [ -n "$github_pid" ] && kill -0 "$github_pid" 2>/dev/null && [ -s "$RUN_DIR/github-ledger.json" ]; then
    note "github fake:" "pid $github_pid alive, ledger $RUN_DIR/github-ledger.json"
  else
    note "github fake:" "${github_pid:-no pid} not alive or no ledger — see $RUN_DIR/github.log"
    fail=1
  fi
elif [ "$github_mode" = "off" ]; then
  note "github:" "off (BOARD_GITHUB=off): the drive's PR phase will fail, by design"
else
  note "github:" "no record of a forge — run ./up.sh"
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
  note "seeded board:" "MISSING — ./up.sh seeds one board"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "doctor: OK"
else
  echo "doctor: NOT HEALTHY — do not trust a drive run against this instance" >&2
fi
exit "$fail"
