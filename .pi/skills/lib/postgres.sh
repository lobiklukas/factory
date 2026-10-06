#!/usr/bin/env bash
# The Postgres precondition every verify-* skill shares, in one place.
#
# Why this is not just `docker compose up -d --wait postgres`: compose names its project after
# `COMPOSE_PROJECT_NAME` when it is set and the directory otherwise, so a plain shell in a ralph
# worktree asks for project `factory-ralph` and tries to bind host port 5442 a second time.
# (`.pi/ralph/loop.sh` exports `COMPOSE_PROJECT_NAME=factory` into every agent session, which is why
# an agent tends to see the human's project instead — and why the collision is hit from a plain
# shell, or from any session that does not set it.) While the human's
# `factory-postgres-1` holds 5442 that fails with "port is already allocated" and leaves a `Created`
# container behind — even though the database the skills need is up and healthy (LOB-57). So ask the
# port first, and call compose only when nothing answers.
#
# Never `COMPOSE_PROJECT_NAME=factory` as the fix: a worktree's `docker compose down -v` would then
# destroy the human's volume.
#
# Sourced, not run: `source "$ROOT/.pi/skills/lib/postgres.sh"`. It sets no shell options (the caller
# owns `set -euo pipefail`) and prints nothing on success; `pg_docker` may export `DOCKER_HOST` for
# the colima fallback, which is the caller's environment for the rest of the script.
#
# Not to be confused with the `git` and `motel` skills' needs: this file is only about "is there a
# database on the host port, and if not, can I start one".

# Host port the session log listens on (`compose.yaml`). Overridable for a test that owns its own
# listener; the skills never set it.
PG_PORT="${PG_PORT:-5442}"

# The repository root this file lives in, derived from the file's own path so a caller cannot get it
# wrong. Callers that already have `ROOT` may export `PG_ROOT` first; the value is the same.
PG_ROOT="${PG_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"

# `docker`, with a colima fallback (AGENTS.md: the active context may be a stopped Docker Desktop
# while Colima runs). An explicit DOCKER_HOST always wins here, unlike `.pi/ralph/loop.sh`'s
# `docker_env`, which rewrites it whenever `docker info` fails — LOB-105 tracks that difference.
pg_docker() {
  if [ -z "${DOCKER_HOST:-}" ] && ! docker info >/dev/null 2>&1 &&
    [ -S "$HOME/.colima/default/docker.sock" ]; then
    export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
  fi
  docker "$@"
}

# `docker compose` from the repo root: the project this working directory owns.
pg_compose() {
  (cd "$PG_ROOT" && pg_docker compose "$@")
}

# A database that answers on the host port is up, whatever started it — this worktree's compose
# project, the human's, a native server or a tunnel. `/dev/tcp` is a bash builtin, so this needs no
# `nc`, no `psql` and no container tooling. A closed port refuses the connect, which is exit 1.
pg_port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PG_PORT") 2>/dev/null; }

# The name of the running container publishing PG_PORT, if a container does. `degraded.sh` needs it:
# it has to take the database away and give it back by container name, because the compose project
# that owns 5442 is not necessarily the one this directory would name.
pg_port_owner() {
  pg_docker ps --filter "publish=$PG_PORT" --format '{{.Names}}' 2>/dev/null | head -n 1
}

# 0 when Postgres is reachable — already up, or started by this call. 1 with one line on stderr
# naming the command to run when it is not.
ensure_postgres() {
  local created container
  pg_port_open && return 0
  if ! pg_compose up -d --wait postgres >/dev/null 2>&1; then
    # A failed start leaves a `Created` container holding the port reservation, which is what makes
    # the next run fail even after 5442 is free. Remove exactly that, and nothing else: a running
    # container is someone's database, and an `exited` one is not this call's to delete.
    created="$(pg_compose ps -aq --status created postgres 2>/dev/null || true)"
    for container in $created; do
      pg_docker rm -f "$container" >/dev/null 2>&1 || true
    done
    printf 'postgres is not up on port %s: run `docker compose up -d --wait postgres` from %s\n' \
      "$PG_PORT" "$PG_ROOT" >&2
    return 1
  fi
  return 0
}
