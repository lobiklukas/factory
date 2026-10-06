#!/usr/bin/env bash
# Ralph loop driver: a fresh `pi -p` session per iteration, one Linear issue per iteration.
# See .pi/ralph/README.md. Subcommands: setup | plan | run | start | kill | merge | split | audit | status | stop
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT="$(git -C "$HERE" rev-parse --show-toplevel)"
COMMON="$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="$(dirname "$COMMON")"

# --- configuration (all overridable from the environment) -------------------------------------
RALPH_WORKTREE="${RALPH_WORKTREE:-$(dirname "$MAIN_ROOT")/$(basename "$MAIN_ROOT")-ralph}"
RALPH_MODEL="${RALPH_MODEL:-opencode-go/longcat-2.5-preview-free}"
RALPH_THINKING="${RALPH_THINKING:-high}"
RALPH_FALLBACK_MODELS="${RALPH_FALLBACK_MODELS-opencode-go/space-bunny-free}"  # comma list; empty disables
RALPH_MAX_ITER="${RALPH_MAX_ITER:-10}"          # iterations per `run`
RALPH_SLEEP="${RALPH_SLEEP:-5}"                 # seconds between iterations
RALPH_TIMEOUT="${RALPH_TIMEOUT:-7200}"          # seconds per iteration
RALPH_SPLIT_MAX="${RALPH_SPLIT_MAX:-10}"        # parents split per `split` run
RALPH_STALL="${RALPH_STALL:-1500}"                # seconds with no session/subagent write before pi is killed
RALPH_MAX_FAILS="${RALPH_MAX_FAILS:-5}"         # consecutive iterations with no valid control line
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

# `docker`, with a colima fallback, for the driver's own calls. AGENTS.md: the active context may be
# a stopped Docker Desktop while Colima runs.
#
# An explicit `DOCKER_HOST` is authoritative and is never rewritten — the promise
# `.pi/skills/lib/postgres.sh`'s `pg_docker` makes, and the one every verify-* skill's docker call
# depends on. The rewrite here used to overrule it: `cmd_run` calls `ensure_db`, so the exported
# value is the one `session` hands to every `pi -p` iteration, and an agent's drive then talked to
# colima while the caller had chosen another socket (LOB-105). An empty value counts as unset, the
# same way `pg_docker` reads it.
docker_env() {
  if [ -z "${DOCKER_HOST:-}" ] && ! docker info >/dev/null 2>&1 &&
    [ -S "$HOME/.colima/default/docker.sock" ]; then
    export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
  fi
}

