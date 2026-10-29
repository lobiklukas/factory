#!/usr/bin/env bash
# Launch an isolated API and dashboard for the board drive, then seed one board.
#
# `factory board` is a client, so the skill starts its own control plane: its own port (9400 by
# default), its own session root under .verify/run, and a pid in .verify/run/api.pid so ./down.sh
# stops exactly this one. The dashboard runs beside it on WEB_PORT (3400 by default, pid in
# .verify/run/web.pid): the drive's last phase reads the board back in a browser (LOB-84).
#
# MODEL_BACKEND=faux keeps `board start` offline: opening a run is real (a session, a worktree, a
# `factory.task` document), only the model behind it is scripted. It is pinned, as ask.sh and
# requires.sh pin it, not taken from the caller: every phase of the drive depends on a scripted
# model, and ROLE_MODELS below names `faux/builder`, which no other backend serves — the API would
# refuse to boot on InvalidRoleModels.
#
# The script is the one the drive's specify phase needs (LOB-85): FAUX_COMMAND sleeps, so a run is
# provably busy before it asks, as sigterm.sh and ask.sh hold a turn open; FAUX_ASK is the question
# the run asks with the `ask` tool when its prompt carries no task thread yet. A run on a card that
# has been answered does not ask again, so later phases on the same card take ordinary turns. The
# question is recorded in .verify/run/faux-ask, which drive.sh matches the card's thread against.
#
# FAUX_SPEC is the specifier's `spec` calls (LOB-238): a run offered the tool — one in `specifying`,
# whose column declares the `specifier` role — first sends a spec without `gaps`, which the tool
# refuses naming the field, then retries with them; a run whose prompt carries the answered thread
# declares the same spec with its gaps closed. The accepted attempt is recorded in
# .verify/run/faux-spec, which drive.sh matches the run's log and the card against. Fixed, like
# FAUX_COMMAND, for the same reason: the drive's checks are about these exact values.
#
# FAUX_COMMAND is fixed, not taken from the caller's environment: the drive's probes depend on what
# it does (it must hold the turn open, and print `faux-ok`), so a value left exported by another
# skill must not silently change the instance. The sleep is 8 s, not ask.sh's 4 s, because the busy
# probe here starts after `board start` returns, a tmux round-trip and a cold `bun` start — about
# 1 s on an idle machine, and more under a parallel gate.
#
# The build phase (LOB-86) needs a second kind of run on the same instance: one in `building` that
# writes a change, commits it and verifies it. Under faux a model *is* its script, so the builder
# role runs its own model (`ROLE_MODELS=builder=faux/builder`, LOB-207) whose script is
# `FAUX_MODEL_SCRIPTS`'s `builder` row; every other run keeps FAUX_COMMAND. Both are fixed for the
# reason FAUX_COMMAND is. The card's repository is registered over a fixture checkout
# (.verify/run/board-repo) carrying a passing `verify-web` skill, so a run is a git worktree of it
# with a branch the PR step can measure and publish.
#
# The review phase (LOB-241) needs a third: the reviewer the review trigger opens on the card when
# GitHub tells the API about the build run's PR (`POST /webhooks/github`, LOB-36). The drive signs
# that delivery itself with GITHUB_WEBHOOK_SECRET — a fresh value per instance, recorded in
# .verify/run/webhook-secret for drive.sh — since the loopback fake sends no webhooks.
# `ROLE_MODELS`' `reviewer=faux/reviewer` row is the reviewer's model, whose `FAUX_MODEL_SCRIPTS` row
# reads the diff, and FAUX_REVIEW is its `review` call: a clean pass, which is recorded `clean` and
# posted nowhere (the instance has no reviewer identity, and a clean review posts nothing anyway).
# Only a review run is offered the `review` tool, so no other run makes that call. All fixed, like
# FAUX_COMMAND.
#
# The planning phase (D10) needs a fourth: `ROLE_MODELS`' `planner=faux/planner` row is the planner's
# model, and its `FAUX_MODEL_SCRIPTS` row reads the checkout (`ls`, a read the read-only planning
# stage lets through) and then calls the `plan` tool — first without `risks`, which the tool refuses
# naming the field, then the whole plan. Only a run whose role writes the plan (the `planner`) is
# offered the tool. The accepted plan is recorded in .verify/run/faux-plan, which drive.sh matches
# `factory board show` and the card pane against. Fixed, like FAUX_COMMAND.
#
# FAUX_COST, when the caller sets it, prices every faux answer (a cent a request is the usual): the
# one thing `budget.sh` needs from this instance, a spend a cap can be reached by. Unset, the
# instance's model reports no cost, as it always did.
#
# The PR goes to a loopback GitHub fake (`.pi/skills/verify-api/github-fake.ts`, LOB-179) on
# GITHUB_PORT (9403 by default), its ledger on disk in .verify/run/github-ledger.json — the oracle
# the drive reads the PR's link and body back from. The API gets `GITHUB_API_URL` pointing at it and
# a `GITHUB_TOKEN` the fake never reads. `BOARD_GITHUB=off` starts no fake and hands the API no
# credential (and a closed loopback port as its forge, so nothing can reach a real one): the "PR
# path is missing" case, under which `drive.sh` must fail naming the reason, not invent a link.
#
# verify-workflow (LOB-40) runs the whole loop on this instance rather than on a launcher of its own,
# so a few seams are open to a caller, each off by default:
#
#   ./up.sh --restart-api [KILL|TERM]   stop the recorded API with that signal (KILL by default) and
#                                       start it again with the same configuration — port, database,
#                                       session root, webhook secret, forge and model — then wait for
#                                       `/readyz`. Nothing else is touched: the dashboard, the fakes,
#                                       the fixtures and the seeded board stay as they were. The
#                                       caller's environment must be the one `up.sh` ran under.
#   BOARD_GITHUB=live                   no fake: the caller's own GITHUB_TOKEN, and GitHub itself
#   BOARD_GITHUB_TOKEN                  the fake's token (default `verify-board-fake-token`), for a
#                                       caller whose git forge accepts only its own
#   BOARD_GITHUB_GIT_ROOT               the fake's GITHUB_FAKE_GIT_ROOT: it refuses a PR whose head
#                                       that forge does not hold, and records the head's sha
#   BOARD_MODEL_BACKEND                 `faux` (the default, and every phase above) or another
#                                       backend, which drops the faux scripts and ROLE_MODELS
#   SEED_REPO_SLUG, SEED_REPO_URL       the board's repository and its forge URL (`seed.ts`)
#
# Every other variable the caller exports (TRIGGER_RULES, LINEAR_*, APPROVAL_REQUIRED, …) reaches the
# API, as it always did: the launch below clears only the GitHub credentials.
set -euo pipefail

