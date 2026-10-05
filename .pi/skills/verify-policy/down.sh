#!/usr/bin/env bash
# Stop only the instance that ./up.sh started, by the pid it recorded.
# Evidence and the session log in Postgres are deliberately left alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN_DIR="$ROOT/.verify/run-policy"

pidfile="$RUN_DIR/api.pid"
if [ -f "$pidfile" ]; then
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped api (pid $pid)"
  fi
  rm -f "$pidfile"
fi

rm -rf "$RUN_DIR/sessions" "$RUN_DIR/origin.git"
echo "run dir cleaned (sessions, origin.git); evidence kept in $ROOT/.verify/evidence"
