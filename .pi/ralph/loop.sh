#!/usr/bin/env bash
# Ralph loop driver: a fresh `pi -p` session per iteration, one Linear issue per iteration.
# See .pi/ralph/README.md. Subcommands: setup | plan | run | audit | status | stop
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT="$(git -C "$HERE" rev-parse --show-toplevel)"
COMMON="$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="$(dirname "$COMMON")"

# --- configuration (all overridable from the environment) -------------------------------------
RALPH_WORKTREE="${RALPH_WORKTREE:-$(dirname "$MAIN_ROOT")/$(basename "$MAIN_ROOT")-ralph}"
RALPH_MODEL="${RALPH_MODEL:-opencode-go/deepseek-v4.1-flash}"
RALPH_THINKING="${RALPH_THINKING:-high}"
RALPH_MAX_ITER="${RALPH_MAX_ITER:-10}"          # iterations per `run`
RALPH_SLEEP="${RALPH_SLEEP:-5}"                 # seconds between iterations
RALPH_TIMEOUT="${RALPH_TIMEOUT:-3600}"          # seconds per iteration
RALPH_MAX_FAILS="${RALPH_MAX_FAILS:-3}"         # consecutive iterations with no valid control line
RALPH_PUSH="${RALPH_PUSH:-1}"                   # 1: push branch + draft PR; 0: local branch only
RALPH_BASE_REF="${RALPH_BASE_REF:-origin/main}"
RALPH_DB="${RALPH_DB:-factory_ralph}"
RALPH_API_PORT="${RALPH_API_PORT:-9400}"
RALPH_WEB_PORT="${RALPH_WEB_PORT:-3400}"

WT="$RALPH_WORKTREE"
STATE="$WT/.ralph"
DATABASE_URL="postgres://factory:factory@localhost:5442/$RALPH_DB"

