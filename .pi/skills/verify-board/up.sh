#!/usr/bin/env bash
# Launch an isolated API and dashboard for the board drive, then seed one board.
#
# `factory board` is a client, so the skill starts its own control plane: its own port (9400 by
# default), its own session root under .verify/run, and a pid in .verify/run/api.pid so ./down.sh
# stops exactly this one. The dashboard runs beside it on WEB_PORT (3400 by default, pid in
# .verify/run/web.pid): the drive's last phase reads the board back in a browser (LOB-84).
#
# MODEL_BACKEND=faux keeps `board start` offline: opening a run is real (a session, a worktree, a
# `factory.task` document), only the model behind it is scripted.
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
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9400}"
WEB_PORT="${WEB_PORT:-3400}"
RUN_DIR="$ROOT/.verify/run"
FAUX_COMMAND="sleep 8; echo faux-ok"
FAUX_ASK="${FAUX_ASK:-Which Postgres major does this card target?}"
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
for port in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already held: $(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" pid "$2}') — pick another API_PORT/WEB_PORT" >&2
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

( cd "$ROOT/apps/api" && exec env \
    PORT="$API_PORT" \
    HOST="127.0.0.1" \
    ALLOWED_ORIGINS="http://localhost:$API_PORT,http://localhost:$WEB_PORT" \
    MODEL_BACKEND="${MODEL_BACKEND:-faux}" \
    FAUX_COMMAND="$FAUX_COMMAND" \
    FAUX_ASK="$FAUX_ASK" \
    FAUX_SPEC="$FAUX_SPEC" \
    SESSION_ROOT="$SESSION_ROOT" \
    bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"
echo "$WEB_PORT" > "$RUN_DIR/web-port"
printf '%s\n' "$FAUX_ASK" > "$RUN_DIR/faux-ask"
printf '%s\n' "$FAUX_SPEC_ACCEPTED" > "$RUN_DIR/faux-spec"

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

# One board, through the service rather than SQL string-building. The drive creates its own card
# through the API (create.ts), so the seed makes none.
if ! SEED_CARD=0 bun run "$ROOT/.pi/skills/verify-board/seed.ts" > "$RUN_DIR/board.json"; then
  echo "seed failed — see $RUN_DIR/board.json" >&2
  exit 1
fi

echo "api  http://localhost:$API_PORT  (pid $(cat "$RUN_DIR/api.pid"))"
echo "web  http://localhost:$WEB_PORT  (pid $(cat "$RUN_DIR/web.pid"))"
echo "board $(cat "$RUN_DIR/board.json")"
