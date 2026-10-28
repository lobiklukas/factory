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
# The PR goes to a loopback GitHub fake (`.pi/skills/verify-api/github-fake.ts`, LOB-179) on
# GITHUB_PORT (9403 by default), its ledger on disk in .verify/run/github-ledger.json — the oracle
# the drive reads the PR's link and body back from. The API gets `GITHUB_API_URL` pointing at it and
# a `GITHUB_TOKEN` the fake never reads. `BOARD_GITHUB=off` starts no fake and hands the API no
# credential (and a closed loopback port as its forge, so nothing can reach a real one): the "PR
# path is missing" case, under which `drive.sh` must fail naming the reason, not invent a link.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
WEB_PORT="${WEB_PORT:-3400}"
RUN_DIR="$ROOT/.verify/run"
GITHUB_PORT="${GITHUB_PORT:-9403}"
BOARD_GITHUB="${BOARD_GITHUB:-fake}"
FAUX_COMMAND="sleep 8; echo faux-ok"
FAUX_ASK="${FAUX_ASK:-Which Postgres major does this card target?}"
# The builder's change: one file in the web surface, committed on the run's own branch, so the
# branch differs from `main` and the fixture's verify-web skill is the one `verify` runs.
BUILD_CHANGE="mkdir -p apps/web/src && echo 'export const card = 1;' > apps/web/src/card.ts && git add apps/web/src/card.ts && git -c user.email=builder@localhost -c user.name=builder commit -q -m 'build the card' && echo built"
ROLE_MODELS="builder=faux/builder,reviewer=faux/reviewer"
FAUX_MODEL_SCRIPTS="$(BUILD_CHANGE="$BUILD_CHANGE" bun -e 'console.log(JSON.stringify({ builder: { command: process.env.BUILD_CHANGE, verify: true }, reviewer: { command: "git diff --stat main...HEAD" } }))')"
FAUX_REVIEW='[{"summary":"Adds the card export.","dimensions":{"correctness":{"verdict":"pass","findings":[]},"security":{"verdict":"pass","findings":[]},"tests":{"verdict":"pass","findings":[]},"performance":{"verdict":"pass","findings":[]}}}]'
WEBHOOK_SECRET="verify-board-webhook-$(date +%s)$$"
SPEC_GOAL='"goal":"Pin the Postgres major this card targets"'
SPEC_ACCEPTANCE='"acceptance":["docker-compose.yml names one Postgres major","the README says which"]'
SPEC_QUESTIONS='"openQuestions":["Which Postgres major does this card target?"]'
FAUX_SPEC_ACCEPTED="{$SPEC_GOAL,$SPEC_ACCEPTANCE,\"gaps\":[\"the card does not say which Postgres major it targets\"],$SPEC_QUESTIONS}"
FAUX_SPEC="[{$SPEC_GOAL,$SPEC_ACCEPTANCE,$SPEC_QUESTIONS},$FAUX_SPEC_ACCEPTED]"
DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory_ralph}"
export DATABASE_URL

mkdir -p "$RUN_DIR"

if [ -f "$RUN_DIR/api.pid" ] && kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null; then
  echo "already running (api pid $(cat "$RUN_DIR/api.pid")); run ./down.sh first" >&2
  exit 1
fi

# Both ports must be free before anything starts: Vite runs with strictPort, so on a held WEB_PORT
# ours exits while the holder keeps answering 200, and the readiness loop below would call a
# stranger's dashboard ready.
case "$BOARD_GITHUB" in
  fake | off) ;;
  *) echo "BOARD_GITHUB must be fake or off, not $BOARD_GITHUB" >&2; exit 1 ;;
esac
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
SESSION_ROOT="$RUN_DIR/sessions"
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

# The forge: the loopback fake, or — with BOARD_GITHUB=off — nothing at all.
LEDGER="$RUN_DIR/github-ledger.json"
rm -f "$LEDGER"
if [ "$BOARD_GITHUB" = "fake" ]; then
  ( exec env GITHUB_FAKE_PORT="$GITHUB_PORT" GITHUB_FAKE_LEDGER="$LEDGER" \
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
  GITHUB_ENV=(GITHUB_API_URL="http://127.0.0.1:$GITHUB_PORT" GITHUB_TOKEN="verify-board-fake-token")
else
  # Port 9 (discard) on loopback: nothing listens, so even a step that got past the missing
  # credential could not reach a real forge.
  GITHUB_ENV=(GITHUB_API_URL="http://127.0.0.1:9")
fi
echo "$BOARD_GITHUB" > "$RUN_DIR/github-mode"

# `env -u` for every GitHub credential the shell may carry: the instance's forge is the one chosen
# above, never one a developer's environment selects (the App flow, or a real token).
( cd "$ROOT/apps/api" && exec env \
    -u GITHUB_TOKEN -u GITHUB_APP_ID -u GITHUB_APP_PRIVATE_KEY -u GITHUB_APP_INSTALLATION_ID \
    -u GITHUB_REVIEWER_TOKEN -u GITHUB_REVIEWER_APP_ID -u GITHUB_REVIEWER_APP_PRIVATE_KEY \
    -u GITHUB_REVIEWER_APP_INSTALLATION_ID \
    PORT="$API_PORT" \
    HOST="127.0.0.1" \
    ALLOWED_ORIGINS="http://localhost:$API_PORT,http://localhost:$WEB_PORT" \
    MODEL_BACKEND=faux \
    FAUX_COMMAND="$FAUX_COMMAND" \
    FAUX_ASK="$FAUX_ASK" \
    ROLE_MODELS="$ROLE_MODELS" \
    FAUX_MODEL_SCRIPTS="$FAUX_MODEL_SCRIPTS" \
    "${GITHUB_ENV[@]}" \
    FAUX_SPEC="$FAUX_SPEC" \
    FAUX_REVIEW="$FAUX_REVIEW" \
    GITHUB_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
    SESSION_ROOT="$SESSION_ROOT" \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"
echo "$WEB_PORT" > "$RUN_DIR/web-port"
printf '%s\n' "$FAUX_ASK" > "$RUN_DIR/faux-ask"
printf '%s\n' "$FAUX_SPEC_ACCEPTED" > "$RUN_DIR/faux-spec"
printf '%s\n' "$WEBHOOK_SECRET" > "$RUN_DIR/webhook-secret"

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
# the fixture checkout. The drive creates its own card through the API (create.ts), so the seed
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
else
  echo "github  off (BOARD_GITHUB=off): no forge, no credential — the drive's PR phase must fail"
fi
echo "board $(cat "$RUN_DIR/board.json")"