# This suite runs its API with auth off (LOB-20): its clients send no credential, and it declares
# actors (a run's session id) that only an open control plane keeps. A token exported for the
# rest of the verify skills must not turn auth on here.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
WEB_PORT="${WEB_PORT:-3400}"
RUN_DIR="$ROOT/.verify/run"
GITHUB_PORT="${GITHUB_PORT:-9403}"
BOARD_GITHUB="${BOARD_GITHUB:-fake}"
BOARD_GITHUB_TOKEN="${BOARD_GITHUB_TOKEN:-verify-board-fake-token}"
BOARD_MODEL_BACKEND="${BOARD_MODEL_BACKEND:-faux}"
RESTART=""
if [ "${1:-}" = "--restart-api" ]; then
  RESTART="${2:-KILL}"
  case "$RESTART" in
    KILL | TERM) ;;
    *) echo "--restart-api takes KILL or TERM, not $RESTART" >&2; exit 1 ;;
  esac
fi
FAUX_COMMAND="sleep 8; echo faux-ok"
FAUX_ASK="${FAUX_ASK:-Which Postgres major does this card target?}"
# The builder's change: one file in the web surface, committed on the run's own branch, so the
# branch differs from `main` and the fixture's verify-web skill is the one `verify` runs.
BUILD_CHANGE="mkdir -p apps/web/src && echo 'export const card = 1;' > apps/web/src/card.ts && git add apps/web/src/card.ts && git -c user.email=builder@localhost -c user.name=builder commit -q -m 'build the card' && echo built"
ROLE_MODELS="builder=faux/builder,reviewer=faux/reviewer,planner=faux/planner"
# The planner's plan (D10): its first attempt leaves out `risks`, its retry is FAUX_PLAN_ACCEPTED.
FAUX_PLAN_ACCEPTED='{"summary":"Export the card from the web app","steps":["add apps/web/src/card.ts exporting the card","verify the web surface"],"surfaces":["web"],"risks":["the export is read before the board loads"]}'
FAUX_MODEL_SCRIPTS="$(BUILD_CHANGE="$BUILD_CHANGE" PLAN="$FAUX_PLAN_ACCEPTED" bun -e 'const plan = JSON.parse(process.env.PLAN); const { risks, ...withoutRisks } = plan; console.log(JSON.stringify({ builder: { command: process.env.BUILD_CHANGE, verify: true }, reviewer: { command: "git diff --stat main...HEAD" }, planner: { command: "ls", plan: [withoutRisks, plan] } }))')"
FAUX_REVIEW='[{"summary":"Adds the card export.","dimensions":{"correctness":{"verdict":"pass","findings":[]},"security":{"verdict":"pass","findings":[]},"tests":{"verdict":"pass","findings":[]},"performance":{"verdict":"pass","findings":[]}}}]'
WEBHOOK_SECRET="verify-board-webhook-$(date +%s)$$"
SPEC_GOAL='"goal":"Pin the Postgres major this card targets"'
SPEC_ACCEPTANCE='"acceptance":["docker-compose.yml names one Postgres major","the README says which"]'
SPEC_QUESTIONS='"openQuestions":["Which Postgres major does this card target?"]'
FAUX_SPEC_ACCEPTED="{$SPEC_GOAL,$SPEC_ACCEPTANCE,\"gaps\":[\"the card does not say which Postgres major it targets\"],$SPEC_QUESTIONS}"
FAUX_SPEC="[{$SPEC_GOAL,$SPEC_ACCEPTANCE,$SPEC_QUESTIONS},$FAUX_SPEC_ACCEPTED]"
DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
export DATABASE_URL
SESSION_ROOT="$RUN_DIR/sessions"

