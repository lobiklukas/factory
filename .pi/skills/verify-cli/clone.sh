#!/usr/bin/env bash
# Drive a repo registered with only a URL (LOB-265) in a real tmux terminal: `factory repo add
# --url` clones it into the factory's cache, `factory run --repo` gets a linked worktree of that
# clone at the fetched base ref, `factory doctor` says it can run, and a clone that fails is
# `repo_clone_failed` naming the repo — from `repo add` and from `doctor`.
#
# The forge is a loopback git server this script starts (`../lib/git-remote.ts`): `git http-backend`
# behind a Basic-auth gate, so the clone only works if the control plane sends its token. Nothing
# reaches a real forge. The script owns its own API instance (its own port, session root, log, pid
# file and tmux server) and does not touch the one ./up.sh started.
#
#   ./clone.sh                     # API on :9350, forge on :9351 (CLONE_PORT, CLONE_REMOTE_PORT)
#
# Evidence: .verify/evidence/latest/cli/clone-*.txt (the raw panes) and clone.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${CLONE_PORT:-9350}"
REMOTE_PORT="${CLONE_REMOTE_PORT:-9351}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-clone"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
LOG="$RUN_DIR/api.log"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-clone"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
# The drive's own throwaway token: the forge refuses every request that does not carry it.
TOKEN="verify-clone-$(date +%s)$$"
RUN_ID="$(date +%s)$$"
REPO="acme/clone-$RUN_ID"
GHOST="acme/ghost-$RUN_ID"
SESSION_ROOT="$RUN_DIR/sessions"
FORGE_DIR="$RUN_DIR/forge"
MIRROR="$SESSION_ROOT/.cache/$REPO.git"
WORK="$RUN_DIR/work"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-62s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-62s %s\n' "$1" "$3"
  fi
}

write_checks() {
  local first=1
  local row
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n'
}

start_remote() {
  bun "$ROOT/.pi/skills/lib/git-remote.ts" "$FORGE_DIR" "$REMOTE_PORT" "$TOKEN" \
    > "$RUN_DIR/forge.log" 2>&1 &
  echo $! > "$RUN_DIR/forge.pid"
}

start_api() {
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      ALLOWED_ORIGINS="http://localhost:$PORT" \
      MODEL_BACKEND=faux \
      FAUX_COMMAND="echo faux-ok" \
      GITHUB_TOKEN="$TOKEN" \
      SESSION_ROOT="$SESSION_ROOT" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      bun run src/index.ts ) >> "$LOG" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
}

wait_ready() {
  for _ in $(seq 1 60); do
    curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

stop_pidfile() {
  local pidfile="$1"
  if [ -f "$pidfile" ]; then
    local pid; pid="$(cat "$pidfile")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  fi
}

cleanup() {
  stop_pidfile "$RUN_DIR/api.pid"
  stop_pidfile "$RUN_DIR/forge.pid"
  tmux -S "$SOCK" kill-server 2>/dev/null || true
}
trap cleanup EXIT

for p in "$PORT" "$REMOTE_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $p is already in use — set CLONE_PORT / CLONE_REMOTE_PORT to free ones" >&2
    exit 1
  fi
done

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# The forge's repository: a bare repo served at /<owner>/<name>.git, with a README on main. A second
# work clone moves main on later, so a session after it can be seen to fetch.
rm -rf "$RUN_DIR/sessions" "$FORGE_DIR" "$WORK"
mkdir -p "$FORGE_DIR/acme" "$SESSION_ROOT"
git init -q -b main --bare "$FORGE_DIR/$REPO.git"
git -C "$FORGE_DIR/$REPO.git" config http.receivepack true
git clone -q "$FORGE_DIR/$REPO.git" "$WORK" 2>/dev/null
git -C "$WORK" config user.email verify-clone@localhost
git -C "$WORK" config user.name verify-clone
printf 'seed from the forge\n' > "$WORK/README.md"
git -C "$WORK" add README.md
git -C "$WORK" commit -q -m "seed"
git -C "$WORK" push -q origin HEAD:main
FIRST_SHA="$(git -C "$WORK" rev-parse HEAD)"

: > "$LOG"
start_remote
for _ in $(seq 1 40); do grep -q '^http://' "$RUN_DIR/forge.log" 2>/dev/null && break; sleep 0.25; done
FORGE_URL="$(head -1 "$RUN_DIR/forge.log")"
start_api
wait_ready || { echo "api did not become ready — see $LOG" >&2; exit 1; }

t() { tmux -S "$SOCK" "$@"; }
pane() { t capture-pane -p -J -t "$1" -S -4000 | sed -e 's/[[:space:]]*$//'; }

run_cmd() { # window, marker, command, [tries]
  local window="$1" marker="$2" cmd="$3" tries="${4:-600}"
  t send-keys -t "$window" "clear" Enter
  sleep 0.3
  t clear-history -t "$window" 2>/dev/null || true
  t send-keys -l -t "$window" "$cmd"
  t send-keys -t "$window" Enter
  t send-keys -l -t "$window" "printf '\\n__done_%s:%s\\n' $marker \$?"
  t send-keys -t "$window" Enter
  for _ in $(seq 1 "$tries"); do
    if pane "$window" | grep -q "^__done_$marker:[0-9]*$"; then
      sleep 0.2
      return 0
    fi
    sleep 0.1
  done
  return 1
}

exit_code() { pane "$1" | grep -o "__done_$2:[0-9]*" | tail -1 | cut -d: -f2; }

t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -n cmd -x 220 -y 60 -c "$ROOT"
W="$TERM_SESSION:cmd"

# Run a command and keep its pane as evidence: marker, file, command.
drive() {
  run_cmd "$W" "$1" "$3" || true
  pane "$W" > "$EVIDENCE_DIR/$2"
}
has() { grep -qx -- "$2" "$EVIDENCE_DIR/$1"; }

# --- add with only a URL: the factory clones it ----------------------------------------------------
drive add clone-add.txt "$FACTORY repo add $REPO --url $FORGE_URL/$REPO.git --api $API_URL"
check "repo add with only --url exits 0" \
  "$([ "$(exit_code "$W" add)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code "$W" add)"