ensure_db() {
  docker_env
  # "Is Postgres up?" is the one question every verify-* skill asks, and since LOB-104 and LOB-106
  # the answer lives in `.pi/skills/lib/postgres.sh`: the port is the only claim, because compose's
  # exit code is not evidence that a database is there, in either direction. This driver used to
  # ask compose itself and trust the status, so a database that was up and healthy could still
  # refuse to start the loop — the loop's own version of the bug those two tickets removed from the
  # skills. `PG_ROOT` is pinned rather than derived: belt-and-braces. The `source` below already names
  # the human's checkout, so the helper's own derivation would land on the same root; pinning keeps
  # compose tied to the checkout that owns the database's project even if this file is ever sourced
  # from somewhere else. It is a plain assignment, not an export, so no session inherits it. `PG_PORT`
  # is deliberately left to the helper's default — 5442, the port `DATABASE_URL` above names — and a
  # drive or a test may set it in the environment: `ensure_db` then probes that port while the
  # sessions it starts still talk to 5442, which is what the storage-postgres cases rely on.
  PG_ROOT="$MAIN_ROOT"
  source "$MAIN_ROOT/.pi/skills/lib/postgres.sh"
  ensure_postgres ||
    die "postgres is not up on port ${PG_PORT}; the loop will not start agents against it"
  # The database itself, asked of whichever postgres publishes the port rather than of the project
  # this directory would name: the human's `factory-postgres-1` usually holds 5442, and `compose
  # exec` can only reach the project of the directory it runs from. `docker exec` reaches either,
  # which is what keeps a database that a container already publishes — the common case on a
  # developer machine — free of any `compose` call at all. When nothing publishes the port (a native
  # server, a tunnel) there is no container to exec into and the existence question falls back to
  # `compose exec`, one compose call more than the container case and no worse than this function was
  # before LOB-108. No `-T`: that is a `docker compose exec` flag, not a `docker exec` one —
  # `docker exec` simply does not allocate a terminal when stdin is not one.
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

# --- setup: worktree, dependencies, database ---------------------------------------------------
cmd_setup() {
  command -v pi >/dev/null || die "pi not on PATH"
  command -v gh >/dev/null || die "gh not on PATH"
  git -C "$MAIN_ROOT" fetch origin --quiet
  if [ ! -d "$WT" ]; then
    git -C "$MAIN_ROOT" worktree add --detach "$WT" "$RALPH_BASE_REF"
    log "worktree at $WT ($RALPH_BASE_REF)"
  fi
  # An existing worktree may predate the last push: move it to the current base (stash leftovers first).
  if [ -n "$(git -C "$WT" status --porcelain --untracked-files=no)" ]; then
    git -C "$WT" stash push -m "ralph-setup-$(date +%Y%m%d-%H%M%S)" >/dev/null
  fi
  git -C "$WT" switch --detach "$RALPH_BASE_REF" --quiet
  [ -f "$WT/.pi/ralph/work.prompt.md" ] || die "$RALPH_BASE_REF has no .pi/ralph/ - commit and push the ralph tooling (.pi/ralph, .pi/agents/ralph-*) to $RALPH_BASE_REF first"
  mkdir -p "$STATE/logs" "$STATE/sessions" "$STATE/research"
  # Credentials are local state: copy, never commit (gitignored).
  [ -f "$MAIN_ROOT/.env" ] && [ ! -f "$WT/.env" ] && cp "$MAIN_ROOT/.env" "$WT/.env"
  (cd "$WT" && bun install --frozen-lockfile)
  ensure_db
  (cd "$WT" && pi mcp list >/dev/null 2>&1) || log "warning: 'pi mcp list' failed in the worktree - check Linear auth (pi mcp login linear)"
  for l in "hold:Never auto-merge:B60205" "ralph-fix:Needs a fix before the ralph loop can merge it:D93F0B" "needs-human-merge:Touches protected paths; a human merges:FBCA04"; do
    (cd "$WT" && gh label create "${l%%:*}" --description "$(echo "$l" | cut -d: -f2)" --color "${l##*:}" >/dev/null 2>&1) || true
  done
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
- worktree (your cwd): ${SESS_CWD:-$WT}
- base ref: $RALPH_BASE_REF
- RALPH_PUSH=$RALPH_PUSH  (1: push the branch and open a draft PR; 0: commit locally only, no push, no PR)
- database for tests and verify scripts: DATABASE_URL=$DATABASE_URL (never use the default \`factory\` database)
- ports for verify-* scripts: API_PORT=$RALPH_API_PORT WEB_PORT=$RALPH_WEB_PORT
- DOCKER_HOST=${DOCKER_HOST:-<unset>}
- subagent fallback models: ${RALPH_FALLBACK_MODELS:-<none>}. If a subagent launch fails with a provider error (429, overloaded, quota, unavailable), relaunch that same task once per listed model with the per-run override \`model: "<id>"\`. Do not edit agent files for this.
- date: $(date -u +%Y-%m-%dT%H:%M:%SZ)
CTX
}

# Run a command with a wall-clock limit (macOS has no `timeout`).
# with_timeout <secs> <cmd...>: hard cap, plus a stall watchdog when RALPH_STALL_DIR is set: a model that
# stops answering (a free model returning nothing) leaves pi idle for hours, so kill it once nothing under that
# directory (session + subagent transcripts) has been written for RALPH_STALL seconds. Returns 125 on a stall.
newest_mtime() { find "$1" -type f -exec stat -f %m {} + 2>/dev/null | sort -n | tail -n 1; }
with_timeout() {
  local secs="$1"; shift
  local mark; mark="$(mktemp -u "${TMPDIR:-/tmp}/ralph-stall.XXXXXX")"
  "$@" & local pid=$!
  # The watcher must not hold our stdout: an orphaned child would keep a surrounding $(...) open.
  (
    start="$(date +%s)"
    while kill -0 "$pid" 2>/dev/null; do
      sleep 20; now="$(date +%s)"
      if [ $((now - start)) -ge "$secs" ]; then why=timeout
      elif [ -n "${RALPH_STALL_DIR:-}" ] && [ $((now - start)) -ge "$RALPH_STALL" ] \
        && [ $((now - $(newest_mtime "$RALPH_STALL_DIR"))) -ge "$RALPH_STALL" ]; then why=stall; : >"$mark"
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
  if [ -e "$mark" ]; then rm -f "$mark"; return 125; fi
  return "$rc"
}

# session <iteration> <plan|work>; echoes the control tag (NEXT|COMPLETE|BLOCKED|NONE)
# A provider failure (rate limit, overload, quota, outage) is retried on the next model in the chain.
# A timeout, or a clean run that simply forgot the control line, is not: another model will not fix those.
provider_failed() { # <out> <err>
  tail -c 6000 "$1" "$2" 2>/dev/null | grep -qiE '429|rate.?limit|overloaded|quota|insufficient|unavailable|503|502|capacity|too many requests|ECONNRESET|ETIMEDOUT|No (API key|provider)|credit|billing'
}

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
      export COMPOSE_PROJECT_NAME=factory   # compose run from a worktree must target the shared project, not factory-ralph
      export DATABASE_URL DOCKER_HOST="${DOCKER_HOST:-}" API_PORT="$RALPH_API_PORT" WEB_PORT="$RALPH_WEB_PORT" RALPH_PUSH
      [ -n "$DOCKER_HOST" ] || unset DOCKER_HOST
      RALPH_STALL_DIR="$STATE/sessions" with_timeout "$RALPH_TIMEOUT" pi -p --approve \
        --model "$m" --thinking "$RALPH_THINKING" \
        --session-dir "$STATE/sessions" --name "ralph-$mode-$n" \
        "$(sed "s/{{SPLIT_MAX}}/$RALPH_SPLIT_MAX/g" "$prompt"; run_context "$n" "$mode")" \
        </dev/null >"$out" 2>"$err"
    ) || rc=$?
    local last; tag="NONE"
    last="$(grep -v '^[[:space:]]*$' "$out" 2>/dev/null | tail -n 1 | tr -d '`' | tr -d '[:space:]' || true)"
    case "$last" in
      "<promise>NEXT</promise>") tag=NEXT ;;
      "<promise>COMPLETE</promise>") tag=COMPLETE ;;
      "<promise>BLOCKED</promise>") tag=BLOCKED ;;
    esac
    [ "$rc" -eq 0 ] || log "pi exited $rc (see $err)"
    [ "$tag" = NONE ] || break                                  # a valid control line ends it
    if [ "$rc" -eq 125 ]; then                                  # stalled: nothing written for RALPH_STALL seconds
      log "pi stalled on $m (no activity for ${RALPH_STALL}s); killed"
      [ "$attempt" -lt "${#models[@]}" ] && { log "falling back to ${models[$attempt]}"; continue; }
      break
    fi
    case "$rc" in 124|137|143) break ;; esac                    # timed out / killed: do not retry
    if provider_failed "$out" "$err" && [ "$attempt" -lt "${#models[@]}" ]; then
      log "provider error on $m; falling back to ${models[$attempt]}"; continue
    fi
    break
  done
  printf '{"at":"%s","mode":"%s","iteration":%s,"exit":%s,"tag":"%s","model":"%s","attempts":%s,"log":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$mode" "$n" "$rc" "$tag" "$used" "$attempt" "$out" >>"$STATE/runs.jsonl"
  echo "$tag"
}