log() { printf '[ralph %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

docker_env() {
  if ! docker info >/dev/null 2>&1 && [ -S "$HOME/.colima/default/docker.sock" ]; then
    export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
  fi
}

ensure_db() {
  docker_env
  (cd "$MAIN_ROOT" && docker compose up -d --wait postgres) >&2
  local exists
  exists="$(cd "$MAIN_ROOT" && docker compose exec -T postgres \
    psql -U factory -d factory -tAc "select 1 from pg_database where datname='$RALPH_DB'")"
  if [ "$exists" != "1" ]; then
    (cd "$MAIN_ROOT" && docker compose exec -T postgres createdb -U factory "$RALPH_DB")
    log "created database $RALPH_DB"
  fi
}

# --- setup: worktree, dependencies, database ---------------------------------------------------
cmd_setup() {
  command -v pi >/dev/null || die "pi not on PATH"
  command -v gh >/dev/null || die "gh not on PATH"
  git -C "$MAIN_ROOT" fetch origin --quiet
  if [ ! -d "$WT" ]; then
    git -C "$MAIN_ROOT" worktree add --detach "$WT" "$RALPH_BASE_REF"
    log "worktree at $WT ($RALPH_BASE_REF)"
  fi
  [ -f "$WT/.pi/ralph/work.prompt.md" ] || die "$RALPH_BASE_REF has no .pi/ralph/ - commit and push the ralph tooling (.pi/ralph, .pi/agents/ralph-*) to $RALPH_BASE_REF first"
  mkdir -p "$STATE/logs" "$STATE/sessions" "$STATE/research"
  # Credentials are local state: copy, never commit (gitignored).
  [ -f "$MAIN_ROOT/.env" ] && [ ! -f "$WT/.env" ] && cp "$MAIN_ROOT/.env" "$WT/.env"
  (cd "$WT" && bun install --frozen-lockfile)
  ensure_db
  (cd "$WT" && pi mcp list >/dev/null 2>&1) || log "warning: 'pi mcp list' failed in the worktree - check Linear auth (pi mcp login linear)"
  log "setup done. Next: loop.sh plan, then loop.sh run"
}

# --- one pi session ---------------------------------------------------------------------------
reset_worktree() {
  cd "$WT"
  # Keep local state out of git (and out of `stash -u`) whatever the checked-out branch's .gitignore says.
  local excl; excl="$(git rev-parse --path-format=absolute --git-path info/exclude)"
  grep -qx '.ralph/' "$excl" 2>/dev/null || { mkdir -p "$(dirname "$excl")"; echo '.ralph/' >>"$excl"; }
  mkdir -p "$STATE/logs" "$STATE/sessions" "$STATE/research"
  if [ -n "$(git status --porcelain)" ]; then
    local tag="ralph-leftover-$(date +%Y%m%d-%H%M%S)"
    git stash push -u -m "$tag" >/dev/null && log "stashed leftover work: $tag"
  fi
  git fetch origin --quiet
  git switch --detach "$RALPH_BASE_REF" --quiet
}

run_context() {
  cat <<CTX

---

## Run context (authoritative for this iteration)

- iteration: $1 of $RALPH_MAX_ITER, mode: $2
- worktree (your cwd): $WT
- base ref: $RALPH_BASE_REF
- RALPH_PUSH=$RALPH_PUSH  (1: push the branch and open a draft PR; 0: commit locally only, no push, no PR)
- database for tests and verify scripts: DATABASE_URL=$DATABASE_URL (never use the default \`factory\` database)
- ports for verify-* scripts: API_PORT=$RALPH_API_PORT WEB_PORT=$RALPH_WEB_PORT
- DOCKER_HOST=${DOCKER_HOST:-<unset>}
- date: $(date -u +%Y-%m-%dT%H:%M:%SZ)
CTX
}

# Run a command with a wall-clock limit (macOS has no `timeout`).
with_timeout() {
  local secs="$1"; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null; sleep 10; kill -KILL "$pid" 2>/dev/null ) & local watcher=$!
  local rc=0
  wait "$pid" || rc=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return "$rc"
}

# session <iteration> <plan|work>; echoes the control tag (NEXT|COMPLETE|BLOCKED|NONE)
session() {
  local n="$1" mode="$2" prompt="$WT/.pi/ralph/$2.prompt.md" stamp out err
  stamp="$(date +%Y%m%d-%H%M%S)-$mode-$n"
  out="$STATE/logs/$stamp.out"; err="$STATE/logs/$stamp.err"
  [ -f "$prompt" ] || die "missing $prompt"
  log "$mode iteration $n -> $out"
  local rc=0
  (
    cd "$WT"
    export DATABASE_URL DOCKER_HOST="${DOCKER_HOST:-}" API_PORT="$RALPH_API_PORT" WEB_PORT="$RALPH_WEB_PORT" RALPH_PUSH
    [ -n "$DOCKER_HOST" ] || unset DOCKER_HOST
    with_timeout "$RALPH_TIMEOUT" pi -p --approve \
      --model "$RALPH_MODEL" --thinking "$RALPH_THINKING" \
      --session-dir "$STATE/sessions" --name "ralph-$mode-$n" \
      "$(cat "$prompt"; run_context "$n" "$mode")" \
      </dev/null >"$out" 2>"$err"
  ) || rc=$?
  local last tag="NONE"
  last="$(grep -v '^[[:space:]]*$' "$out" 2>/dev/null | tail -n 1 | tr -d '`' | tr -d '[:space:]' || true)"
  case "$last" in
    "<promise>NEXT</promise>") tag=NEXT ;;
    "<promise>COMPLETE</promise>") tag=COMPLETE ;;
    "<promise>BLOCKED</promise>") tag=BLOCKED ;;
  esac
  printf '{"at":"%s","mode":"%s","iteration":%s,"exit":%s,"tag":"%s","log":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$mode" "$n" "$rc" "$tag" "$out" >>"$STATE/runs.jsonl"
  [ "$rc" -eq 0 ] || log "pi exited $rc (see $err)"
  echo "$tag"
}

