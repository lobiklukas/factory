#!/usr/bin/env bash
# Read-only: is the whole-workflow instance worth driving (LOB-40)?
#
#   ./doctor.sh          the faux instance: verify-board's doctor (Postgres first and loudly, the API
#                        and dashboard ours and ready), then the scratch database and the two fakes
#   ./doctor.sh --live   the same, after refusing — naming each one — when a variable the live run
#                        needs is not set; and, with an instance up, whether the tunnel reaches it
#
# The live check reads only whether each variable is set, never its value.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL="$ROOT/.pi/skills/verify-workflow"
WF_DIR="$ROOT/.verify/run/workflow"
BASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
MODE=faux
[ "${1:-}" = "--live" ] && MODE=live

note() { printf '%-24s %s\n' "$1" "$2"; }

# shellcheck source=live-env.sh
source "$SKILL/live-env.sh"
if [ "$MODE" = "live" ]; then
  live_refusal "doctor.sh" || exit $?
  note "live variables:" "all set (values not read)"
fi

fail=0
if [ ! -s "$WF_DIR/instance.json" ]; then
  # Postgres is still checked, and first: verify-board's doctor does it unconditionally.
  DATABASE_URL="$BASE_URL" "$ROOT/.pi/skills/verify-board/doctor.sh" >/dev/null 2>&1
  note "workflow instance:" "MISSING — run ./up.sh$([ "$MODE" = live ] && echo ' --live')"
  exit 1
fi

field() { sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}$/\1/p" "$WF_DIR/instance.json" | head -1; }
RECORDED="$(field mode)"
if [ "$RECORDED" != "$MODE" ]; then
  note "workflow instance:" "is $RECORDED, not $MODE — ./down.sh, then ./up.sh$([ "$MODE" = live ] && echo ' --live')"
  fail=1
fi

DB="$(field database)"
API_PORT="$(field apiPort)" WEB_PORT="$(field webPort)" DATABASE_URL="${BASE_URL%/*}/$DB" \
  "$ROOT/.pi/skills/verify-board/doctor.sh" || fail=1

if [ "$(DATABASE_URL="$BASE_URL" bun "$SKILL/scratch-db.ts" exists "$DB" 2>/dev/null)" = "yes" ]; then
  note "scratch database:" "$DB exists"
else
  note "scratch database:" "$DB MISSING"
  fail=1
fi

if [ "$RECORDED" = "faux" ]; then
  for name in linear git; do
    pid="$(cat "$WF_DIR/$name.pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      note "$name fake:" "pid $pid alive"
    else
      note "$name fake:" "DEAD or missing (see $WF_DIR/$name.log)"
      fail=1
    fi
  done
elif [ -n "${WORKFLOW_PUBLIC_URL:-}" ]; then
  code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$WORKFLOW_PUBLIC_URL/readyz" || echo 000)"
  if [ "$code" = "200" ]; then
    note "tunnel /readyz:" "200 ($WORKFLOW_PUBLIC_URL)"
  else
    note "tunnel /readyz:" "$code — Linear and GitHub cannot reach the API through $WORKFLOW_PUBLIC_URL"
    fail=1
  fi
fi

exit "$fail"
