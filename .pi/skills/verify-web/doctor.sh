#!/usr/bin/env bash
# Read-only check: is this instance worth driving?
#
# Verifies the pids we started are alive, that our ports are owned by those pids
# (not by some other process that happens to hold the port), and that both
# surfaces answer. Changes nothing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9100}"
WEB_PORT="${WEB_PORT:-3100}"
RUN_DIR="$ROOT/.verify/run"

fail=0
note() { printf '%-28s %s\n' "$1" "$2"; }

for name in api web; do
  pidfile="$RUN_DIR/$name.pid"
  if [ ! -f "$pidfile" ]; then
    note "$name pid:" "MISSING — run ./up.sh"
    fail=1
    continue
  fi
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    note "$name pid:" "$pid alive"
  else
    note "$name pid:" "$pid DEAD (see $RUN_DIR/$name.log)"
    fail=1
  fi
done

port_owner() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}'
}

# `bun run dev` starts Vite as a child, so the process listening on the port is
# often a descendant of the pid we recorded rather than the pid itself. Accept
# either, and walk up to a bounded depth.
is_ours() {
  candidate="$1"
  ancestor="$2"
  pid="$candidate"
  i=0
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ] && [ "$i" -lt 10 ]; do
    [ "$pid" = "$ancestor" ] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    i=$((i + 1))
  done
  return 1
}

api_owner="$(port_owner "$API_PORT")"
web_owner="$(port_owner "$WEB_PORT")"
api_pid="$(cat "$RUN_DIR/api.pid" 2>/dev/null || echo none)"
web_pid="$(cat "$RUN_DIR/web.pid" 2>/dev/null || echo none)"

if is_ours "$api_owner" "$api_pid"; then note "api port $API_PORT:" "owned by us ($api_owner)"; else
  note "api port $API_PORT:" "owned by ${api_owner:-nobody}, not under $api_pid"; fail=1; fi
if is_ours "$web_owner" "$web_pid"; then note "web port $WEB_PORT:" "owned by us ($web_owner)"; else
  note "web port $WEB_PORT:" "owned by ${web_owner:-nobody}, not under $web_pid"; fail=1; fi

health="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/" || echo 000)"
if [ "$health" = "200" ]; then note "api GET /:" "200"; else note "api GET /:" "$health"; fail=1; fi

webcode="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$WEB_PORT/" || echo 000)"
if [ "$webcode" = "200" ]; then note "web GET /:" "200"; else note "web GET /:" "$webcode"; fail=1; fi

if [ "$fail" -eq 0 ]; then
  echo "doctor: OK"
else
  echo "doctor: NOT HEALTHY — do not trust a drive run against this instance" >&2
fi
exit "$fail"