lock() {
  mkdir -p "$STATE"
  if ! mkdir "$STATE/lock" 2>/dev/null; then
    local pid; pid="$(cat "$STATE/lock/pid" 2>/dev/null || echo '?')"
    kill -0 "$pid" 2>/dev/null && die "another loop is running (pid $pid)"
    log "removing stale lock (pid $pid)"; rm -rf "$STATE/lock"; mkdir "$STATE/lock"
  fi
  echo $$ >"$STATE/lock/pid"
  trap 'rm -rf "$STATE/lock"' EXIT
}

cmd_plan() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  lock; ensure_db; reset_worktree
  local tag; tag="$(session 0 plan)"
  log "planner finished: $tag"
  [ "$tag" = COMPLETE ] || die "planner did not complete ($tag)"
  [ -f "$STATE/plan.md" ] || die "planner reported COMPLETE but wrote no $STATE/plan.md"
  grep -E '^\| *[0-9]+ ' "$STATE/plan.md" | head -n 15
}

cmd_run() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  lock; ensure_db
  rm -f "$STATE/STOP"
  if [ ! -f "$STATE/plan.md" ]; then
    log "no plan yet - planning first"
    reset_worktree
    [ "$(session 0 plan)" = COMPLETE ] && [ -f "$STATE/plan.md" ] || die "planning failed"
  fi
  local i=0 fails=0
  while [ "$i" -lt "$RALPH_MAX_ITER" ]; do
    i=$((i + 1))
    [ ! -f "$STATE/STOP" ] || { log "STOP file found"; break; }
    reset_worktree
    local tag; tag="$(session "$i" work)"
    case "$tag" in
      NEXT)     fails=0 ;;
      COMPLETE) log "queue exhausted"; break ;;
      BLOCKED)  log "worker reported BLOCKED - a human must look (see $STATE/logs)"; exit 2 ;;
      *)        fails=$((fails + 1)); log "no valid control line ($fails/$RALPH_MAX_FAILS)"
                [ "$fails" -lt "$RALPH_MAX_FAILS" ] || { log "too many failed iterations"; exit 3; } ;;
    esac
    sleep "$RALPH_SLEEP"
  done
  log "done after $i iteration(s)"
  reset_worktree
}

cmd_audit() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  lock; ensure_db; reset_worktree
  local tag; tag="$(session 0 audit)"
  log "audit finished: $tag"
  reset_worktree
  [ "$tag" = COMPLETE ] || exit 3
}

cmd_status() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  echo "worktree: $WT  model: $RALPH_MODEL  push: $RALPH_PUSH"
  [ -d "$STATE/lock" ] && echo "loop: running (pid $(cat "$STATE/lock/pid" 2>/dev/null))" || echo "loop: idle"
  [ -f "$STATE/STOP" ] && echo "STOP requested"
  if [ -f "$STATE/plan.md" ]; then
    echo; echo "queue:"; grep -E '^\| *[0-9]+ ' "$STATE/plan.md" | awk -F'|' '{printf "  %-4s %-8s %-12s %s\n", $2, $3, $5, $4}'
  fi
  [ -f "$STATE/runs.jsonl" ] && { echo; echo "last runs:"; tail -n 5 "$STATE/runs.jsonl"; }
  return 0
}

cmd_stop() { mkdir -p "$STATE"; touch "$STATE/STOP"; log "will stop after the current iteration"; }

case "${1:-}" in
  setup)  cmd_setup ;;
  plan)   cmd_plan ;;
  run)    shift; [ "${1:-}" = "--max" ] && RALPH_MAX_ITER="${2:?--max N}"; cmd_run ;;
  audit)  cmd_audit ;;
  status) cmd_status ;;
  stop)   cmd_stop ;;
  *) echo "usage: $0 {setup|plan|run [--max N]|audit|status|stop}  (env: RALPH_MODEL RALPH_THINKING RALPH_PUSH RALPH_MAX_ITER RALPH_WORKTREE ...)" >&2; exit 64 ;;
esac
