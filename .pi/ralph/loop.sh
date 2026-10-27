#!/usr/bin/env bash
# Ralph loop driver: a fresh `pi -p` session per iteration, one Linear issue per iteration, one PR per issue.
# GitHub merges the PR (auto-merge on the required `gate` check); Linear's GitHub integration closes the issue.
# See .pi/ralph/README.md. Subcommands: setup | run | start | kill | stop | status | split | audit | parallel
set -euo pipefail

log() { printf '[ralph %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

usage() {
  echo "usage: ${1:-$0} {setup|run [--max N]|start [--max N]|kill|stop|status|split|audit|parallel ...}  (env: RALPH_MODEL RALPH_FALLBACK_MODELS RALPH_THINKING RALPH_PUSH RALPH_MERGE RALPH_MAX_ITER RALPH_WORKTREE ...)" >&2
}

# Everything below is derived from this file's location. Read from stdin or `bash -c`, bash cannot tell the file
# where it is and `HERE` would silently become the caller's cwd, so refuse (LOB-110).
if [ -z "${BASH_SOURCE[0]:-}" ]; then
  log "refusing to run: bash cannot tell this file where it is (stdin or -c)"
  usage "bash .pi/ralph/loop.sh"
  exit 64
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT="$(git -C "$HERE" rev-parse --show-toplevel)"
COMMON="$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="$(dirname "$COMMON")"

# --- configuration (all overridable from the environment) -------------------------------------
# RALPH_WORKER=N: worker 1 is the default loop; worker N > 1 gets its own worktree, database and ports and shares
# the progress notes and the claims (README.md, "Parallel workers").
RALPH_WORKER="${RALPH_WORKER:-1}"
case "$RALPH_WORKER" in ''|*[!0-9]*|0) echo "[ralph] error: RALPH_WORKER must be a positive integer, not '$RALPH_WORKER'" >&2; exit 64 ;; esac
_sfx=""; [ "$RALPH_WORKER" -eq 1 ] || _sfx="-$RALPH_WORKER"
RALPH_PRIMARY_WORKTREE="${RALPH_PRIMARY_WORKTREE:-$(dirname "$MAIN_ROOT")/$(basename "$MAIN_ROOT")-ralph}"
RALPH_SHARED="${RALPH_SHARED:-$(dirname "$MAIN_ROOT")/$(basename "$MAIN_ROOT")-ralph-shared}"
RALPH_WORKTREE="${RALPH_WORKTREE:-$RALPH_PRIMARY_WORKTREE$_sfx}"
RALPH_MODEL="${RALPH_MODEL:-opencode-go/deepseek-v4.1-flash}"
RALPH_THINKING="${RALPH_THINKING:-medium}"
RALPH_FALLBACK_MODELS="${RALPH_FALLBACK_MODELS-anthropic/claude-haiku-5-5}"  # comma list, a different provider than RALPH_MODEL; empty disables
RALPH_MAX_ITER="${RALPH_MAX_ITER:-10}"          # iterations per `run`
RALPH_SLEEP="${RALPH_SLEEP:-5}"                 # seconds between iterations
RALPH_TIMEOUT="${RALPH_TIMEOUT:-3600}"          # seconds per iteration
RALPH_STALL="${RALPH_STALL:-1200}"              # seconds with no session/subagent write before the agent is killed
RALPH_SPLIT_MAX="${RALPH_SPLIT_MAX:-10}"        # parents split per `split` run
RALPH_MAX_FAILS="${RALPH_MAX_FAILS:-5}"         # consecutive iterations with no valid control line
RALPH_PROVIDER_BACKOFF="${RALPH_PROVIDER_BACKOFF:-120}"    # seconds to wait when every model is refusing
RALPH_PROVIDER_BACKOFFS="${RALPH_PROVIDER_BACKOFFS:-180}"  # waits in a row before giving up (6 h at the default)
RALPH_PUSH="${RALPH_PUSH:-1}"                   # 1: push the branch and open a PR; 0: local branch only
RALPH_BASE_REF="${RALPH_BASE_REF:-origin/main}"
RALPH_DB="${RALPH_DB:-factory_ralph${_sfx//-/_}}"
RALPH_API_PORT="${RALPH_API_PORT:-$((9400 + 10 * (RALPH_WORKER - 1)))}"
RALPH_WEB_PORT="${RALPH_WEB_PORT:-$((3400 + 10 * (RALPH_WORKER - 1)))}"
RALPH_CLAIM_TTL="${RALPH_CLAIM_TTL:-10800}"     # seconds before another worker may take over a claim
# Only worker 1 arms auto-merge and labels protected PRs, so two workers never comment on one PR twice.
if [ "$RALPH_WORKER" -eq 1 ]; then RALPH_MERGE="${RALPH_MERGE:-1}"; else RALPH_MERGE="${RALPH_MERGE:-0}"; fi
# A PR touching these is never auto-merged: a human merges changes to CI, the loop itself,
# lint/format/test config, or infrastructure-as-code (live GitHub settings and cluster declarations).
PROTECTED_RE='^(\.github/|\.pi/ralph/|\.pi/agents/ralph-|\.oxlintrc\.json$|\.oxfmtrc\.jsonc$|vitest\.config\.ts$|infra/|.*\.tf$|.*\.tfvars$)'