lock() { # [name]: the main loop holds `lock`; the splitter holds `lock-split`, so both can run
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

# --- merge: the driver, not the model, merges ---------------------------------------------------
# A PR merges only when ALL hold: it is a ralph/* PR targeting main; no `hold`/`needs-human-merge`
# label and no CHANGES_REQUESTED review; it touches no protected path; the worker's review record
# (a PR comment) names the current head with clean verdicts; the driver re-ran the full gate on the
# branch merged with main and it passed; and the GitHub `gate` check, if reported, passed.
RALPH_MERGE="${RALPH_MERGE:-1}"
RALPH_CI_TIMEOUT="${RALPH_CI_TIMEOUT:-1800}"
PROTECTED_RE='^(\.github/|\.pi/ralph/|\.pi/agents/ralph-|\.oxlintrc\.json$|\.oxfmtrc\.jsonc$|vitest\.config\.ts$)'

RALPH_FIX_MAX="${RALPH_FIX_MAX:-3}"   # automatic fix attempts per PR before a human is asked

pr_flag() { # <pr> <label> <message>
  local n="$1" label="$2" msg="$3"
  if [ "$label" = ralph-fix ]; then
    local tries; tries="$(gh pr view "$n" --json comments --jq '[.comments[].body | select(contains("<!-- ralph-fix -->"))] | length' 2>/dev/null || echo 0)"
    if [ "${tries:-0}" -ge "$RALPH_FIX_MAX" ]; then
      gh pr edit "$n" --add-label needs-human-merge --remove-label ralph-fix >/dev/null 2>&1 || true
      gh pr comment "$n" --body "ralph: giving up after $tries automatic fix attempts. A human needs to look at this PR. Latest problem: $(printf '%s' "$msg" | head -n 3)" >/dev/null 2>&1 || true
      echo "PR #$n stuck after $tries attempts: $(date -u +%FT%TZ)" >>"$STATE/stuck.txt"
      log "PR #$n -> needs-human-merge (fix attempts exhausted)"
      return 0
    fi
    msg="$msg
<!-- ralph-fix -->"
  fi
  gh pr edit "$n" --add-label "$label" >/dev/null 2>&1 || true
  gh pr comment "$n" --body "ralph: $msg" >/dev/null 2>&1 || true
  log "PR #$n -> $label: $(printf '%s' "$msg" | head -n 1)"
}

# review_ok <pr> <head-sha>: 0 = clean record for this head; 2 = record is for another head; 1 = missing/unclean
review_ok() {
  local body json out rc=0
  body="$(gh pr view "$1" --json comments --jq '[.comments[].body | select(contains("ralph-review:"))] | last // ""' 2>/dev/null || true)"
  [ -n "$body" ] || { echo "no review record"; return 1; }
  json="$(printf '%s\n' "$body" | sed -n 's/.*<!-- *ralph-review: *\(.*}\) *-->.*/\1/p' | tail -n 1)"
  out="$(printf '%s' "$json" | python3 -c '
import json, sys
head = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    print("review record is not valid JSON"); sys.exit(1)
if d.get("head") != head:
    print("review record is for %s, PR head is %s" % (str(d.get("head"))[:7], head[:7])); sys.exit(2)
ok = lambda k: str(d.get(k, "")).strip().upper().startswith("OK")
design_ok = ok("design") or str(d.get("design", "")).strip().lower() in ("n/a", "na")
if not (ok("spec") and ok("standards") and ok("tests") and design_ok) or d.get("p0p1_open", 1) != 0 or d.get("gate") != "green":
    print("review record is not clean: " + json.dumps(d)); sys.exit(1)
' "$2")" || rc=$?
  [ -z "$out" ] || echo "$out"
  return "$rc"
}

# ci_report <pr>: when any check on the PR has failed, label it ralph-fix with the failing jobs and the
# tail of their logs, so the next iteration fixes it. 0 = a failure was found and flagged.
ci_report() {
  local n="$1" failed link runid log
  failed="$(gh pr checks "$n" --json name,bucket,link --jq '.[] | select(.bucket=="fail") | "- \(.name): \(.link)"' 2>/dev/null || true)"
  [ -n "$failed" ] || return 1
  link="$(printf '%s\n' "$failed" | head -n 1 | sed 's/.*: //')"
  runid="$(printf '%s' "$link" | sed -n 's|.*/runs/\([0-9][0-9]*\).*|\1|p')"
  log=""; [ -z "$runid" ] || log="$(gh run view "$runid" --log-failed 2>/dev/null | tail -n 60 || true)"
  pr_flag "$n" ralph-fix "CI is red on this PR. Failing checks:
$failed

\`\`\`
$log
\`\`\`
Reproduce locally with the same command as the failing job (\`bun run <format:check|lint|type-check|build|test>\`), fix the cause, push (no force), re-run the reviewers, post a fresh review record. If the same job also fails on main it is pre-existing: file it per .pi/ralph/ticket.md."
  return 0
}

ci_ok() { # <pr>: 0 when the gate check passed or none exists on main; 1 on failure/timeout (already flagged)
  git -C "$WT" cat-file -e "origin/main:.github/workflows/gate.yml" 2>/dev/null || return 0
  local tries=0 out rc
  while [ "$tries" -lt 4 ]; do
    rc=0; out="$(with_timeout "$RALPH_CI_TIMEOUT" gh pr checks "$1" --watch --interval 20 2>&1)" || rc=$?
    case "$out" in *"no checks reported"*) tries=$((tries + 1)); sleep 20; continue ;; esac
    [ "$rc" -eq 0 ] && return 0
    ci_report "$1" || pr_flag "$1" ralph-fix "the GitHub checks did not pass or did not finish within ${RALPH_CI_TIMEOUT}s: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
    return 1
  done
  return 0  # nothing reported after ~80s: the local gate is the authority
}

merge_one() { # <pr> <branch>  -> 0 merged, 1 not merged
  local n="$1" branch="$2" issue head url title files rc
  issue="${branch#ralph/}"
  git fetch origin --quiet
  head="$(gh pr view "$n" --json headRefOid --jq .headRefOid)"

  # A red check is a defect to fix, whatever else is true of the PR.
  if ci_report "$n"; then return 1; fi

  files="$(gh pr diff "$n" --name-only)"
  if printf '%s\n' "$files" | grep -Eq "$PROTECTED_RE"; then
    pr_flag "$n" needs-human-merge "touches a protected path (CI, the loop itself, lint/format/test config), so a human merges this: $(printf '%s\n' "$files" | grep -E "$PROTECTED_RE" | head -n 5 | tr '\n' ' ')"
    return 1
  fi

  local why; why="$(review_ok "$n" "$head")" && rc=0 || rc=$?
  if [ "$rc" -eq 2 ]; then pr_flag "$n" ralph-fix "the head moved after review ($why). Re-run the reviewers on the current diff and post a fresh review record."; return 1; fi
  if [ "$rc" -ne 0 ]; then log "PR #$n skipped: $why"; return 1; fi

  # Branch + current main, in the worktree, exactly as it would land.
  git switch --detach "origin/$branch" --quiet
  if ! git merge --no-edit origin/main >/dev/null 2>&1; then
    local conflicts; conflicts="$(git diff --name-only --diff-filter=U | head -n 10 | tr '\n' ' ')"
    git merge --abort 2>/dev/null || true
    pr_flag "$n" ralph-fix "conflicts with main in: $conflicts. Merge origin/main into the branch, resolve, re-run the gate and reviewers, push (no force), post a fresh review record."
    return 1
  fi
  local merged_sha; merged_sha="$(git rev-parse HEAD)"

  local glog="$STATE/logs/merge-pr$n-$(date +%Y%m%d-%H%M%S).log"
  log "PR #$n ($issue): re-running the gate -> $glog"
  if ! ( cd "$WT" && export DATABASE_URL API_PORT="$RALPH_API_PORT" WEB_PORT="$RALPH_WEB_PORT" \
         && bun install --frozen-lockfile \
         && bun run format:check && bun run build && bun run lint && bun run test && bun run type-check ) >"$glog" 2>&1; then
    pr_flag "$n" ralph-fix "the merge gate failed on this branch merged with main. Last lines of $(basename "$glog"):
\`\`\`
$(tail -n 40 "$glog")
\`\`\`
Fix the cause. If it also fails on a clean origin/main it is pre-existing: file it per .pi/ralph/ticket.md and say so here."
    return 1
  fi

  if [ "$merged_sha" != "$head" ]; then
    [ "$RALPH_PUSH" = 1 ] || { log "PR #$n needs a push of the merge with main, but RALPH_PUSH=0"; return 1; }
    git push origin "HEAD:refs/heads/$branch" --quiet
    head="$merged_sha"
  fi
  if ! ci_ok "$n"; then return 1; fi

  title="$(gh pr view "$n" --json title --jq .title)"; url="$(gh pr view "$n" --json url --jq .url)"
  gh pr ready "$n" >/dev/null 2>&1 || true
  if gh pr merge "$n" --squash --match-head-commit "$head" --subject "$title (#$n)" --body "Merged by the ralph loop after: reviewer verdicts clean, merge gate green ($(basename "$glog")). Linear: $issue" >/dev/null; then
    git push origin --delete "$branch" --quiet 2>/dev/null || true
    echo "$issue $url" >>"$STATE/merged.txt"
    log "merged PR #$n ($issue)"
    return 0
  fi
  log "gh could not merge PR #$n"; return 1
}

merge_ready() {
  [ "$RALPH_MERGE" = 1 ] || return 0
  [ "$RALPH_PUSH" = 1 ] || return 0
  command -v python3 >/dev/null || { log "python3 missing: merge step skipped"; return 0; }
  local pass=0 progress
  while [ "$pass" -lt 3 ]; do   # a merged parent retargets its child to main: take another pass
    pass=$((pass + 1)); progress=0
    reset_worktree
    local rows; rows="$(cd "$WT" && gh pr list --state open --limit 50 --json number,headRefName,baseRefName,labels,reviewDecision \
      --jq '.[] | select(.headRefName|startswith("ralph/")) | select(.baseRefName=="main") | select(.reviewDecision!="CHANGES_REQUESTED") | select([.labels[].name]|index("hold")|not) | select([.labels[].name]|index("ralph-fix")|not) | select([.labels[].name]|index("needs-human-merge")|not) | "\(.number) \(.headRefName)"' | sort -n)"
    [ -n "$rows" ] || break
    while read -r n branch; do
      [ -n "$n" ] || continue
      if merge_one "$n" "$branch"; then progress=1; else reset_worktree; fi
    done <<<"$rows"
    [ "$progress" -eq 1 ] || break
  done
  reset_worktree
  if [ -s "$STATE/merged.txt" ]; then
    log "syncing Linear for merged PRs"
    [ "$(session 0 close)" = COMPLETE ] && : >"$STATE/merged.txt" || log "close-out incomplete; merged.txt kept for the next pass"
  fi
}

cmd_merge() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  lock; ensure_db; merge_ready
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
    merge_ready
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
  merge_ready
  log "done after $i iteration(s)"
  reset_worktree
}

# split: break `too-big` issues into S/M children. Runs beside a live loop, so it uses its OWN throwaway
# worktree (never the loop's) and shares only the .ralph state directory.
cmd_split() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  [ -f "$STATE/plan.md" ] || die "no plan - run: $0 plan"
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
  lock; ensure_db; reset_worktree
  local tag; tag="$(session 0 audit)"
  log "audit finished: $tag"
  reset_worktree
  [ "$tag" = COMPLETE ] || exit 3
}

cmd_status() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  [ -f "$STATE/loop.pid" ] && kill -0 "$(cat "$STATE/loop.pid")" 2>/dev/null && echo "detached loop: ralph-loop pgid $(cat "$STATE/loop.pid")"
  echo "worktree: $WT  model: $RALPH_MODEL  push: $RALPH_PUSH"
  [ -d "$STATE/lock" ] && echo "loop: running (pid $(cat "$STATE/lock/pid" 2>/dev/null))" || echo "loop: idle"
  [ -f "$STATE/STOP" ] && echo "STOP requested"
  [ -s "$STATE/stuck.txt" ] && { echo "needs a human:"; sed 's/^/  /' "$STATE/stuck.txt"; }
  if [ -f "$STATE/plan.md" ]; then
    echo; echo "queue:"; grep -E '^\| *[0-9]+ ' "$STATE/plan.md" | awk -F'|' '{printf "  %-4s %-8s %-12s %s\n", $2, $3, $5, $4}'
  fi
  [ -f "$STATE/runs.jsonl" ] && { echo; echo "last runs:"; tail -n 5 "$STATE/runs.jsonl"; }
  return 0
}

# start: run the loop detached, as a process group whose leader is named `ralph-loop`.
# Kill it with `kill`: ralph:kill signals the whole group (loop, pi sessions, subagents).
cmd_start() {
  [ -d "$WT" ] || die "no worktree - run: $0 setup"
  command -v perl >/dev/null || die "perl is needed to detach into its own process group"
  mkdir -p "$STATE"
  if [ -f "$STATE/loop.pid" ] && kill -0 "$(cat "$STATE/loop.pid")" 2>/dev/null; then
    die "already running (pgid $(cat "$STATE/loop.pid")); use: $0 kill"
  fi
  local self="$HERE/loop.sh"
  RALPH_WORKTREE="$WT" nohup perl -MPOSIX -e 'POSIX::setsid(); exec { "bash" } "ralph-loop", @ARGV' \
    "$self" run "$@" >>"$STATE/loop.log" 2>&1 </dev/null &
  echo $! >"$STATE/loop.pid"
  sleep 1
  log "started: process name 'ralph-loop', pgid $(cat "$STATE/loop.pid"), log $STATE/loop.log"
  log "watch: tail -f $STATE/loop.log   graceful stop: $0 stop   kill now: $0 kill   (or: pkill -f ralph-loop)"
}

# kill: terminate the detached loop and everything it spawned.
cmd_kill() {
  local pg; pg="$(cat "$STATE/loop.pid" 2>/dev/null || true)"
  if [ -n "$pg" ] && kill -0 "$pg" 2>/dev/null; then
    kill -TERM -- "-$pg" 2>/dev/null || kill -TERM "$pg" 2>/dev/null || true
    sleep 3; kill -KILL -- "-$pg" 2>/dev/null || true
    log "killed process group $pg"
  else
    pkill -f "ralph-loop" 2>/dev/null && log "killed by name" || log "nothing running"
  fi
  rm -f "$STATE/loop.pid"; rm -rf "$STATE/lock"
}

cmd_stop() { mkdir -p "$STATE"; touch "$STATE/STOP"; log "will stop after the current iteration"; }

# Sourced, the file defines the functions and stops: `packages/storage-postgres/src/ralph-docker-env.test.ts`
# drives `docker_env` and `packages/storage-postgres/src/ralph-ensure-db.test.ts` drives `ensure_db`,
# each against a fake `docker`. Executed — `bun run ralph <subcommand>`, `cmd_start`'s
# re-exec of `"$self"` — `$0` is this file and the dispatch runs as before. `$0` is the script's path
# even when the process was re-exec'd under another argv[0] ("ralph-loop"), so the comparison holds.
# Sourcing is not free: it also applies `set -euo pipefail` and this file's own `WT`, `STATE` and
# `DATABASE_URL` (the ralph worktree and its database) to the sourcing shell — the opposite of
# `.pi/skills/lib/postgres.sh`'s contract, which the caller owns. Only those two test files may
# source it.
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

case "${1:-}" in
  setup)  cmd_setup ;;
  plan)   cmd_plan ;;
  run)    shift; [ "${1:-}" = "--max" ] && RALPH_MAX_ITER="${2:?--max N}"; cmd_run ;;
  audit)  cmd_audit ;;
  split)  cmd_split ;;
  merge)  cmd_merge ;;
  start)  shift; cmd_start "$@" ;;
  kill)   cmd_kill ;;
  status) cmd_status ;;
  stop)   cmd_stop ;;
  *) echo "usage: $0 {setup|plan|run [--max N]|start [--max N]|kill|merge|split|audit|status|stop}  (env: RALPH_MODEL RALPH_FALLBACK_MODELS RALPH_THINKING RALPH_PUSH RALPH_MERGE RALPH_MAX_ITER RALPH_WORKTREE ...)" >&2; exit 64 ;;
esac
