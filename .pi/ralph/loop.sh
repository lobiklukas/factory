#!/usr/bin/env bash
# Ralph loop driver: a fresh agent session per iteration (`pi -p`, or `opencode run` with RALPH_AGENT=opencode),
# one Linear issue per iteration.
# See .pi/ralph/README.md. Subcommands: setup | plan | run | start | kill | merge | split | audit | status | stop
set -euo pipefail

log() { printf '[ralph %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

# The usage text lives in one place: the dispatch's `*` case and the stdin refusal below both print
# it. `$1` overrides the invocation name, because there is no path to print when bash read this file
# from stdin (`$0` is the shell) and the file's own name is the useful thing to show there.
usage() {
  echo "usage: ${1:-$0} {setup|plan|run [--max N]|start [--max N]|kill|merge|split|audit|status|stop|parallel ...}  (env: RALPH_MODEL RALPH_FALLBACK_MODELS RALPH_THINKING RALPH_PUSH RALPH_MERGE RALPH_MAX_ITER RALPH_WORKTREE ...)" >&2
}

# `bash < .pi/ralph/loop.sh` reads this file from stdin: `BASH_SOURCE[0]` is unset and `$0` is the
# shell, so the file cannot locate itself — and everything below is derived from that location
# (`HERE`, `CHECKOUT`, `MAIN_ROOT`, and through them `WT`, `STATE` and every prompt path). Falling
# back to `${BASH_SOURCE[0]:-$0}` is worse than refusing, not a fix: `HERE` would point at the
# caller's cwd and the driver would act on whatever checkout that happens to be. Refuse in one line,
# with the status the no-subcommand case uses, instead of dying on `set -u` at the `HERE=` below with
# `BASH_SOURCE[0]: unbound variable` and a `cd: null directory` (LOB-110).
#
# The test is exactly that — `BASH_SOURCE[0]` empty — so the guard is a little wider than stdin, and
# that is deliberate: `bash -c "$(cat .pi/ralph/loop.sh)"` also leaves it empty (the script arrives
# as the `-c` string, not as a path) and would misderive `HERE` the same way, so it refuses too. Both
# shapes are pinned by the case below. A shape that hands it a path which is not this file's
# directory (`bash <(cat loop.sh)`, `bash -c 'source /dev/stdin' < loop.sh`) still derives `HERE`
# from that path and dies at the `git -C` below with status 128: loud, and never the caller's cwd,
# so it is filed as LOB-130 rather than guessed at here.
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
# Parallel workers (RALPH_WORKER=N, see "Parallel workers" in README.md): worker 1 is the loop as it has always been;
# worker N > 1 gets its own worktree, database and ports, and shares the plan, the progress notes and the claims.
RALPH_WORKER="${RALPH_WORKER:-1}"
case "$RALPH_WORKER" in ''|*[!0-9]*|0) echo "[ralph] error: RALPH_WORKER must be a positive integer, not '$RALPH_WORKER'" >&2; exit 64 ;; esac
_sfx=""; [ "$RALPH_WORKER" -eq 1 ] || _sfx="-$RALPH_WORKER"
RALPH_PRIMARY_WORKTREE="${RALPH_PRIMARY_WORKTREE:-$(dirname "$MAIN_ROOT")/$(basename "$MAIN_ROOT")-ralph}"
RALPH_SHARED="${RALPH_SHARED:-$(dirname "$MAIN_ROOT")/$(basename "$MAIN_ROOT")-ralph-shared}"
RALPH_WORKTREE="${RALPH_WORKTREE:-$RALPH_PRIMARY_WORKTREE$_sfx}"
RALPH_AGENT="${RALPH_AGENT:-pi}"                # pi | opencode: the CLI that runs each session
case "$RALPH_AGENT" in
  pi)       RALPH_MODEL="${RALPH_MODEL:-opencode-go/longcat-2.5-preview-free}" ;;
  opencode) RALPH_MODEL="${RALPH_MODEL:-opencode/space-bunny-free}" ;;
  *) echo "[ralph] error: RALPH_AGENT must be pi or opencode, not '$RALPH_AGENT'" >&2; exit 64 ;;
