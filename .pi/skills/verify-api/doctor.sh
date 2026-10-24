#!/usr/bin/env bash
# Read-only check: is this instance worth driving?
#
# Verifies the pid we started is alive, that our port is owned by it, and that the
# API answers. Changes nothing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
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

health="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/" || echo 000)"
if [ "$health" = "200" ]; then note "api GET /:" "200"; else note "api GET /:" "$health"; fail=1; fi

livez="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/livez" || echo 000)"
if [ "$livez" = "200" ]; then note "GET /livez:" "200"; else note "GET /livez:" "$livez"; fail=1; fi

readyz="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/readyz" || echo 000)"
if [ "$readyz" = "200" ]; then note "GET /readyz:" "200"; else note "GET /readyz:" "$readyz"; fail=1; fi

SESSION_ROOT="$RUN_DIR/sessions"
if [ -d "$SESSION_ROOT/.git" ]; then
  origin="$(git -C "$SESSION_ROOT" remote get-url origin 2>/dev/null || echo "")"
  case "$origin" in
    /*|file://*) note "session root origin:" "$origin (local)" ;;
    "") note "session root origin:" "NONE — a git case could run unbounded"; fail=1 ;;
    *) note "session root origin:" "$origin — NOT LOCAL"; fail=1 ;;
  esac
else
  note "session root:" "$SESSION_ROOT is not the seeded repo — ./up.sh seeds it"; fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "doctor: OK"
else
  echo "doctor: NOT HEALTHY — do not trust a drive run against this instance" >&2
fi
exit "$fail"
