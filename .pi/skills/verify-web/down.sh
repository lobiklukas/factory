#!/usr/bin/env bash
# Stop only the instance that ./up.sh started, by the pids it recorded.
# Evidence in .verify/evidence/ is deliberately left alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN_DIR="$ROOT/.verify/run"

for name in api web; do
  pidfile="$RUN_DIR/$name.pid"
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      kill -9 "$pid" 2>/dev/null || true
      echo "stopped $name (pid $pid)"
    fi
    rm -f "$pidfile"
  fi
done

rm -rf "$RUN_DIR"
echo "run dir removed; evidence kept in $ROOT/.verify/evidence"