esac
RALPH_THINKING="${RALPH_THINKING:-high}"
if [ "$RALPH_AGENT" = opencode ]; then _fallback_default="opencode/nemotron-3-ultra-free"   # mimo-v2.6-flash-free finished 0 of 3 fallback runs
else _fallback_default="opencode-go/space-bunny-free"; fi
RALPH_FALLBACK_MODELS="${RALPH_FALLBACK_MODELS-$_fallback_default}"  # comma list; empty disables
RALPH_MAX_ITER="${RALPH_MAX_ITER:-10}"          # iterations per `run`
RALPH_SLEEP="${RALPH_SLEEP:-5}"                 # seconds between iterations
RALPH_TIMEOUT="${RALPH_TIMEOUT:-7200}"          # seconds per iteration
RALPH_SPLIT_MAX="${RALPH_SPLIT_MAX:-10}"        # parents split per `split` run
RALPH_STALL="${RALPH_STALL:-1500}"                # seconds with no session/subagent write before the agent is killed
RALPH_MAX_FAILS="${RALPH_MAX_FAILS:-5}"         # consecutive iterations with no valid control line
RALPH_OC_RESUMES="${RALPH_OC_RESUMES:-3}"       # opencode: resumes of a session whose model returned nothing mid-turn
RALPH_PUSH="${RALPH_PUSH:-1}"                   # 1: push branch + draft PR; 0: local branch only
RALPH_BASE_REF="${RALPH_BASE_REF:-origin/main}"
RALPH_DB="${RALPH_DB:-factory_ralph${_sfx//-/_}}"
RALPH_API_PORT="${RALPH_API_PORT:-$((9400 + 10 * (RALPH_WORKER - 1)))}"
RALPH_WEB_PORT="${RALPH_WEB_PORT:-$((3400 + 10 * (RALPH_WORKER - 1)))}"
RALPH_CLAIM_TTL="${RALPH_CLAIM_TTL:-10800}"      # seconds before another worker may take over an issue's claim

WT="$RALPH_WORKTREE"
STATE="$WT/.ralph"
DATABASE_URL="postgres://factory:factory@localhost:5442/$RALPH_DB"

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
# share_state: a worker beside worker 1 reads and writes worker 1's plan, progress notes, polish list and research
# briefs (symlinks into its .ralph), so every worker sees one queue. Logs, sessions, runs and the lock stay its own.
share_state() {
  [ "$RALPH_WORKER" -gt 1 ] || return 0
  local primary="$RALPH_PRIMARY_WORKTREE/.ralph" f
  mkdir -p "$primary/research"
  for f in plan.md progress.md polish.md; do
    touch "$primary/$f" 2>/dev/null || true
    [ -L "$STATE/$f" ] || { rm -f "$STATE/$f"; ln -s "$primary/$f" "$STATE/$f"; }
  done
  [ -L "$STATE/research" ] || { rm -rf "$STATE/research"; ln -s "$primary/research" "$STATE/research"; }
}