WT="$RALPH_WORKTREE"
STATE="$WT/.ralph"
DATABASE_URL="postgres://factory:factory@localhost:5442/$RALPH_DB"

# `docker`, with a colima fallback (AGENTS.md: the active context may be a stopped Docker Desktop while Colima
# runs). An explicit `DOCKER_HOST` is authoritative and never rewritten, as in `.pi/skills/lib/postgres.sh`'s
# `pg_docker` (LOB-105). An empty value counts as unset.
docker_env() {
  if [ -z "${DOCKER_HOST:-}" ] && ! docker info >/dev/null 2>&1 &&
    [ -S "$HOME/.colima/default/docker.sock" ]; then
    export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
  fi
}

ensure_db() {
  docker_env
  # "Is Postgres up?" is answered by `.pi/skills/lib/postgres.sh` (the port, not compose's exit code; LOB-104,
  # LOB-106, LOB-108). `PG_ROOT` is pinned to the human's checkout, which owns the compose project; a plain
  # assignment, so no session inherits it.
  PG_ROOT="$MAIN_ROOT"
  source "$MAIN_ROOT/.pi/skills/lib/postgres.sh"
  ensure_postgres ||
    die "postgres is not up on port ${PG_PORT}; the loop will not start agents against it"
  # Create the database in whichever postgres publishes the port: `docker exec` into that container, or
  # `compose exec` when nothing publishes it (a native server, a tunnel).
  local owner exists
  owner="$(pg_port_owner || true)"
  if [ -n "$owner" ]; then
    pgin() { pg_docker exec "$owner" "$@"; }
  else
    pgin() { pg_compose exec -T postgres "$@"; }
  fi
  exists="$(pgin psql -U factory -d factory -tAc \
    "select 1 from pg_database where datname='$RALPH_DB'")"
  if [ "$exists" != "1" ]; then
    pgin createdb -U factory "$RALPH_DB"
    log "created database $RALPH_DB"
  fi
}

# share_state: a worker beside worker 1 reads and writes worker 1's progress notes, polish list and research briefs
# (symlinks into its .ralph). Logs, sessions, runs and the lock stay its own.
share_state() {
  [ "$RALPH_WORKER" -gt 1 ] || return 0
  local primary="$RALPH_PRIMARY_WORKTREE/.ralph" f
  mkdir -p "$primary/research"
  for f in progress.md polish.md; do
    touch "$primary/$f" 2>/dev/null || true
    [ -L "$STATE/$f" ] || { rm -f "$STATE/$f"; ln -s "$primary/$f" "$STATE/$f"; }
  done
  [ -L "$STATE/research" ] || { rm -rf "$STATE/research"; ln -s "$primary/research" "$STATE/research"; }
}