check "and says where the clone is, and that the repo is ready" \
  "$(has clone-add.txt "cache       $MIRROR" && has clone-add.txt "state       ready" &&
    has clone-add.txt "path        none" && echo 0 || echo 1)" \
  "cache=$MIRROR"
check "the cache is a bare repository holding the forge's main" \
  "$([ "$(git -C "$MIRROR" rev-parse --is-bare-repository 2>/dev/null)" = "true" ] &&
    [ "$(git -C "$MIRROR" rev-parse refs/remotes/origin/main 2>/dev/null)" = "$FIRST_SHA" ] && echo 0 || echo 1)" \
  "sha=$FIRST_SHA"
# The forge answers 401 without the token, so a clone with no credential would have failed: that it
# succeeded is the proof it was sent. Then that it was written nowhere in the cache.
check "the base is also the cache's own main, so main...factory/<id> resolves in a worktree" \
  "$([ "$(git -C "$MIRROR" rev-parse refs/heads/main 2>/dev/null)" = "$FIRST_SHA" ] && echo 0 || echo 1)" \
  "refs/heads/main=$FIRST_SHA"
check "no credential is in the clone's config, or in any file of the cache" \
  "$(grep -rqF -- "$TOKEN" "$MIRROR" && echo 1 || echo 0)" "token absent from $MIRROR"
check "the clone's config names no remote and no URL" \
  "$(grep -qE '\[remote|url *=' "$MIRROR/config" && echo 1 || echo 0)" "config"

# --- a session on the URL-only repo: a linked worktree at the fetched base ref ---------------------
drive run clone-run.txt "$FACTORY run \"clone probe\" --repo $REPO --base-ref main --api $API_URL"
SESSION_ID="$(grep -o 'ses_[0-9a-z]\{26\}' "$EVIDENCE_DIR/clone-run.txt" | head -1)"
WORKTREE="$(grep -o '^workspace .*' "$EVIDENCE_DIR/clone-run.txt" | head -1 | cut -d' ' -f2-)"
check "factory run --repo opens a session on the URL-only repo" \
  "$([ "$(exit_code "$W" run)" = "0" ] && [ -n "$SESSION_ID" ] && echo 0 || echo 1)" \
  "id=${SESSION_ID:-none} exit=$(exit_code "$W" run)"
check "its workspace is a linked worktree of the cache, on factory/<id>" \
  "$([ -n "$WORKTREE" ] && [ -f "$WORKTREE/.git" ] &&
    [ "$(cd "$WORKTREE" && cd "$(git rev-parse --git-common-dir)" && pwd -P)" = "$(cd "$MIRROR" && pwd -P)" ] &&
    [ "$(git -C "$WORKTREE" rev-parse --abbrev-ref HEAD)" = "factory/$SESSION_ID" ] && echo 0 || echo 1)" \
  "${WORKTREE:-none}"
check "at the base ref, with the repo's files" \
  "$([ "$(git -C "$WORKTREE" rev-parse HEAD 2>/dev/null)" = "$FIRST_SHA" ] &&
    [ "$(cat "$WORKTREE/README.md" 2>/dev/null)" = "seed from the forge" ] && echo 0 || echo 1)" \
  "README.md at $FIRST_SHA"
check "and no warning that it has no checkout" \
  "$(grep -q '^warning ' "$EVIDENCE_DIR/clone-run.txt" && echo 1 || echo 0)" "no warning line"