cmd_setup() {
  command -v "$RALPH_AGENT" >/dev/null || die "$RALPH_AGENT not on PATH"
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
  share_state
  # Credentials are local state: copy, never commit (gitignored).
  [ -f "$MAIN_ROOT/.env" ] && [ ! -f "$WT/.env" ] && cp "$MAIN_ROOT/.env" "$WT/.env"
  (cd "$WT" && bun install --frozen-lockfile)
  ensure_db
  if [ "$RALPH_AGENT" = opencode ]; then
    oc_prepare "$WT" "$RALPH_MODEL"
    (cd "$WT" && opencode mcp list 2>&1 | grep -E '^. linear +connected') >/dev/null 2>&1 \
      || log "warning: opencode's linear MCP server is not connected - run: (cd $WT && opencode mcp auth linear)"
  else
    (cd "$WT" && pi mcp list >/dev/null 2>&1) || log "warning: 'pi mcp list' failed in the worktree - check Linear auth (pi mcp login linear)"
  fi
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
  grep -qx '.opencode/' "$excl" 2>/dev/null || echo '.opencode/' >>"$excl"   # the generated opencode config (oc_prepare)
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

# agent_context: the Run-context bullet that depends on which CLI runs the session. The prompts were written for
# pi's tools; under opencode they are mapped here instead of forking every prompt.
agent_context() {
  if [ "$RALPH_AGENT" = opencode ]; then
    cat <<'OC'
- agent CLI: opencode (not pi). The pi-only tools and options named above do not exist here. Map them like this:
  - **Linear**: the `linear` MCP server's tools are called directly - `linear_get_issue`, `linear_save_issue`,
    `linear_save_comment`, `linear_list_issues` - with the same arguments the `tools.mcp__linear__*` calls above
    take. There is no `codemode`, and a result is the tool's own output, not wrapped in `content[0].text`.
  - **Subagents**: the `subagent` tool, `{ agent: "ralph-reviewer", description, prompt, background: false }`,
    runs that role in a fresh context and returns its report. **Always pass `background: false`.** This session
    ends the moment you stop calling tools and reply, and a background subagent dies with it, so one launched
    with `background: true` is lost and the iteration ends with no control line. `async: true` (also for
    `ralph-researcher`, `ralph-verifier` and `ralph-merger`), `bg_wait`, `timeoutMs` and a per-launch `model` do
    not exist: ignore those instructions. To run reviewers in parallel, make several foreground `subagent` calls
    in **one** message. Subagents still have no Linear access. A subagent that fails or returns nothing is
    relaunched once; a second failure is **Blocked**, as above.
  - Never end your reply before the control line: "I will wait for it" is not an outcome, nothing wakes you.
  - **Skills**: the `skill` tool lists them; if one is missing, read `.pi/skills/<name>/SKILL.md` directly.
OC
    printf -- '- the model fallback chain (%s) is handled by the driver per iteration, not by you.\n' "${RALPH_FALLBACK_MODELS:-<none>}"
  else
    printf -- '- subagent fallback models: %s. If a subagent launch fails with a provider error (429, overloaded, quota, unavailable), relaunch that same task once per listed model with the per-run override `model: "<id>"`. Do not edit agent files for this.\n' "${RALPH_FALLBACK_MODELS:-<none>}"
  fi
}

run_context() {
  cat <<CTX

---

## Run context (authoritative for this iteration)

- iteration: $1 of $RALPH_MAX_ITER, mode: $2
- worker: $RALPH_WORKER (other workers may run beside you; they share \`.ralph/plan.md\` and \`.ralph/progress.md\`: re-read before you edit, and change only your own row). Before you take an issue or fix a \`ralph-fix\` PR run \`bash .pi/ralph/claim.sh claim LOB-n\`; exit 1 means another worker holds it: take the next one.
- worktree (your cwd): ${SESS_CWD:-$WT}
- base ref: $RALPH_BASE_REF
- RALPH_PUSH=$RALPH_PUSH  (1: push the branch and open a draft PR; 0: commit locally only, no push, no PR)
- database for tests and verify scripts: DATABASE_URL=$DATABASE_URL (never use the default \`factory\` database)
- ports for verify-* scripts: API_PORT=$RALPH_API_PORT WEB_PORT=$RALPH_WEB_PORT
- DOCKER_HOST=${DOCKER_HOST:-<unset>}
$(agent_context)
- date: $(date -u +%Y-%m-%dT%H:%M:%SZ)
CTX
}

# Run a command with a wall-clock limit (macOS has no `timeout`).
# with_timeout <secs> <cmd...>: hard cap, plus a stall watchdog when RALPH_STALL_DIR is set: a model that
# stops answering (a free model returning nothing) leaves pi idle for hours, so kill it once nothing under that
# directory (session + subagent transcripts) has been written for RALPH_STALL seconds. Returns 125 on a stall.
# RALPH_STALL_CMD, when set, replaces the directory probe: a command that prints the newest activity as epoch
# seconds (opencode keeps its sessions in a database, not files; see oc_activity).
newest_mtime() { find "$1" -type f -exec stat -f %m {} + 2>/dev/null | sort -n | tail -n 1; }
last_activity() { if [ -n "${RALPH_STALL_CMD:-}" ]; then eval "$RALPH_STALL_CMD"; else newest_mtime "$RALPH_STALL_DIR"; fi; }
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
      elif [ -n "${RALPH_STALL_DIR:-}${RALPH_STALL_CMD:-}" ] && [ $((now - start)) -ge "$RALPH_STALL" ] \
        && [ $((now - $(last_activity))) -ge "$RALPH_STALL" ]; then why=stall; : >"$mark"
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

# --- opencode (RALPH_AGENT=opencode) -------------------------------------------------------------
# oc_prepare <cwd> <model>: write the project config `opencode run` reads from <cwd>/.opencode/. It is generated
# per attempt because the subagent roles (from .pi/agents/ralph-*.md) are pinned to the model the attempt runs on.
oc_prepare() {
  python3 "$HERE/opencode-config.py" --agents-dir "$1/.pi/agents" --model "$2" \
    --out "$1/.opencode/opencode.jsonc" --skills "$1/.pi/skills" --skills "$HOME/.pi/agent/skills" \
    || die "could not write the opencode config for $2"
}

# oc_activity <cwd>: newest activity, in epoch seconds, of any opencode session started from <cwd>, subagent child
# sessions included. A parent that waits on a long subagent writes nothing to stdout, so stdout alone cannot tell
# "working" from "hung"; the session database can. Falls back to now when it cannot be read: never a false stall.
oc_activity() {
  local db dir t
  db="$(opencode debug paths db 2>/dev/null)" || { date +%s; return; }
  dir="$(cd "$1" && pwd -P)"
  t="$(sqlite3 -readonly "$db" "select coalesce(max(m.time_updated), 0) from session_message m join session_v2 s on s.id = m.session_id where s.directory = '${dir//\'/\'\'}'" 2>/dev/null || true)"
  case "$t" in ''|*[!0-9]*|0) date +%s ;; *) echo $((t / 1000)) ;; esac
}

# oc_cut_short <out>: succeeds when an `opencode run --format json` log ends on anything but a text (or error) event:
# the model went quiet in the middle of a turn. oc_session_id <out>: the top-level session, the first event's.
oc_cut_short() {
  python3 - "$1" <<'PY' 2>/dev/null
import json, sys
last = None
for line in open(sys.argv[1], errors="replace"):
    try:
        last = json.loads(line).get("type")
    except ValueError:
        pass
sys.exit(0 if last not in (None, "text", "error") else 1)
PY
}
oc_session_id() {
  python3 - "$1" <<'PY' 2>/dev/null || true
import json, sys
for line in open(sys.argv[1], errors="replace"):
    try:
        print(json.loads(line).get("sessionID") or "")
        break
    except ValueError:
        pass
PY
}

# oc_last_line <out>: the last non-empty line of the final assistant text in an `opencode run --format json` log,
# stripped the way the control-line check strips pi's output.
oc_last_line() {
  python3 - "$1" <<'PY' 2>/dev/null || true
import json, sys
text = ""
for line in open(sys.argv[1], errors="replace"):
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if event.get("type") == "text":
        text = (event.get("part") or {}).get("text") or text
lines = [l for l in text.splitlines() if l.strip()]
print("".join(lines[-1].replace("`", "").split()) if lines else "")
PY
}

# session <iteration> <plan|work>; echoes the control tag (NEXT|COMPLETE|BLOCKED|NONE)
# A provider failure (rate limit, overload, quota, outage) is retried on the next model in the chain.
# A timeout, or a clean run that simply forgot the control line, is not: another model will not fix those.
provider_failed() { # <out> <err>
  # opencode reports a refused or failed model call as a top-level `error` event (a failed tool call is a
  # `tool_use` event, so this is never a tool's own failure): "not available in your country" matches no pattern below.
  [ "$RALPH_AGENT" != opencode ] || ! grep -q '^{"type":"error"' "$1" 2>/dev/null || return 0
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
      export DATABASE_URL DOCKER_HOST="${DOCKER_HOST:-}" API_PORT="$RALPH_API_PORT" WEB_PORT="$RALPH_WEB_PORT" RALPH_PUSH \
        RALPH_WORKER RALPH_SHARED RALPH_CLAIM_TTL
      [ -n "$DOCKER_HOST" ] || unset DOCKER_HOST
      local text; text="$(sed "s/{{SPLIT_MAX}}/$RALPH_SPLIT_MAX/g" "$prompt"; run_context "$n" "$mode")"
      if [ "$RALPH_AGENT" = opencode ]; then
        # --standalone: a private server, so the config above is read for this directory and the run dies with
        # the loop's process group instead of leaving a shared background service holding a stale one.
        # --format json: one event per line, so the log both proves liveness and holds the final text.
        oc_prepare "$PWD" "$m"
        local orc=0 resumes=0 sid
        RALPH_STALL_CMD="oc_activity '$PWD'" with_timeout "$RALPH_TIMEOUT" \
          opencode run --standalone --auto --format json -m "$m" \
          --title "ralph-$mode-$n" "$text" </dev/null >"$out" 2>"$err" || orc=$?
        # A free model sometimes returns nothing mid-turn: opencode then exits 0 on a log that ends on a
        # `step_start`, with no text and no error. Starting the iteration over would redo the whole orientation
        # (and, on a big issue, an hour of work the WIP commit only partly keeps); the session is intact, so
        # resume it. A run that ended on text without a control line is a different failure and is not resumed.
        while [ "$orc" -eq 0 ] && [ "$resumes" -lt "$RALPH_OC_RESUMES" ] && oc_cut_short "$out"; do
          sid="$(oc_session_id "$out")"; [ -n "$sid" ] || break
          resumes=$((resumes + 1))
          log "opencode ended mid-turn on $m (the model returned nothing); resuming $sid ($resumes/$RALPH_OC_RESUMES)"
          RALPH_STALL_CMD="oc_activity '$PWD'" with_timeout "$RALPH_TIMEOUT" \
            opencode run --standalone --auto --format json -m "$m" -s "$sid" \
            "Your previous reply stopped part-way: the model returned nothing. Continue exactly where you stopped and finish the iteration. Your last line must be the control line." \
            </dev/null >>"$out" 2>>"$err" || orc=$?
        done
        exit "$orc"
      else
        RALPH_STALL_DIR="$STATE/sessions" with_timeout "$RALPH_TIMEOUT" pi -p --approve \
          --model "$m" --thinking "$RALPH_THINKING" \
          --session-dir "$STATE/sessions" --name "ralph-$mode-$n" \
          "$text" </dev/null >"$out" 2>"$err"
      fi
    ) || rc=$?
    local last; tag="NONE"
    if [ "$RALPH_AGENT" = opencode ]; then last="$(oc_last_line "$out")"
    else last="$(grep -v '^[[:space:]]*$' "$out" 2>/dev/null | tail -n 1 | tr -d '`' | tr -d '[:space:]' || true)"; fi
    case "$last" in
      "<promise>NEXT</promise>") tag=NEXT ;;
      "<promise>COMPLETE</promise>") tag=COMPLETE ;;
      "<promise>BLOCKED</promise>") tag=BLOCKED ;;
    esac
    [ "$rc" -eq 0 ] || log "$RALPH_AGENT exited $rc (see $err)"
    [ "$tag" = NONE ] || break                                  # a valid control line ends it
    if [ "$rc" -eq 125 ]; then                                  # stalled: nothing written for RALPH_STALL seconds
      log "$RALPH_AGENT stalled on $m (no activity for ${RALPH_STALL}s); killed"
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
# Only worker 1 merges and syncs Linear: two workers merging the same PR would race.
if [ "$RALPH_WORKER" -eq 1 ]; then RALPH_MERGE="${RALPH_MERGE:-1}"; else RALPH_MERGE="${RALPH_MERGE:-0}"; fi
RALPH_CI_TIMEOUT="${RALPH_CI_TIMEOUT:-1800}"
PROTECTED_RE='^(\.github/|\.pi/ralph/|\.pi/agents/ralph-|\.oxlintrc\.json$|\.oxfmtrc\.jsonc$|vitest\.config\.ts$)'

