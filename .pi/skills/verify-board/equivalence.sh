#!/usr/bin/env bash
# The CLI-equivalence phase (LOB-87, the last part of LOB-49): the CLI and the browser are one board.
#
# Two halves, neither duplicated here:
#
#   1. the surfaces' own drives, each against an instance of its own — `.pi/skills/verify-cli`
#      (`factory run|watch|ls|approve…` in tmux) and `.pi/skills/verify-web` (the dashboard in Chrome)
#      — run as they are, so a CLI or dashboard regression reddens this phase as it reddens them;
#   2. this skill's `drive.sh`, whose both-ways phase walks *the drive's own card* across the two:
#      a `factory board move` in the terminal is followed by an open page without a reload, and the
#      plan approval made in that page is what `factory board show` prints (`both-ways.mjs`).
#
# Every skill starts its own `apps/api` and records it in `.verify/run/api.pid`, and verify-web's
# down.sh removes `.verify/run` whole, so they run one at a time: each is brought up, driven and
# brought down before the next starts. A step whose up.sh fails is a failed step, its drive is not
# run, and its down.sh still is. The phase exits non-zero when any step fails.
#
#   DATABASE_URL=… API_PORT=9500 WEB_PORT=3500 APPROVE_PORT=9501 GITHUB_PORT=9503 ./equivalence.sh
#
# Env: DATABASE_URL (required: verify-cli and verify-web seed through it, and every API reads it),
# API_PORT (default 9400) and WEB_PORT (default 3400) for whichever instance is up, APPROVE_PORT
# (verify-cli's gated instance, default 9330), GITHUB_PORT (verify-board's GitHub fake, default 9403),
# EVIDENCE_DIR (default .verify/evidence/latest). Evidence: `cli/` and `board/` as those drives write
# them, `web/` for verify-web's, and `equivalence/` for this phase's steps — one log per step and
# `observed.json`, every step's exit code.
set -uo pipefail

# This suite runs its API with auth off (LOB-20): its clients send no credential, and it declares
# actors (a run's session id) that only an open control plane keeps. A token exported for the
# rest of the verify skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILLS="$ROOT/.pi/skills"
RUN_DIR="$ROOT/.verify/run"
API_PORT="${API_PORT:-9400}"
WEB_PORT="${WEB_PORT:-3400}"
APPROVE_PORT="${APPROVE_PORT:-9330}"
GITHUB_PORT="${GITHUB_PORT:-9403}"
EVIDENCE_ROOT="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}"
OUT="$EVIDENCE_ROOT/equivalence"
API_URL="http://localhost:$API_PORT"
WEB_URL="http://localhost:$WEB_PORT"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set — the drives seed through it, and every API they start reads it" >&2
  exit 1
fi
export DATABASE_URL
if [ -f "$RUN_DIR/api.pid" ] && kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null; then
  echo "an instance is already up (api pid $(cat "$RUN_DIR/api.pid")); run its ./down.sh first" >&2
  exit 1
fi

mkdir -p "$OUT"
rm -f "$OUT"/*.log "$OUT/observed.json"

failed=0
rows=()
run_step() { # name, then the command; its output goes to equivalence/<name>.log
  local name="$1"
  shift
  "$@" > "$OUT/$name.log" 2>&1
  local rc=$?
  rows+=("\"$name\": $rc")
  [ "$rc" = "0" ] || failed=1
  printf '%s  %-14s exit=%s  (%s)\n' "$([ "$rc" = "0" ] && echo PASS || echo FAIL)" "$name" "$rc" "$OUT/$name.log"
  return "$rc"
}

# One surface: up, then the drive only if up came up, then down whatever happened.
surface() { # name, skill, drive command...
  local name="$1"
  local skill="$2"
  shift 2
  if run_step "$name-up" env API_PORT="$API_PORT" WEB_PORT="$WEB_PORT" GITHUB_PORT="$GITHUB_PORT" \
      "$SKILLS/$skill/up.sh"; then
    run_step "$name-drive" "$@"
  fi
  run_step "$name-down" "$SKILLS/$skill/down.sh"
}

surface cli verify-cli \
  env API_URL="$API_URL" APPROVE_PORT="$APPROVE_PORT" EVIDENCE_DIR="$EVIDENCE_ROOT" \
  "$SKILLS/verify-cli/drive.sh"
surface web verify-web \
  env WEB_URL="$WEB_URL" API_URL="$API_URL" EVIDENCE_DIR="$EVIDENCE_ROOT/web" \
  node "$SKILLS/verify-web/drive.mjs"
surface board verify-board \
  env API_URL="$API_URL" WEB_URL="$WEB_URL" EVIDENCE_DIR="$EVIDENCE_ROOT" \
  "$SKILLS/verify-board/drive.sh"

{
  printf '{\n  "apiUrl": "%s",\n  "webUrl": "%s",\n  "steps": {\n' "$API_URL" "$WEB_URL"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$OUT/observed.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "equivalence: verify-cli, verify-web and verify-board all passed — evidence in $EVIDENCE_ROOT"
else
  echo "equivalence: FAILURES — see $OUT/observed.json and the step logs beside it" >&2
fi
exit "$failed"
