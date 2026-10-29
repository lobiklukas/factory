#!/usr/bin/env bash
# Launch the whole-workflow instance (LOB-40): verify-board's control plane, dashboard and seeded
# board — its own `up.sh`, not a second launcher — wired to a Linear and a GitHub that the loop runs
# through end to end, on a scratch database of its own.
#
#   ./up.sh            faux: loopback Linear, GitHub and git forge; the faux model
#   ./up.sh --live     the owner's run: real Linear, real GitHub, the anthropic model (never run by
#                      an agent; refuses, naming each variable, without live-env.sh's variables)
#
# What it adds on top of verify-board's instance, all through variables that `up.sh` already hands
# the API (see its header):
#
#   a scratch database  `<base>_wf_<stamp>` on DATABASE_URL's server, made over TCP by
#                       `scratch-db.ts` and recorded in .verify/run/workflow/database; `down.sh`
#                       drops it. Every drive starts on an empty board.
#   the label mapping   TRIGGER_RULES maps the label `factory` (WORKFLOW_LINEAR_LABEL in live mode)
#                       to the board's repository in `card` mode (LOB-254): a delegated issue is a
#                       card on the board, bound to the repo and `main`, and opens no session itself.
#   Linear              faux: `../verify-api/linear-api-fake.ts` on LINEAR_PORT, its ledger in
#                       .verify/run/workflow/linear-ledger.json, a fresh LINEAR_WEBHOOK_SECRET the
#                       drive signs deliveries with, and LINEAR_API_URL at the fake with a key it
#                       never checks. Live: Linear itself, with the owner's key and webhook secret.
#   the git forge       faux: `../verify-api/git-forge-fake.ts` on GIT_PORT — bare repositories over
#                       git's smart HTTP behind a gate that accepts only the instance's token — holding
#                       a bare clone of verify-board's fixture as `<slug>.git`. The repository is
#                       registered with that URL, so the worktree is cut from the forge's `main` and the
#                       PR step's push is a real `git push` with the CredentialProvider's token. The
#                       GitHub fake reads the same root (BOARD_GITHUB_GIT_ROOT), so it refuses a PR
#                       whose head was not pushed. Live: github.com/<WORKFLOW_GITHUB_REPO>.
#   the gate            APPROVAL_REQUIRED=`git commit` (WORKFLOW_APPROVAL_REQUIRED in live mode): the
#                       builder's commit waits for a person; FAUX_EVERY_TURN makes the faux builder
#                       retry its call once the approval resumes it (LOB-52).
#   a cost              FAUX_COST=0.01: every faux answer costs a cent, so the session list and the
#                       spend pane have a cost to show (faux only; a real model reports its own).
#
# Ports: API_PORT (9610), WEB_PORT (3610), GITHUB_PORT (API_PORT+1), LINEAR_PORT (API_PORT+2), GIT_PORT
# (API_PORT+3). The instance is recorded in .verify/run/workflow/instance.json for doctor.sh and
# drive.sh. verify-board's own files stay where its scripts put them (.verify/run), so run one board
# instance at a time, as verify-board says.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL="$ROOT/.pi/skills/verify-workflow"
BOARD="$ROOT/.pi/skills/verify-board"
RUN_DIR="$ROOT/.verify/run"
WF_DIR="$RUN_DIR/workflow"
MODE=faux
[ "${1:-}" = "--live" ] && MODE=live

# shellcheck source=live-env.sh
source "$SKILL/live-env.sh"
if [ "$MODE" = "live" ]; then
  live_refusal "up.sh" || exit $?
fi

unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

API_PORT="${API_PORT:-9610}"
WEB_PORT="${WEB_PORT:-3610}"
GITHUB_PORT="${GITHUB_PORT:-$((API_PORT + 1))}"
LINEAR_PORT="${LINEAR_PORT:-$((API_PORT + 2))}"
GIT_PORT="${GIT_PORT:-$((API_PORT + 3))}"
BASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
STAMP="$(date +%s)"

if [ -s "$WF_DIR/instance.json" ] || [ -s "$WF_DIR/database" ]; then
  echo "a workflow instance is already recorded in $WF_DIR — run ./down.sh first" >&2
  exit 1
fi
mkdir -p "$WF_DIR"

PORTS=("$API_PORT" "$WEB_PORT")
[ "$MODE" = "faux" ] && PORTS+=("$GITHUB_PORT" "$LINEAR_PORT" "$GIT_PORT")
for port in "${PORTS[@]}"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already held — pick another API_PORT/WEB_PORT/GITHUB_PORT/LINEAR_PORT/GIT_PORT" >&2
    exit 1
  fi
done

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# --- the scratch database -------------------------------------------------------------------------
BASE_NAME="$(printf '%s' "$BASE_URL" | sed -n 's#^.*/\([A-Za-z0-9_]*\)\(?.*\)\{0,1\}$#\1#p')"
DB_NAME="$(printf '%s' "${BASE_NAME:-factory}" | tr 'A-Z' 'a-z' | cut -c1-40)_wf_$STAMP"
DATABASE_URL="$BASE_URL" bun "$SKILL/scratch-db.ts" create "$DB_NAME" >/dev/null
echo "$DB_NAME" > "$WF_DIR/database"