mkdir -p "$RUN_DIR"

# A restart serves the instance that is already up, so its forge, its model, its port and its
# webhook secret are the recorded ones, not whatever this shell would choose now.
if [ -n "$RESTART" ]; then
  for name in api.pid api-port github-mode model-backend; do
    if [ ! -s "$RUN_DIR/$name" ]; then
      echo "no instance to restart: $RUN_DIR/$name is missing — run ./up.sh first" >&2
      exit 1
    fi
  done
  API_PORT="$(cat "$RUN_DIR/api-port")"
  WEB_PORT="$(cat "$RUN_DIR/web-port" 2>/dev/null || echo "$WEB_PORT")"
  BOARD_GITHUB="$(cat "$RUN_DIR/github-mode")"
  BOARD_MODEL_BACKEND="$(cat "$RUN_DIR/model-backend")"
  [ "$BOARD_GITHUB" = "fake" ] && GITHUB_PORT="$(cat "$RUN_DIR/github-port")" &&
    BOARD_GITHUB_TOKEN="$(cat "$RUN_DIR/github-token")"
  [ -s "$RUN_DIR/webhook-secret" ] && WEBHOOK_SECRET="$(cat "$RUN_DIR/webhook-secret")"
elif [ -f "$RUN_DIR/api.pid" ] && kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null; then
  echo "already running (api pid $(cat "$RUN_DIR/api.pid")); run ./down.sh first" >&2
  exit 1
fi

