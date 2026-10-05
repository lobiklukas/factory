#!/usr/bin/env bash
# Stop only the instance that ./up.sh started, by the pid it recorded, and tear down the drive's
# private tmux server. Evidence in .verify/evidence/ is deliberately left alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN_DIR="$ROOT/.verify/run"

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

# The drive runs in its own tmux server on a socket under .verify/run, so killing it cannot touch a
# tmux session the developer is using.
sock="$RUN_DIR/cli-tmux.sock"
if [ -S "$sock" ]; then
  tmux -S "$sock" kill-server 2>/dev/null || true
  echo "stopped the drive's tmux server"
fi

rm -f "$RUN_DIR/cli-idle-ms"
rm -rf "$RUN_DIR/sessions"
echo "run dir cleaned; evidence kept in $ROOT/.verify/evidence"