# --- each session fetches the base ref: a moved forge is what the next session starts from ---------
printf 'moved on\n' > "$WORK/MOVED.md"
git -C "$WORK" add MOVED.md
git -C "$WORK" commit -q -m "move main"
git -C "$WORK" push -q origin HEAD:main
SECOND_SHA="$(git -C "$WORK" rev-parse HEAD)"
drive run2 clone-run2.txt "$FACTORY run \"clone probe two\" --repo $REPO --base-ref main --api $API_URL"
WORKTREE2="$(grep -o '^workspace .*' "$EVIDENCE_DIR/clone-run2.txt" | head -1 | cut -d' ' -f2-)"
check "a second session is cut at the base the forge has moved to" \
  "$([ -n "$WORKTREE2" ] && [ "$(git -C "$WORKTREE2" rev-parse HEAD 2>/dev/null)" = "$SECOND_SHA" ] &&
    [ -f "$WORKTREE2/MOVED.md" ] && [ "$(git -C "$WORKTREE" rev-parse HEAD)" = "$FIRST_SHA" ] && echo 0 || echo 1)" \
  "second=$SECOND_SHA first stays $FIRST_SHA"

# --- show and doctor on the cloned repo -------------------------------------------------------------
drive show clone-show.txt "$FACTORY repo show $REPO --api $API_URL"
check "repo show reads it as ready, with its cache" \
  "$([ "$(exit_code "$W" show)" = "0" ] && has clone-show.txt "state       ready" &&
    has clone-show.txt "cache       $MIRROR" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" show)"
drive doctor clone-doctor.txt "$FACTORY doctor $REPO --allow-faux --api $API_URL"
check "factory doctor says it is ok, exit 0" \
  "$([ "$(exit_code "$W" doctor)" = "0" ] && has clone-doctor.txt "ok repo $REPO: cloned into $MIRROR" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" doctor)"

# --- a clone that fails: a typed error naming the repo and the reason -------------------------------
drive ghost clone-ghost.txt "$FACTORY repo add $GHOST --url $FORGE_URL/$GHOST.git --api $API_URL"
check "repo add for a repo the forge does not serve is repo_clone_failed, non-zero" \
  "$([ -n "$(exit_code "$W" ghost)" ] && [ "$(exit_code "$W" ghost)" != "0" ] &&
    grep -q '^error: repo_clone_failed: ' "$EVIDENCE_DIR/clone-ghost.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" ghost)"
check "the error names the repo" \
  "$(grep '^error: repo_clone_failed: ' "$EVIDENCE_DIR/clone-ghost.txt" | grep -qF "$GHOST" && echo 0 || echo 1)" \
  "$GHOST"
check "and nothing is left half-cloned in the cache" \
  "$([ ! -e "$SESSION_ROOT/.cache/$GHOST.git" ] && echo 0 || echo 1)" "no $GHOST.git"
drive ghostshow clone-ghost-show.txt "$FACTORY repo show $GHOST --api $API_URL"
check "the row stays registered, not cloned, with the sync as its remedy" \
  "$([ "$(exit_code "$W" ghostshow)" = "0" ] && has clone-ghost-show.txt "state       not cloned yet" &&
    has clone-ghost-show.txt "remedy      factory repo sync $GHOST" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" ghostshow)"
drive ghostdoctor clone-ghost-doctor.txt "$FACTORY doctor $GHOST --allow-faux --api $API_URL"
check "factory doctor reports the same failure, naming the repo and the reason, non-zero" \
  "$([ -n "$(exit_code "$W" ghostdoctor)" ] && [ "$(exit_code "$W" ghostdoctor)" != "0" ] &&
    grep -q "^fail repo $GHOST: repo_clone_failed (" "$EVIDENCE_DIR/clone-ghost-doctor.txt" &&
    grep -q " -- fix: " "$EVIDENCE_DIR/clone-ghost-doctor.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" ghostdoctor)"
drive ghostsync clone-ghost-sync.txt "$FACTORY repo sync $GHOST --api $API_URL"
check "factory repo sync fails the same typed way" \
  "$([ "$(exit_code "$W" ghostsync)" != "0" ] && grep -q '^error: repo_clone_failed: ' "$EVIDENCE_DIR/clone-ghost-sync.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" ghostsync)"
# The repo appears on the forge: the retry clones it, with no second registration.
git init -q -b main --bare "$FORGE_DIR/$GHOST.git"
git -C "$WORK" push -q "$FORGE_DIR/$GHOST.git" HEAD:main
drive ghostfixed clone-ghost-fixed.txt "$FACTORY repo sync $GHOST --api $API_URL"
check "once the forge has it, repo sync clones it and it is ready" \
  "$([ "$(exit_code "$W" ghostfixed)" = "0" ] && has clone-ghost-fixed.txt "state       ready" && echo 0 || echo 1)" \
  "exit=$(exit_code "$W" ghostfixed)"

# The log is evidence of what ran, and must not hold the token either.
check "the API's log holds no token" \
  "$(grep -qF -- "$TOKEN" "$LOG" && echo 1 || echo 0)" "log scanned"
cp "$LOG" "$EVIDENCE_DIR/clone-api.log"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "forgeUrl": "%s",\n' "$FORGE_URL"
  printf '  "repo": "%s",\n' "$REPO"
  printf '  "sessionId": "%s",\n' "$SESSION_ID"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/clone.json"

if [ "$failed" -eq 0 ]; then
  echo "clone: all checks passed"
else
  echo "clone: some checks failed — see $EVIDENCE_DIR" >&2
fi
exit "$failed"