case "$BOARD_GITHUB" in
  fake | off | live) ;;
  *) echo "BOARD_GITHUB must be fake, off or live, not $BOARD_GITHUB" >&2; exit 1 ;;
esac
# The live forge is GitHub with the caller's own token and webhook secret: never one this script
# makes up, and never a default.
if [ "$BOARD_GITHUB" = "live" ]; then
  for name in GITHUB_TOKEN GITHUB_WEBHOOK_SECRET; do
    if [ -z "${!name:-}" ]; then
      echo "BOARD_GITHUB=live needs $name exported" >&2
      exit 1
    fi
  done
  WEBHOOK_SECRET="$GITHUB_WEBHOOK_SECRET"
fi

# The model: the faux scripts every phase above is written against, or — for a caller that asks for
# another backend — that backend with nothing scripted, its credentials read from the caller's shell.
if [ "$BOARD_MODEL_BACKEND" = "faux" ]; then
  MODEL_ENV=(
    MODEL_BACKEND=faux
    FAUX_COMMAND="$FAUX_COMMAND"
    ${FAUX_COST:+FAUX_COST="$FAUX_COST"}
    FAUX_ASK="$FAUX_ASK"
    ROLE_MODELS="$ROLE_MODELS"
    FAUX_MODEL_SCRIPTS="$FAUX_MODEL_SCRIPTS"
    FAUX_SPEC="$FAUX_SPEC"
    FAUX_REVIEW="$FAUX_REVIEW"
  )
else
  MODEL_ENV=(MODEL_BACKEND="$BOARD_MODEL_BACKEND")
fi

# The forge the API is pointed at: the loopback fake, nothing at all, or GitHub itself.
case "$BOARD_GITHUB" in
  fake) GITHUB_ENV=(GITHUB_API_URL="http://127.0.0.1:$GITHUB_PORT" GITHUB_TOKEN="$BOARD_GITHUB_TOKEN") ;;
  # Port 9 (discard) on loopback: nothing listens, so even a step that got past the missing
  # credential could not reach a real forge.
  off) GITHUB_ENV=(GITHUB_API_URL="http://127.0.0.1:9") ;;
  live) GITHUB_ENV=(GITHUB_TOKEN="$GITHUB_TOKEN") ;;
esac

# `env -u` for every GitHub credential the shell may carry: the instance's forge is the one chosen
# above, never one a developer's environment selects (the App flow, or a real token). The log is
# appended to, so a restart's lines follow the first process's.
start_api() {
  ( cd "$ROOT/apps/api" && exec env \
      -u GITHUB_TOKEN -u GITHUB_APP_ID -u GITHUB_APP_PRIVATE_KEY -u GITHUB_APP_INSTALLATION_ID \
      -u GITHUB_REVIEWER_TOKEN -u GITHUB_REVIEWER_APP_ID -u GITHUB_REVIEWER_APP_PRIVATE_KEY \
      -u GITHUB_REVIEWER_APP_INSTALLATION_ID -u GITHUB_API_URL \
      PORT="$API_PORT" \
      HOST="127.0.0.1" \
      ALLOWED_ORIGINS="http://localhost:$API_PORT,http://localhost:$WEB_PORT" \
      "${MODEL_ENV[@]}" \
      "${GITHUB_ENV[@]}" \
      GITHUB_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
      SESSION_ROOT="$SESSION_ROOT" \
      bun run src/index.ts ) >> "$RUN_DIR/api.log" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
}

if [ -n "$RESTART" ]; then
  old="$(cat "$RUN_DIR/api.pid")"
  kill "-$RESTART" "$old" 2>/dev/null || true
  for _ in $(seq 1 150); do kill -0 "$old" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$old" 2>/dev/null; then
    echo "the API (pid $old) outlived SIG$RESTART for 15s" >&2
    exit 1
  fi
  start_api
  for _ in $(seq 1 60); do
    if kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null &&
       curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1; then
      echo "api  http://localhost:$API_PORT  (pid $(cat "$RUN_DIR/api.pid"), was $old, stopped with SIG$RESTART)"
      exit 0
    fi
    sleep 0.5
  done
  echo "the restarted api did not become ready in 30s — see $RUN_DIR/api.log" >&2
  exit 1
