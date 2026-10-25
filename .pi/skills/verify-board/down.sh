#!/usr/bin/env bash
# Stop only the instance ./up.sh started, by the pid it recorded, plus the drive's private tmux
# server. Evidence in .verify/evidence/ is deliberately left alone.
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

sock="$RUN_DIR/board-tmux.sock"
if [ -S "$sock" ]; then
  tmux -S "$sock" kill-server 2>/dev/null || true
  echo "stopped the drive's tmux server"
fi

rm -f "$RUN_DIR/board.json"
rm -rf "$RUN_DIR/sessions"
echo "run dir cleaned; evidence kept in $ROOT/.verify/evidence"