# --- the worker session's own lock ------------------------------------------------------------
# `lock` is the driver's, not the session's: a driver killed mid-iteration frees it (a dead pid is a stale lock) while
# the `pi` it launched keeps working in $WT, and the next run used to reset the worktree under that session and launch
# a second one beside it (LOB-120). So `with_timeout` records the session's pid and start time in $SESSION_REC for as
# long as it runs, and nothing that switches $WT (setup, run, audit) starts while that record names a live process.
# The start time is what tells the recorded `pi` from a later process that was handed its pid. `ps` prints it in the
# caller's time zone and locale, and the run that writes the record and the one that reads it need not share either
# (a detached `start` from one shell, `run`, `status` or `kill` from another), so both sides pin them: unpinned, a live
# session reads as a reused pid and the guard fails open.
SESSION_REC="$STATE/session"
proc_started() { LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//; s/ *$//'; }
# running <pid>: the process exists and is not a zombie, which `kill -0` alone counts as alive until its parent reaps it.
running() { kill -0 "$1" 2>/dev/null && ! ps -o stat= -p "$1" 2>/dev/null | grep -q Z; }
# session_tree <pid>: the pid and every descendant of it still running, parents first.
session_tree() {
  local queue="$1" next p kids
  while [ -n "$queue" ]; do
    next=""
    for p in $queue; do
      echo "$p"
      kids="$(pgrep -P "$p" 2>/dev/null || true)"
      [ -z "$kids" ] || next="$next $kids"
    done
    queue="${next# }"
  done
}
# stop_session <pid>: TERM, then KILL, every descendant of the session, so nothing it started (a gate, a subagent `pi`,
# git) keeps writing in $WT. Its process group goes too when that group's leader is dead, which is the orphan this is
# for: the group of a driver that was killed alone, where a child whose parent already died is no longer a descendant.
# A group whose leader lives is left alone: it is a running driver (`kill` signalled that one above) or whatever
# started the driver, which can be the caller's own shell or an agent's. Succeeds once the session's tree is gone.
stop_session() {
  local spid="$1" pg own tree="" sig p i left
  pg="$(ps -o pgid= -p "$spid" 2>/dev/null | tr -d ' ' || true)"
  own="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
  for sig in TERM KILL; do
    # Walk the tree again before each signal (a child may have forked) and keep what the last walk found: a child
    # whose parent died is no longer under the session, but it is still the session's.
    tree="$(printf '%s\n' $tree $(session_tree "$spid") | sort -u)"
    [ -z "$pg" ] || [ "$pg" = "$own" ] || running "$pg" || kill -"$sig" -- "-$pg" 2>/dev/null || true
    for p in $tree; do kill -"$sig" "$p" 2>/dev/null || true; done
    for i in 1 2 3 4 5 6; do
      left=""; for p in $tree; do ! running "$p" || left="$left $p"; done
      [ -n "$left" ] || return 0
      sleep 0.5
    done
  done
  ! running "$spid"
}
# live_session: print the pid of the recorded session and succeed if it still runs; drop a stale record.
live_session() {
  [ -f "$SESSION_REC" ] || return 1
  local pid="" started=""
  { read -r pid; read -r started; } <"$SESSION_REC" || true
  if [ -n "$pid" ] && running "$pid" && [ "$(proc_started "$pid")" = "$started" ]; then
    echo "$pid"; return 0
  fi
  log "removing stale session record (pid ${pid:-?})"; rm -f "$SESSION_REC"; return 1
}
take_worktree() {
  local pid
  if pid="$(live_session)"; then
    die "$WT has a live worker session from an earlier run (pi pid $pid); wait for it or stop it with: $HERE/loop.sh kill"
  fi
}

# --- setup: worktree, dependencies, database ---------------------------------------------------
cmd_setup() {
  command -v pi >/dev/null || die "pi not on PATH"
  command -v gh >/dev/null || die "gh not on PATH"
  [ ! -d "$WT" ] || take_worktree
  git -C "$MAIN_ROOT" fetch origin --quiet
  if [ ! -d "$WT" ]; then
    git -C "$MAIN_ROOT" worktree add --detach "$WT" "$RALPH_BASE_REF"
    log "worktree at $WT ($RALPH_BASE_REF)"
  fi
  if [ -n "$(git -C "$WT" status --porcelain --untracked-files=no)" ]; then
    git -C "$WT" stash push -m "ralph-setup-$(date +%Y%m%d-%H%M%S)" >/dev/null
  fi
  git -C "$WT" switch --detach "$RALPH_BASE_REF" --quiet
  [ -f "$WT/.pi/ralph/work.prompt.md" ] || die "$RALPH_BASE_REF has no .pi/ralph/ - push the ralph tooling to $RALPH_BASE_REF first"
  mkdir -p "$STATE/logs" "$STATE/sessions" "$STATE/research"
  share_state
  [ -f "$MAIN_ROOT/.env" ] && [ ! -f "$WT/.env" ] && cp "$MAIN_ROOT/.env" "$WT/.env"   # local state: copied, never committed
  (cd "$WT" && bun install --frozen-lockfile)
  ensure_db
  (cd "$WT" && pi mcp list >/dev/null 2>&1) || log "warning: 'pi mcp list' failed in the worktree - check Linear auth (pi mcp login linear)"
  for l in "hold:Never auto-merge:B60205" "needs-human-merge:A human must merge or fix this PR:FBCA04"; do
    (cd "$WT" && gh label create "${l%%:*}" --description "$(echo "$l" | cut -d: -f2)" --color "${l##*:}" >/dev/null 2>&1) || true
  done
  log "setup done. Next: loop.sh run --max 3"
}

# --- one pi session ---------------------------------------------------------------------------
# reset_worktree: commit or stash whatever $WT holds and switch it to $RALPH_BASE_REF. $WT is one checkout that every
# run, setup and audit of this worker switches, so this is only safe with no session in it: callers take the worktree
# first (`take_worktree`), and between iterations `with_timeout` has already waited for the last session.
reset_worktree() {
  cd "$WT"
  local excl; excl="$(git rev-parse --path-format=absolute --git-path info/exclude)"
  grep -qx '.ralph/' "$excl" 2>/dev/null || { mkdir -p "$(dirname "$excl")"; echo '.ralph/' >>"$excl"; }
  mkdir -p "$STATE/logs" "$STATE/sessions" "$STATE/research"
  if [ -n "$(git status --porcelain)" ]; then
    local br; br="$(git branch --show-current)"
    case "$br" in
      ralph/*)  # an interrupted iteration: keep its work on its branch so the next one resumes it
        git add -A && git -c user.name="${GIT_AUTHOR_NAME:-ralph}" -c user.email="${GIT_AUTHOR_EMAIL:-ralph@localhost}" \
          commit -q --no-verify -m "wip($br): unfinished work preserved after an interrupted iteration" \
          && log "committed leftover work to $br as WIP" \
          && { [ "$RALPH_PUSH" != 1 ] || git push -q origin "$br" 2>/dev/null || log "could not push $br (kept locally)"; } ;;
      *) local tag="ralph-leftover-$(date +%Y%m%d-%H%M%S)"
         git stash push -u -m "$tag" >/dev/null && log "stashed leftover work: $tag" ;;
    esac
  fi
  git fetch origin --quiet
  git switch --detach "$RALPH_BASE_REF" --quiet
}

run_context() {
  cat <<CTX

---

## Run context (authoritative for this iteration)

- iteration: $1 of $RALPH_MAX_ITER, mode: $2
- worker: $RALPH_WORKER (other workers may run beside you). Before you take an issue or fix a PR run \`bash .pi/ralph/claim.sh claim LOB-n\`; exit 1 means another worker holds it: take the next one.
- worktree (your cwd): ${SESS_CWD:-$WT}
- base ref: $RALPH_BASE_REF
- RALPH_PUSH=$RALPH_PUSH  (1: push the branch and open a PR; 0: commit locally only, no push, no PR)
- database for tests and verify scripts: DATABASE_URL=$DATABASE_URL (never use the default \`factory\` database)
- ports for verify-* scripts: API_PORT=$RALPH_API_PORT WEB_PORT=$RALPH_WEB_PORT
- DOCKER_HOST=${DOCKER_HOST:-<unset>}
- subagent fallback models: ${RALPH_FALLBACK_MODELS:-<none>}. If a subagent launch fails with a provider error (429, overloaded, quota, unavailable), relaunch that same task once per listed model with the per-run override \`model: "<id>"\`.
- date: $(date -u +%Y-%m-%dT%H:%M:%SZ)
CTX
}

# with_timeout <secs> <cmd...>: hard wall-clock cap, plus a stall watchdog when RALPH_STALL_DIR is set: kill the
# command once nothing under that directory (session + subagent transcripts) was written for RALPH_STALL seconds.
# Returns 125 on a stall. With RALPH_SESSION_REC set, the command's pid and start time are in that file while it runs
# (`take_worktree`); a driver killed before the command ends leaves the record behind on purpose.
newest_mtime() {
  if stat -c %Y / >/dev/null 2>&1; then find "$1" -type f -exec stat -c %Y {} + 2>/dev/null   # GNU
  else find "$1" -type f -exec stat -f %m {} + 2>/dev/null; fi | sort -n | tail -n 1            # BSD/macOS
}
with_timeout() {
  local secs="$1"; shift
  local mark; mark="$(mktemp -u "${TMPDIR:-/tmp}/ralph-stall.XXXXXX")"
  "$@" & local pid=$!
  [ -z "${RALPH_SESSION_REC:-}" ] || printf '%s\n%s\n' "$pid" "$(proc_started "$pid")" >"$RALPH_SESSION_REC"
  # The watcher must not hold our stdout: an orphaned child would keep a surrounding $(...) open.
  (
    start="$(date +%s)"
    while kill -0 "$pid" 2>/dev/null; do
      sleep 20; now="$(date +%s)"
      if [ $((now - start)) -ge "$secs" ]; then why=timeout
      elif [ -n "${RALPH_STALL_DIR:-}" ] && [ $((now - start)) -ge "$RALPH_STALL" ] \
        && [ $((now - $(newest_mtime "$RALPH_STALL_DIR" || echo "$now"))) -ge "$RALPH_STALL" ]; then why=stall; : >"$mark"
      else continue; fi
      echo "$why" >&2
      kill -TERM "$pid" 2>/dev/null; sleep 10; kill -KILL "$pid" 2>/dev/null; break
    done
  ) >/dev/null 2>&1 & local watcher=$!
  local rc=0
  wait "$pid" || rc=$?
  pkill -P "$watcher" 2>/dev/null || true
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  [ -z "${RALPH_SESSION_REC:-}" ] || rm -f "$RALPH_SESSION_REC"
  if [ -e "$mark" ]; then rm -f "$mark"; return 125; fi
  return "$rc"
}

# provider_failed <out> <err>: the run ended on a model provider error (rate limit, overload, quota, outage).
# One `tail` per file: given two, `tail` prints a `==> <path> <==` header per file, and the path carries the
# session's HHMMSS stamp, so a clean run started at 18:50:29 matched `502` and read as PROVIDER (LOB-237).
# The text is read whole before grep sees it: piped into `grep -q` under `pipefail`, a match that made grep exit
# early killed the writer with SIGPIPE, and the pipeline's 141 read as "no provider error".
# The newline between the tails keeps an `out` that ends mid-line (`Error: 4`) from running into an `err` that
# starts with digits (`29`) and spelling a status neither file holds.
provider_failed() {
  local tails; tails="$({ tail -c 6000 "$1"; printf '\n'; tail -c 6000 "$2"; } 2>/dev/null || true)"
  grep -qiE '429|rate.?limit|overloaded|quota|insufficient|unavailable|503|502|capacity|too many requests|ECONNRESET|ETIMEDOUT|No (API key|provider)|credit|billing' <<<"$tails"
}

# session <iteration> <mode>: run `.pi/ralph/<mode>.prompt.md`; echoes the control tag
# (NEXT|COMPLETE|BLOCKED|PROVIDER|NONE). A provider error falls back to the next model in RALPH_FALLBACK_MODELS;
# a timeout, a stall on the last model, or a clean run without a control line does not.
session() {
  local n="$1" mode="$2" prompt="${SESS_CWD:-$WT}/.pi/ralph/$2.prompt.md" stamp out err
  stamp="$(date +%Y%m%d-%H%M%S)-$mode-$n"
  [ -f "$prompt" ] || die "missing $prompt"
  local models=("$RALPH_MODEL") m
  local IFS_OLD="$IFS"; IFS=','; for m in $RALPH_FALLBACK_MODELS; do [ -n "$m" ] && models+=("$m"); done; IFS="$IFS_OLD"
  local attempt=0 rc tag used
  for m in "${models[@]}"; do
    attempt=$((attempt + 1)); rc=0; used="$m"
    out="$STATE/logs/$stamp.out"; err="$STATE/logs/$stamp.err"
    [ "$attempt" -eq 1 ] || { out="$STATE/logs/$stamp.try$attempt.out"; err="$STATE/logs/$stamp.try$attempt.err"; }
    log "$mode iteration $n [$m] -> $out"
    (
      cd "${SESS_CWD:-$WT}"
      export COMPOSE_PROJECT_NAME=factory   # compose run from a worktree must target the shared project
      export DATABASE_URL DOCKER_HOST="${DOCKER_HOST:-}" API_PORT="$RALPH_API_PORT" WEB_PORT="$RALPH_WEB_PORT" RALPH_PUSH \
        RALPH_WORKER RALPH_SHARED RALPH_CLAIM_TTL
      [ -n "$DOCKER_HOST" ] || unset DOCKER_HOST
      local text; text="$(sed "s/{{SPLIT_MAX}}/$RALPH_SPLIT_MAX/g" "$prompt"; run_context "$n" "$mode")"
      # Only a session in $WT holds $WT: the splitter's runs in its own worktree beside a live loop.
      local rec=""; [ "${SESS_CWD:-$WT}" != "$WT" ] || rec="$SESSION_REC"
      RALPH_SESSION_REC="$rec" RALPH_STALL_DIR="$STATE/sessions" with_timeout "$RALPH_TIMEOUT" pi -p --approve \
        --model "$m" --thinking "$RALPH_THINKING" \
        --session-dir "$STATE/sessions" --name "ralph-$mode-$n" \
        "$text" </dev/null >"$out" 2>"$err"
    ) || rc=$?
    local last; tag="NONE"
    last="$(grep -v '^[[:space:]]*$' "$out" 2>/dev/null | tail -n 1 | tr -d '`' | tr -d '[:space:]' || true)"
    case "$last" in
      "<promise>NEXT</promise>") tag=NEXT ;;
      "<promise>COMPLETE</promise>") tag=COMPLETE ;;
      "<promise>BLOCKED</promise>") tag=BLOCKED ;;
    esac
    [ "$rc" -eq 0 ] || log "pi exited $rc (see $err)"
    [ "$tag" = NONE ] || break
    if [ "$rc" -eq 125 ]; then
      log "pi stalled on $m (no activity for ${RALPH_STALL}s); killed"
      [ "$attempt" -lt "${#models[@]}" ] && { log "falling back to ${models[$attempt]}"; continue; }
      break
    fi
    case "$rc" in 124|137|143) break ;; esac
    if provider_failed "$out" "$err" && [ "$attempt" -lt "${#models[@]}" ]; then
      log "provider error on $m; falling back to ${models[$attempt]}"; continue
    fi
    break
  done
  # Every model refused: not the iteration's fault, so the driver waits instead of counting a failure.
  if [ "$tag" = NONE ] && provider_failed "$out" "$err"; then tag=PROVIDER; fi
  printf '{"at":"%s","mode":"%s","iteration":%s,"exit":%s,"tag":"%s","model":"%s","attempts":%s,"log":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$mode" "$n" "$rc" "$tag" "$used" "$attempt" "$out" >>"$STATE/runs.jsonl"
  echo "$tag"
}

lock() { # [name]: the loop holds `lock`; the splitter holds `lock-split`, so both can run
  local name="${1:-lock}"
  mkdir -p "$STATE"
  if ! mkdir "$STATE/$name" 2>/dev/null; then
    local pid; pid="$(cat "$STATE/$name/pid" 2>/dev/null || echo '?')"
    kill -0 "$pid" 2>/dev/null && die "$name is held by pid $pid"
    log "removing stale $name (pid $pid)"; rm -rf "$STATE/$name"; mkdir "$STATE/$name"
  fi
  echo $$ >"$STATE/$name/pid"
  trap "rm -rf '$STATE/$name'" EXIT
}

# --- claims (parallel workers) -----------------------------------------------------------------
claim() { RALPH_SHARED="$RALPH_SHARED" RALPH_WORKER="$RALPH_WORKER" RALPH_CLAIM_TTL="$RALPH_CLAIM_TTL" bash "$HERE/claim.sh" "$@"; }
# release_idle_claims: drop this worker's claims for issues with no open PR (blocked, skipped, or merged). An open
# PR keeps its claim, so nobody else picks the issue up while it waits for CI.
release_idle_claims() {
  local id open
  while read -r id _; do
    [ -n "$id" ] || continue
    case "$(claim list | awk -v id="$id" '$1 == id { print $2 }')" in worker=$RALPH_WORKER) ;; *) continue ;; esac
    open="$(cd "$WT" && gh pr list --state open --head "ralph/$id" --json number --jq length 2>/dev/null || echo 1)"
    [ "${open:-1}" = 0 ] && { claim release "$id"; log "released claim on $id (no open PR)"; }
  done < <(claim list)
  return 0
}

# --- merging: GitHub does it -------------------------------------------------------------------
# arm_automerge: hand every open ralph PR to GitHub's auto-merge, which squash-merges it once the required `gate`
# check passes on a branch that is up to date with main. A PR behind main is updated so its checks re-run against
# main. A PR that touches a protected path is labelled `needs-human-merge` instead. A red or conflicting PR stays
# armed and open: the next iteration fixes it (work.prompt.md, "Fix first").
arm_automerge() {
  [ "$RALPH_MERGE" = 1 ] && [ "$RALPH_PUSH" = 1 ] || return 0
  local rows n armed state
  rows="$(cd "$WT" && gh pr list --state open --limit 50 \
    --json number,headRefName,baseRefName,isDraft,autoMergeRequest,labels,mergeStateStatus \
    --jq '.[] | select(.headRefName|startswith("ralph/")) | select(.baseRefName=="main") | select(.isDraft|not)
      | select([.labels[].name] | (index("hold") or index("needs-human-merge")) | not)
      | "\(.number) \(.autoMergeRequest != null) \(.mergeStateStatus)"')" \
    || { log "gh pr list failed; auto-merge not armed this round"; return 0; }
  while read -r n armed state; do
    [ -n "$n" ] || continue
    if (cd "$WT" && gh pr diff "$n" --name-only 2>/dev/null) | grep -Eq "$PROTECTED_RE"; then
      (cd "$WT" && gh pr merge "$n" --disable-auto >/dev/null 2>&1; gh pr edit "$n" --add-label needs-human-merge >/dev/null 2>&1 \
        && gh pr comment "$n" --body "ralph: this PR touches a protected path (CI, the loop itself, lint/format/test config), so a human merges it." >/dev/null 2>&1) || true
      log "PR #$n touches a protected path -> needs-human-merge"
      continue
    fi
    if [ "$armed" != true ]; then
      if (cd "$WT" && gh pr merge "$n" --auto --squash >/dev/null 2>&1); then log "PR #$n: auto-merge armed"
      else log "PR #$n: could not arm auto-merge (is it enabled on the repo, with \`gate\` required on main?)"; fi
    fi
    if [ "$state" = BEHIND ]; then
      (cd "$WT" && gh pr update-branch "$n" >/dev/null 2>&1) && log "PR #$n: updated with main" || true
    fi
  done <<<"$rows"
  return 0
}

# nap <seconds>: sleep, but wake within 30 s of a STOP file so `stop` is never held up by a backoff.
nap() {
  local left="$1"
  while [ "$left" -gt 0 ] && [ ! -f "$STATE/STOP" ]; do
    sleep $(( left < 30 ? left : 30 )); left=$((left - 30))
  done
}

cmd_run() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  lock; take_worktree; ensure_db
  rm -f "$STATE/STOP"
  release_idle_claims
  arm_automerge
  local i=0 fails=0 waits=0
  local split_done=0
  while [ "$i" -lt "$RALPH_MAX_ITER" ]; do
    i=$((i + 1))
    [ ! -f "$STATE/STOP" ] || { log "STOP file found"; break; }
    reset_worktree
    local tag; tag="$(session "$i" work)"
    release_idle_claims
    arm_automerge
    case "$tag" in
      NEXT)     fails=0; waits=0 ;;
      COMPLETE) if [ "$split_done" = 0 ]; then split_done=1; log "queue exhausted - running split"; "$0" split; continue; else log "queue exhausted"; break; fi ;;
      PROVIDER) waits=$((waits + 1)); i=$((i - 1))
                [ "$waits" -lt "$RALPH_PROVIDER_BACKOFFS" ] || { log "every model has been refusing for $waits waits - giving up"; exit 3; }
                log "every model is refusing (rate limit, quota or outage): waiting ${RALPH_PROVIDER_BACKOFF}s ($waits/$RALPH_PROVIDER_BACKOFFS)"
                nap "$RALPH_PROVIDER_BACKOFF"; continue ;;
      BLOCKED)  log "worker reported BLOCKED - a human must look (see $STATE/logs)"; exit 2 ;;
      *)        fails=$((fails + 1)); log "no valid control line ($fails/$RALPH_MAX_FAILS)"
                [ "$fails" -lt "$RALPH_MAX_FAILS" ] || { log "too many failed iterations"; exit 3; } ;;
    esac
    sleep "$RALPH_SLEEP"
  done
  log "done after $i iteration(s)"
  reset_worktree
}

# split: break `too-big` issues into S/M children, in its own throwaway worktree so it can run beside a live loop.
cmd_split() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  lock lock-split
  local SW="${WT}-split"
  git -C "$MAIN_ROOT" fetch origin --quiet
  if [ ! -d "$SW" ]; then git -C "$MAIN_ROOT" worktree add --detach "$SW" "$RALPH_BASE_REF" >/dev/null; fi
  git -C "$SW" switch --detach "$RALPH_BASE_REF" --quiet
  local excl; excl="$(git -C "$SW" rev-parse --path-format=absolute --git-path info/exclude)"
  grep -qx '.ralph' "$excl" 2>/dev/null || echo '.ralph' >>"$excl"
  [ -L "$SW/.ralph" ] || { rm -rf "$SW/.ralph"; ln -s "$STATE" "$SW/.ralph"; }
  [ -f "$SW/.pi/ralph/split.prompt.md" ] || die "$RALPH_BASE_REF has no split.prompt.md - push the ralph tooling first"
  local tag; tag="$(SESS_CWD="$SW" session 0 split)"
  log "split finished: $tag (see $STATE/logs)"
  [ "$tag" = COMPLETE ] || exit 3
}

cmd_audit() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  lock; take_worktree; ensure_db; reset_worktree
  local tag; tag="$(session 0 audit)"
  log "audit finished: $tag"
  reset_worktree
  [ "$tag" = COMPLETE ] || exit 3
}

# parallel start <N> [--max M] | stop | kill | status: workers 1..N side by side, staggered.
workers_existing() {
  local i
  [ -d "$RALPH_PRIMARY_WORKTREE" ] && echo 1
  i=2; while [ -d "$RALPH_PRIMARY_WORKTREE-$i" ]; do echo "$i"; i=$((i + 1)); done
}
as_worker() { # <i> <subcommand> [args...]
  local i="$1"; shift
  if [ "$i" -eq 1 ]; then RALPH_WORKER=1 bash "$HERE/loop.sh" "$@"
  else env -u RALPH_WORKTREE -u RALPH_DB -u RALPH_API_PORT -u RALPH_WEB_PORT RALPH_WORKER="$i" bash "$HERE/loop.sh" "$@"; fi
}
cmd_parallel() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    start)
      local n="${1:?parallel start <N> [--max M]}"; shift
      case "$n" in ''|*[!0-9]*|0) die "parallel start: N must be a positive integer" ;; esac
      local i
      for i in $(seq 1 "$n"); do
        [ -d "$RALPH_PRIMARY_WORKTREE$([ "$i" -eq 1 ] || echo "-$i")" ] || as_worker "$i" setup
        as_worker "$i" start "$@"
        [ "$i" -eq "$n" ] || sleep "${RALPH_STAGGER:-60}"
      done ;;
    stop|kill|status)
      local i
      for i in $(workers_existing); do echo "--- worker $i"; as_worker "$i" "$sub" || true; done
      echo "--- claims"; claim list ;;
    *) die "usage: $0 parallel {start <N> [--max M]|stop|kill|status}" ;;
  esac
}

cmd_status() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  [ -f "$STATE/loop.pid" ] && kill -0 "$(cat "$STATE/loop.pid")" 2>/dev/null && echo "detached loop: ralph-loop pgid $(cat "$STATE/loop.pid")"
  echo "worktree: $WT  model: $RALPH_MODEL  push: $RALPH_PUSH"
  [ -d "$STATE/lock" ] && echo "loop: running (pid $(cat "$STATE/lock/pid" 2>/dev/null))" || echo "loop: idle"
  local spid; spid="$(live_session 2>/dev/null)" && echo "worker session: pi pid $spid"
  [ -f "$STATE/STOP" ] && echo "STOP requested"
  echo; echo "open ralph PRs:"
  (cd "$WT" && gh pr list --state open --limit 50 --json number,headRefName,autoMergeRequest,mergeStateStatus,labels \
    --jq '.[] | select(.headRefName|startswith("ralph/")) | "  #\(.number) \(.headRefName) \(.mergeStateStatus) auto-merge:\(.autoMergeRequest != null) \([.labels[].name] | join(","))"' 2>/dev/null) || echo "  (gh unavailable)"
  [ -f "$STATE/runs.jsonl" ] && { echo; echo "last runs:"; tail -n 5 "$STATE/runs.jsonl"; }
  return 0
}

# start: run the loop detached, as a process group whose leader is named `ralph-loop`; `kill` signals the group.
cmd_start() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  command -v perl >/dev/null || die "perl is needed to detach into its own process group"
  mkdir -p "$STATE"
  if [ -f "$STATE/loop.pid" ] && kill -0 "$(cat "$STATE/loop.pid")" 2>/dev/null; then
    die "already running (pgid $(cat "$STATE/loop.pid")); use: $0 kill"
  fi
  # Refuse here, in the caller's terminal, rather than in the detached run's log after printing "started".
  take_worktree
  local self="$HERE/loop.sh"
  RALPH_WORKTREE="$WT" nohup perl -MPOSIX -e 'POSIX::setsid(); exec { "bash" } "ralph-loop", @ARGV' \
    "$self" run "$@" >>"$STATE/loop.log" 2>&1 </dev/null &
  echo $! >"$STATE/loop.pid"
  sleep 1
  log "started: process name 'ralph-loop', pgid $(cat "$STATE/loop.pid"), log $STATE/loop.log"
  log "watch: tail -f $STATE/loop.log   graceful stop: $0 stop   kill now: $0 kill"
}

cmd_kill() {
  local pg; pg="$(cat "$STATE/loop.pid" 2>/dev/null || true)"
  if [ -n "$pg" ] && kill -0 "$pg" 2>/dev/null; then
    kill -TERM -- "-$pg" 2>/dev/null || kill -TERM "$pg" 2>/dev/null || true
    sleep 3; kill -KILL -- "-$pg" 2>/dev/null || true
    log "killed process group $pg"
  else
    pkill -f "ralph-loop" 2>/dev/null && log "killed by name" || log "nothing running"
  fi
  # A session can outlive a driver that was not in that group (a foreground `run` whose shell was killed): stop it too.
  # Its whole tree goes, not just the `pi`: what it started would otherwise keep writing in $WT once the record is gone.
  local spid
  if spid="$(live_session)"; then
    if stop_session "$spid"; then
      log "killed worker session pi pid $spid"; rm -f "$SESSION_REC"
    else
      log "error: worker session pi pid $spid survived SIGKILL; keeping $SESSION_REC"
    fi
  fi
  rm -f "$STATE/loop.pid"; rm -rf "$STATE/lock"
}

cmd_stop() { mkdir -p "$STATE"; touch "$STATE/STOP"; log "will stop after the current iteration"; }

# Sourced (by the ralph-*.test.ts cases in packages/storage-postgres), the file defines its functions and stops.
# Note that sourcing also applies `set -euo pipefail` and this file's WT, STATE and DATABASE_URL to the caller.
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

case "${1:-}" in
  setup)  cmd_setup ;;
  run)    shift; [ "${1:-}" = "--max" ] && RALPH_MAX_ITER="${2:?--max N}"; cmd_run ;;
  start)  shift; cmd_start "$@" ;;
  kill)   cmd_kill ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  split)  cmd_split ;;
  audit)  cmd_audit ;;
  parallel) shift; cmd_parallel "$@" ;;
  *) usage; exit 64 ;;
esac