fi

# Both ports must be free before anything starts: Vite runs with strictPort, so on a held WEB_PORT
# ours exits while the holder keeps answering 200, and the readiness loop below would call a
# stranger's dashboard ready.
PORTS=("$API_PORT" "$WEB_PORT")
[ "$BOARD_GITHUB" = "fake" ] && PORTS+=("$GITHUB_PORT")
for port in "${PORTS[@]}"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already held: $(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" pid "$2}') — pick another API_PORT/WEB_PORT/GITHUB_PORT" >&2
    exit 1
  fi
done

# Postgres holds the cards themselves, so a drive without it proves nothing. The shared check asks
# the port before it asks compose (LOB-57): compose derives its project name from the directory it
# runs in, and a ralph worktree asking for 5442 a second time fights the human's container.
source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# A throwaway git repo whose `origin` is a local bare repository, so a scripted git command can
# never reach a real remote (LOB-94) — `board start` cuts a worktree here.
ORIGIN_DIR="$RUN_DIR/origin.git"
if [ ! -d "$SESSION_ROOT/.git" ]; then
  rm -rf "$SESSION_ROOT" "$ORIGIN_DIR"
  mkdir -p "$SESSION_ROOT"
  git init -q -b main "$SESSION_ROOT"
  git -C "$SESSION_ROOT" config user.email verify-board@localhost
  git -C "$SESSION_ROOT" config user.name "verify-board"
  git -C "$SESSION_ROOT" commit -q --allow-empty -m "verify-board session root"
  git init -q -b main --bare "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" remote add origin "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" push -q origin main
fi

# The fixture checkout the card's repository is registered over: `main` carries a verify-web skill
# that passes, so the build run's `verify` call has a driver to run for the surface it changed. No
# remote: nothing a run does in its worktree can reach one.
BOARD_REPO="$RUN_DIR/board-repo"
if [ ! -d "$BOARD_REPO/.git" ]; then
  rm -rf "$BOARD_REPO"
  mkdir -p "$BOARD_REPO/.pi/skills/verify-web"
  git -C "$BOARD_REPO" init -q -b main
  git -C "$BOARD_REPO" config user.email verify-board@localhost
  git -C "$BOARD_REPO" config user.name "verify-board"
  printf '# verify-board fixture\n' > "$BOARD_REPO/README.md"
  printf 'echo "verify-web fixture: 2/2 checks passed (surface=$FACTORY_VERIFY_SURFACE)"\n' \
    > "$BOARD_REPO/.pi/skills/verify-web/drive.sh"
  git -C "$BOARD_REPO" add -A
  git -C "$BOARD_REPO" commit -q -m "verify-board fixture"
fi

# The forge: the loopback fake, or — with BOARD_GITHUB=off or live — no fake at all.
LEDGER="$RUN_DIR/github-ledger.json"
rm -f "$LEDGER" "$RUN_DIR/github-port" "$RUN_DIR/github-token"
if [ "$BOARD_GITHUB" = "fake" ]; then
  ( exec env GITHUB_FAKE_PORT="$GITHUB_PORT" GITHUB_FAKE_LEDGER="$LEDGER" \
      ${BOARD_GITHUB_GIT_ROOT:+GITHUB_FAKE_GIT_ROOT="$BOARD_GITHUB_GIT_ROOT"} \
      bun "$ROOT/.pi/skills/verify-api/github-fake.ts" ) > "$RUN_DIR/github.log" 2>&1 &
  echo $! > "$RUN_DIR/github.pid"
  # The listener and a live process, not the ledger: the fake writes the empty ledger before it
  # binds, so a held port would leave a ledger and a dead fake.
  for _ in $(seq 1 60); do
    grep -q "github-fake listening" "$RUN_DIR/github.log" 2>/dev/null &&
      kill -0 "$(cat "$RUN_DIR/github.pid")" 2>/dev/null && break
    sleep 0.1
  done
  if ! grep -q "github-fake listening" "$RUN_DIR/github.log" 2>/dev/null; then
    echo "the fake GitHub did not start on $GITHUB_PORT — see $RUN_DIR/github.log" >&2
    exit 1
  fi
  # The drive merges the PR on the fake (C20, `merge.ts`), so it needs to know where the fake is;
  # a restart needs its token, which is the fake's and nobody else's.
  echo "$GITHUB_PORT" > "$RUN_DIR/github-port"
  printf '%s\n' "$BOARD_GITHUB_TOKEN" > "$RUN_DIR/github-token"
