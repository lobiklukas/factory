#!/usr/bin/env bash
# The faux drive from nothing, N times in a row (LOB-40): `up.sh`, `drive.sh`, `down.sh`, and after
# each `down.sh` the proof that it left nothing behind — every process `up.sh` recorded is gone,
# every port it bound is free, the scratch database is dropped and the run's workflow directory is
# removed. Exits non-zero when a drive fails or anything is left.
#
#   ./cycle.sh        twice, the acceptance's "twice in a row"
#   ./cycle.sh 1      once
#
# Takes what `up.sh` takes (DATABASE_URL, API_PORT, WEB_PORT, …). Each run's evidence is kept:
# .verify/evidence/latest/workflow is the last run's, and workflow-run-<n> each run's;
# workflow-cycle.json holds what every cycle found after its `down.sh`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL="$ROOT/.pi/skills/verify-workflow"
RUN_DIR="$ROOT/.verify/run"
WF_DIR="$RUN_DIR/workflow"
EVIDENCE="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}"
BASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
RUNS="${1:-2}"
API_PORT="${API_PORT:-9610}"
WEB_PORT="${WEB_PORT:-3610}"
PORTS=("$API_PORT" "$WEB_PORT" "${GITHUB_PORT:-$((API_PORT + 1))}" "${LINEAR_PORT:-$((API_PORT + 2))}" "${GIT_PORT:-$((API_PORT + 3))}")
export API_PORT WEB_PORT

mkdir -p "$EVIDENCE"
failed=0
rows=()

for run in $(seq 1 "$RUNS"); do
  echo "=== verify-workflow cycle $run of $RUNS"
  up=0 drive=1 down=1
  "$SKILL/up.sh" || up=$?
  pids=""
  db="$(cat "$WF_DIR/database" 2>/dev/null || true)"
  for file in "$RUN_DIR"/api.pid "$RUN_DIR"/web.pid "$RUN_DIR"/github.pid "$WF_DIR"/linear.pid "$WF_DIR"/git.pid; do
    [ -f "$file" ] && pids="$pids $(cat "$file")"
  done
  if [ "$up" -eq 0 ]; then
    "$SKILL/drive.sh"
    drive=$?
    rm -rf "$EVIDENCE/workflow-run-$run"
    cp -R "$EVIDENCE/workflow" "$EVIDENCE/workflow-run-$run" 2>/dev/null || true
  fi
  "$SKILL/down.sh" && down=0

  # What down.sh must have left: nothing.
  alive=""
  for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
  held=""
  for port in "${PORTS[@]}"; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && held="$held $port"
  done
  exists="no"
  [ -n "$db" ] && exists="$(DATABASE_URL="$BASE_URL" bun "$SKILL/scratch-db.ts" exists "$db" 2>/dev/null || echo unknown)"
  leftover="$([ -d "$WF_DIR" ] && echo yes || echo no)"
  ok=true
  if [ "$up" -ne 0 ] || [ "$drive" -ne 0 ] || [ "$down" -ne 0 ] || [ -n "$alive" ] || [ -n "$held" ] ||
     [ "$exists" != "no" ] || [ "$leftover" != "no" ]; then
    ok=false
    failed=1
  fi
  echo "cycle $run: up=$up drive=$drive down=$down alive=[${alive# }] ports=[${held# }] database $db exists=$exists workflow-dir=$leftover → $ok"
  rows+=("{\"run\": $run, \"up\": $up, \"drive\": $drive, \"down\": $down, \"pids\": \"${pids# }\", \"alive\": \"${alive# }\", \"heldPorts\": \"${held# }\", \"database\": \"$db\", \"databaseExists\": \"$exists\", \"workflowDirLeft\": \"$leftover\", \"passed\": $ok}")
done

{
  printf '{\n  "runs": [\n'
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  ]\n}\n'
} > "$EVIDENCE/workflow-cycle.json"

if [ "$failed" -eq 0 ]; then
  echo "verify-workflow: $RUNS clean cycle(s) passed — evidence in $EVIDENCE/workflow-cycle.json"
else
  echo "verify-workflow: a cycle FAILED — see $EVIDENCE/workflow-cycle.json" >&2
fi
exit "$failed"
