#!/usr/bin/env bash
# Read-only check: is this instance worth driving, and can a drive reach a third party?
#
# Verifies the pid we started is alive, that our port is owned by it, that the API answers, and that
# the session root is the throwaway repo ./up.sh seeds — whose `origin` is a local bare directory.
# A regression that lets a scripted git command through then pushes into .verify/, never at the
# repo's real remote. Changes nothing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9600}"
RUN_DIR="$ROOT/.verify/run-policy"
SESSION_ROOT="$RUN_DIR/sessions"

fail=0
note() { printf '%-28s %s\n' "$1" "$2"; }

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

for endpoint in livez readyz; do
  code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/$endpoint" || echo 000)"
  if [ "$code" = "200" ]; then
    note "GET /$endpoint:" "200"
  else
    note "GET /$endpoint:" "$code"
    fail=1
  fi
done

# The safety property the drive depends on: a session's cwd is inside a repo whose origin is local,
# so no case can reach the repo's real remote even when the policy regresses.
if [ -d "$SESSION_ROOT/.git" ]; then
  origin="$(git -C "$SESSION_ROOT" remote get-url origin 2>/dev/null || echo "")"
  case "$origin" in
    /*|file://*)
      note "session root origin:" "$origin (local)"
      ;;
    "")
      note "session root origin:" "NONE — a git case could run unbounded"
      fail=1
      ;;
    *)
      note "session root origin:" "$origin — NOT LOCAL; run ./down.sh then ./up.sh"
      fail=1
      ;;
  esac
else
  note "session root:" "$SESSION_ROOT is not the seeded repo — ./up.sh seeds it"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "doctor: OK"
else
  echo "doctor: NOT HEALTHY — do not trust a drive run against this instance" >&2
fi
exit "$fail"