fi
echo "$BOARD_GITHUB" > "$RUN_DIR/github-mode"
echo "$BOARD_MODEL_BACKEND" > "$RUN_DIR/model-backend"
echo "$API_PORT" > "$RUN_DIR/api-port"

: > "$RUN_DIR/api.log"
start_api
echo "$WEB_PORT" > "$RUN_DIR/web-port"
printf '%s\n' "$FAUX_ASK" > "$RUN_DIR/faux-ask"
printf '%s\n' "$FAUX_SPEC_ACCEPTED" > "$RUN_DIR/faux-spec"
printf '%s\n' "$FAUX_PLAN_ACCEPTED" > "$RUN_DIR/faux-plan"
# The live secret is the caller's GitHub webhook's, so it is not written down; the drive signs
# nothing in that mode.
[ "$BOARD_GITHUB" = "live" ] || printf '%s\n' "$WEBHOOK_SECRET" > "$RUN_DIR/webhook-secret"

# The dashboard, pointed at this API. ALLOWED_ORIGINS above names its origin, or the browser's RPC
# call is blocked by CORS.
( cd "$ROOT/apps/web" && exec env \
    VITE_PORT="$WEB_PORT" \
    VITE_SERVER_URL="http://localhost:$API_PORT" \
    bun run dev ) > "$RUN_DIR/web.log" 2>&1 &
echo $! > "$RUN_DIR/web.pid"

# Ready means `/readyz` says so, not that the port answers: the server binds before its migrations
# are applied (LOB-21), so `/` is true a moment before a card can be read.
ready=0
for _ in $(seq 1 60); do
  # Our processes must still be alive: a port answering is not proof that ours is the one answering.
  if kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null &&
     kill -0 "$(cat "$RUN_DIR/web.pid")" 2>/dev/null &&
     curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1 &&
     curl -sf -m 1 "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "api or web did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
  exit 1
fi

# One board, through the service rather than SQL string-building, on the newest pipeline and over
# the fixture checkout. The drive adds its own card with `factory board add`, so the seed
# makes none.
if ! SEED_CARD=0 SEED_DEFINITION_VERSION=newest SEED_REPO_ROOT="$BOARD_REPO" \
    API_URL="http://localhost:$API_PORT" \
    bun run "$ROOT/.pi/skills/verify-board/seed.ts" > "$RUN_DIR/board.json"; then
  echo "seed failed — see $RUN_DIR/board.json" >&2
  exit 1
fi

echo "api  http://localhost:$API_PORT  (pid $(cat "$RUN_DIR/api.pid"))"
echo "web  http://localhost:$WEB_PORT  (pid $(cat "$RUN_DIR/web.pid"))"
if [ "$BOARD_GITHUB" = "fake" ]; then
  echo "github fake  http://127.0.0.1:$GITHUB_PORT  (pid $(cat "$RUN_DIR/github.pid"), ledger $LEDGER)"
elif [ "$BOARD_GITHUB" = "live" ]; then
  echo "github  live (BOARD_GITHUB=live): GitHub itself, with the caller's GITHUB_TOKEN"
else
  echo "github  off (BOARD_GITHUB=off): no forge, no credential — the drive's PR phase must fail"
fi
echo "board $(cat "$RUN_DIR/board.json")"