wait_for_line() { # log, line, pidfile
  for _ in $(seq 1 100); do
    grep -q "$2" "$1" 2>/dev/null && kill -0 "$(cat "$3")" 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}

if [ "$MODE" = "faux" ]; then
  SLUG="verify-workflow/run-$STAMP"
  LABEL="factory"
  FORGE="$WF_DIR/forge"
  # Never a real token: the fakes are the only things it is sent to.
  TOKEN="verify-workflow-fake-$STAMP$$"
  LINEAR_SECRET="verify-workflow-linear-$STAMP$$"
  mkdir -p "$FORGE/verify-workflow"
  printf '%s\n' "$TOKEN" > "$WF_DIR/forge-token"
  printf '%s\n' "$LINEAR_SECRET" > "$WF_DIR/linear-secret"

  ( exec env GIT_FORGE_PORT="$GIT_PORT" GIT_FORGE_ROOT="$FORGE" GIT_FORGE_TOKEN="$TOKEN" \
      GIT_FORGE_LEDGER="$WF_DIR/git-ledger.json" bun "$ROOT/.pi/skills/verify-api/git-forge-fake.ts" ) \
    > "$WF_DIR/git.log" 2>&1 &
  echo $! > "$WF_DIR/git.pid"
  ( exec env LINEAR_FAKE_PORT="$LINEAR_PORT" LINEAR_FAKE_LEDGER="$WF_DIR/linear-ledger.json" \
      bun "$ROOT/.pi/skills/verify-api/linear-api-fake.ts" ) > "$WF_DIR/linear.log" 2>&1 &
  echo $! > "$WF_DIR/linear.pid"
  if ! wait_for_line "$WF_DIR/git.log" "git-forge-fake listening" "$WF_DIR/git.pid"; then
    echo "the git forge fake did not start on $GIT_PORT — see $WF_DIR/git.log" >&2
    exit 1
  fi
  for _ in $(seq 1 100); do
    [ -s "$WF_DIR/linear-ledger.json" ] && curl -s -m 1 -o /dev/null "http://127.0.0.1:$LINEAR_PORT/" && break
    sleep 0.1
  done
  if ! kill -0 "$(cat "$WF_DIR/linear.pid")" 2>/dev/null; then
    echo "the Linear fake did not start on $LINEAR_PORT — see $WF_DIR/linear.log" >&2
    exit 1
  fi

else
  SLUG="$WORKFLOW_GITHUB_REPO"
  LABEL="${WORKFLOW_LINEAR_LABEL:-factory}"
fi

# Recorded before anything is launched with it: `instance-env.sh` rebuilds the API's environment from
# this file, for this launch and for `restart-api.sh`'s.
cat > "$WF_DIR/instance.json" <<JSON
{
  "mode": "$MODE",
  "apiUrl": "http://localhost:$API_PORT",
  "webUrl": "http://localhost:$WEB_PORT",
  "apiPort": $API_PORT,
  "webPort": $WEB_PORT,
  "githubPort": $GITHUB_PORT,
  "linearPort": $LINEAR_PORT,
  "gitPort": $GIT_PORT,
  "database": "$DB_NAME",
  "repo": "$SLUG",
  "label": "$LABEL",
  "approvalRequired": "$([ "$MODE" = live ] && echo "${WORKFLOW_APPROVAL_REQUIRED:-git commit}" || echo "git commit")",
  "stamp": "$STAMP"
}
JSON
WORKFLOW_BASE_URL="$BASE_URL"
# shellcheck source=instance-env.sh
source "$SKILL/instance-env.sh"
workflow_export_env

if ! "$BOARD/up.sh"; then
  echo "verify-board's up.sh failed — see $RUN_DIR/api.log" >&2
  exit 1
fi

# The forge's copy of the fixture, with its history: the checkout and the forge share `main`, so the
# reviewer's `git diff main...HEAD` in a worktree reads the run's change and nothing else.
if [ "$MODE" = "faux" ]; then
  git clone -q --bare "$RUN_DIR/board-repo" "$FORGE/$SLUG.git"
  git --git-dir "$FORGE/$SLUG.git" config http.receivepack true
fi

BOARD_ID="$(sed -n 's/.*"boardId":"\([^"]*\)".*/\1/p' "$RUN_DIR/board.json")"
echo "workflow ($MODE)  database $DB_NAME  repo $SLUG  label $LABEL  board $BOARD_ID"
if [ "$MODE" = "faux" ]; then
  echo "linear fake  http://127.0.0.1:$LINEAR_PORT  (pid $(cat "$WF_DIR/linear.pid"))"
  echo "git forge    http://127.0.0.1:$GIT_PORT  (pid $(cat "$WF_DIR/git.pid"))"
else
  echo "live: point Linear's webhook at $WORKFLOW_PUBLIC_URL/webhooks/linear and GitHub's at $WORKFLOW_PUBLIC_URL/webhooks/github"
fi
if [ "$MODE" = "faux" ]; then echo "next: ./drive.sh"; else echo "next: ./drive.sh --live"; fi
