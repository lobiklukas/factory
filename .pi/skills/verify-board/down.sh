#!/usr/bin/env bash
# Stop only the instance ./up.sh started, by the pid it recorded, plus the drive's private tmux
# server. Evidence in .verify/evidence/ is deliberately left alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN_DIR="$ROOT/.verify/run"

for name in api web github; do
  pidfile="$RUN_DIR/$name.pid"
  [ -f "$pidfile" ] || continue
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
done

sock="$RUN_DIR/board-tmux.sock"
if [ -S "$sock" ]; then
  tmux -S "$sock" kill-server 2>/dev/null || true
  echo "stopped the drive's tmux server"
fi

rm -f "$RUN_DIR/board.json" "$RUN_DIR/card.json" "$RUN_DIR/github-ledger.json" "$RUN_DIR/github-mode" \
  "$RUN_DIR/webhook-secret"
# The fixture repo goes with the session root: the build runs' worktrees are linked into it.
rm -rf "$RUN_DIR/sessions" "$RUN_DIR/board-repo"
echo "run dir cleaned; evidence kept in $ROOT/.verify/evidence"