RALPH_FIX_MAX="${RALPH_FIX_MAX:-3}"   # automatic fix attempts per PR before a human is asked

# --- parallel workers: claims ------------------------------------------------------------------
# .pi/ralph/claim.sh holds the claims; the driver releases them so a finished, merged or flagged issue is free again.
claim() { RALPH_SHARED="$RALPH_SHARED" RALPH_WORKER="$RALPH_WORKER" RALPH_CLAIM_TTL="$RALPH_CLAIM_TTL" bash "$HERE/claim.sh" "$@"; }
# release_idle_claims: drop this worker's claims for issues that have no open PR (blocked, skipped, or finished
# without one). An open PR keeps its claim until it merges or is flagged `ralph-fix`, so nobody else picks the issue up.
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

pr_flag() { # <pr> <label> <message>
  local n="$1" label="$2" msg="$3"
  if [ "$label" = ralph-fix ] || [ "$label" = needs-human-merge ]; then
    local fixbranch; fixbranch="$(gh pr view "$n" --json headRefName --jq .headRefName 2>/dev/null || true)"
    case "$fixbranch" in ralph/*) claim release --any "${fixbranch#ralph/}" || true ;; esac
  fi
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
    claim release --any "${branch#ralph/}" || true
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
  release_idle_claims
  if [ ! -f "$STATE/plan.md" ]; then
    [ "$RALPH_WORKER" -eq 1 ] || die "worker $RALPH_WORKER has no plan: it shares worker 1's .ralph/plan.md - plan with worker 1 first"
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
    release_idle_claims
    case "$tag" in
      NEXT)     fails=0 ;;
      COMPLETE) log "queue exhausted"; break ;;
      BLOCKED)  log "worker reported BLOCKED - a human must look (see $STATE/logs)"; exit 2 ;;
      *)        fails=$((fails + 1)); log "no valid control line ($fails/$RALPH_MAX_FAILS)"
                [ "$fails" -lt "$RALPH_MAX_FAILS" ] || { log "too many failed iterations"; exit 3; } ;;
    esac
    sleep "$RALPH_SLEEP"
  done
  release_idle_claims
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
  grep -qx '.opencode/' "$excl" 2>/dev/null || echo '.opencode/' >>"$excl"
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

# parallel start <N> [--max M] | stop | kill | status: run workers 1..N side by side, each its own worktree, database
# and ports (RALPH_WORKER=i), staggered so they do not all hit the model provider in the same second.
workers_existing() { # prints the worker numbers whose worktree exists
  local i=1
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
# Read from stdin this line is never reached — the refusal at the top exits 64 first — which is why
# neither `BASH_SOURCE[0]` use in this file needs a fallback.
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
  parallel) shift; cmd_parallel "$@" ;;
  *) usage; exit 64 ;;
esac
