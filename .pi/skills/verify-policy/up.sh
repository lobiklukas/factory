#!/usr/bin/env bash
# Launch an isolated API instance whose session runs ONE scripted bash command, so a refusal can be
# driven through the real session path (LOB-8, docs/design.md D11/D15).
#
# Isolation: its own port, its own session working directories under .verify/run-policy, and a pid
# recorded in .verify/run-policy/api.pid so ./down.sh stops exactly this one. It shares no pid file
# with .pi/skills/verify-api, so the two can run at once.
#
# MODEL_BACKEND=faux keeps verification offline and deterministic (pi-ai's scripted provider), and
# FAUX_COMMAND is what the scripted model calls `bash` with — one command per instance, because the
# faux script is fixed when the process boots. ./refusals.sh is what runs one instance per refusal.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9600}"
RUN_DIR="$ROOT/.verify/run-policy"
FAUX_COMMAND="${FAUX_COMMAND:-git push origin main}"

mkdir -p "$RUN_DIR"

if [ -f "$RUN_DIR/api.pid" ] && kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null; then
  echo "already running (api pid $(cat "$RUN_DIR/api.pid")); run ./down.sh first" >&2
  exit 1
fi

# Postgres is the session log; without it nothing here is worth driving.
#
# Asked for through compose, but a database that already answers is accepted. In a ralph worktree the
# compose project is named after the directory, so `docker compose up` tries to bind 5442 a second
# time and fails while the Postgres the session log actually lives in is up and healthy. What this
# script needs is a Postgres on 5442, not a container of its own (filed as LOB-57).
pg_up() { (exec 3<>"/dev/tcp/127.0.0.1/${PG_PORT:-5442}") 2>/dev/null; }

if ! pg_up; then
  if ! (cd "$ROOT" && DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}" \
        docker compose up -d --wait postgres >/dev/null 2>&1) || ! pg_up; then
    echo "postgres is not up on ${PG_PORT:-5442}: docker compose up -d --wait postgres" >&2
    exit 1
  fi
fi

# The session root is a throwaway git repo whose `origin` is a local bare repository.
#
# Why: a session's working directory is `<SESSION_ROOT>/<session id>`, and when the session root
# sits inside this checkout, git discovery from the session's cwd walks up into the *repo's*
# worktree and finds the real `origin` (github.com). Every case below is a command the policy must
# refuse, so the command normally never runs — but the drive's whole job is to fail when the policy
# regresses, and on that run the command does run. With the real origin inherited, a regressed
# `git push origin main` case pushes at github.com (observed once: git connected and reported
# "Everything up-to-date" — nothing was pushed, and the drive failed as intended, but a verify skill
# must not be able to reach a third party at all). With this repo in place the same regression
# pushes into `.verify/run-policy/origin.git` and stops there.
SESSION_ROOT="$RUN_DIR/sessions"
ORIGIN_DIR="$RUN_DIR/origin.git"
if [ ! -d "$SESSION_ROOT/.git" ]; then
  rm -rf "$SESSION_ROOT" "$ORIGIN_DIR"
  mkdir -p "$SESSION_ROOT"
  git init -q -b main "$SESSION_ROOT"
  git -C "$SESSION_ROOT" config user.email verify-policy@localhost
  git -C "$SESSION_ROOT" config user.name "verify-policy"
  git -C "$SESSION_ROOT" commit -q --allow-empty -m "verify-policy session root"
  git init -q -b main --bare "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" remote add origin "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" push -q origin main
fi

( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    HOST="127.0.0.1" \
    ALLOWED_ORIGINS="http://localhost:$API_PORT" \
    MODEL_BACKEND="faux" \
    FAUX_COMMAND="$FAUX_COMMAND" \
    SESSION_ROOT="$SESSION_ROOT" \
    SESSION_IDLE_TIMEOUT_MS="${SESSION_IDLE_TIMEOUT_MS:-2000}" \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

# Ready means `/readyz` says so, not merely that the port answers: the server binds before its
# migrations are applied (LOB-21), so `GET /` is true a moment before a session can be created.
ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "api did not become ready in 30s — see $RUN_DIR/api.log" >&2
  exit 1
fi

echo "api  http://localhost:$API_PORT  (pid $(cat "$RUN_DIR/api.pid"))"
echo "faux command: $FAUX_COMMAND"
echo "session root: $SESSION_ROOT (origin $(git -C "$SESSION_ROOT" remote get-url origin))"
