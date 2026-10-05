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

if [ "$fail" -eq 0 ]; then
  echo "doctor: OK"
else
  echo "doctor: NOT HEALTHY — do not trust a drive run against this instance" >&2
fi
exit "$fail"
