#!/usr/bin/env bash
# Launch an isolated API instance to drive the session RPC surface against.
#
# Isolation: its own port, its own session working directories under .verify/run,
# and pids recorded in .verify/run/api.pid so ./down.sh can stop exactly this one.
#
# MODEL_BACKEND=faux keeps verification offline and deterministic (pi-ai's scripted
# provider): no API key, no cost, same transcript every run. SESSION_IDLE_TIMEOUT_MS is
# short on purpose so a drive run can reach the historical-fold read path without
# waiting the 15 minutes a real deployment uses — see features/session-fold.md.
#
# API_VIA_TURBO=1 starts the API the way `bun run dev` does — `turbo run dev --filter=@repo/api`
# in Strict Mode — instead of `bun run src/index.ts` directly, so a variable `apps/api/turbo.json`
# does not declare is stripped before the API sees it (LOB-257). Every other drive is unchanged.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
RUN_DIR="${VERIFY_RUN_DIR:-$ROOT/.verify/run}"

mkdir -p "$RUN_DIR"

if [ -f "$RUN_DIR/api.pid" ] && kill -0 "$(cat "$RUN_DIR/api.pid")" 2>/dev/null; then
  echo "already running (api pid $(cat "$RUN_DIR/api.pid")); run ./down.sh first" >&2
  exit 1
fi

# Postgres is the session log; without it nothing here is worth driving. The shared check asks the
# port before it asks compose, so this works from a ralph worktree where compose would derive its
# own project name and fight the human's container for 5442 (LOB-57).
source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# The session root is a throwaway git repo whose `origin` is a local bare repository, so a
# scripted git command can never reach a real remote (LOB-94).
SESSION_ROOT="$RUN_DIR/sessions"
ORIGIN_DIR="$RUN_DIR/origin.git"
if [ ! -d "$SESSION_ROOT/.git" ]; then
  rm -rf "$SESSION_ROOT" "$ORIGIN_DIR"
  mkdir -p "$SESSION_ROOT"
  git init -q -b main "$SESSION_ROOT"
  git -C "$SESSION_ROOT" config user.email verify-api@localhost
  git -C "$SESSION_ROOT" config user.name "verify-api"
  git -C "$SESSION_ROOT" commit -q --allow-empty -m "verify-api session root"
  git init -q -b main --bare "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" remote add origin "$ORIGIN_DIR"
  git -C "$SESSION_ROOT" push -q origin main
fi

# A second faux model for drive.ts's replay check (LOB-215): a replay onto `faux/faux-2` is a
# different model with no key. The role table is the one lever a deployment has to publish a faux
# model beside `faux/faux-1` (apps/api's ROLE_MODELS: every `faux/<id>` it names is served), and
# `replay-target` is a role no session on this instance runs, so the row changes the catalog and
# nothing else. `REPLAY_MODEL` is the same knob drive.ts reads, so an override reaches both, and the
# row is appended to any `ROLE_MODELS` the caller set rather than replacing it.
# Only on the faux backend: a real backend's catalog does not serve `faux/faux-2`, and a role naming a
# model the process does not serve refuses the boot (LOB-242's live review-eval boots on anthropic).
REPLAY_MODEL="${REPLAY_MODEL:-faux/faux-2}"
if [ "${MODEL_BACKEND:-faux}" = "faux" ]; then
  ROLE_MODELS="${ROLE_MODELS:+$ROLE_MODELS,}replay-target=$REPLAY_MODEL"
fi
ROLE_MODELS="${ROLE_MODELS:-}"

if [ "${API_VIA_TURBO:-}" = "1" ]; then
  # The turbo binary itself, not `bun run dev`, so `$!` is the process `down.sh` signals and turbo
  # forwards the SIGTERM to the API it spawned. `--ui=stream` because the repo's `tui` needs a tty.
  LAUNCH_DIR="$ROOT"
  LAUNCH=("$ROOT/node_modules/.bin/turbo" run dev --filter=@repo/api --ui=stream)
  export DO_NOT_TRACK=1 TURBO_TELEMETRY_DISABLED=1 TURBO_NO_UPDATE_NOTIFIER=1
else
  LAUNCH_DIR="$ROOT/apps/api"
  LAUNCH=(bun run src/index.ts)
fi

( cd "$LAUNCH_DIR" && exec env \
    PORT="$API_PORT" \
    HOST="127.0.0.1" \
    ALLOWED_ORIGINS="http://localhost:$API_PORT" \
    MODEL_BACKEND="${MODEL_BACKEND:-faux}" \
    ROLE_MODELS="$ROLE_MODELS" \
    SESSION_ROOT="$SESSION_ROOT" \
    SESSION_IDLE_TIMEOUT_MS="${SESSION_IDLE_TIMEOUT_MS:-2000}" \
    MAX_REQUEST_BODY_BYTES="${MAX_REQUEST_BODY_BYTES:-1048576}" \
    "${LAUNCH[@]}" ) > "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"

# Ready means `/readyz` says so, not merely that the port answers: the server binds before its
# migrations are applied (LOB-21), so `GET /` is true a moment before a session can be created. The
# body cap is explicit (the default is the same 1 MiB) so drive.ts's 413 check is tied to a value
# this script sets rather than to a default that could drift.
ready=0
for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

if [ "$ready" -ne 1 ]; then
  echo "api did not become ready in 30s — see $RUN_DIR/api.log" >&2
  exit 1
fi

echo "api  http://localhost:$API_PORT  (pid $(cat "$RUN_DIR/api.pid"))"
echo "model backend: ${MODEL_BACKEND:-faux}"
if [ "${API_VIA_TURBO:-}" = "1" ]; then echo "started through turbo (Strict Mode)"; fi
