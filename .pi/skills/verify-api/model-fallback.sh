#!/usr/bin/env bash
# Prove a second model provider and a role's fallback onto it (S-model-provider-breadth): a role
# configured onto an OpenAI-compatible endpoint runs a card's session end to end on it, and a forced
# 529 from a role's primary switches the run onto its fallback once — the switch a line in the
# transcript, each answer charged to the model that gave it, the session pinned to the fallback.
#
# The endpoint is the loopback fake (`openai-compatible-fake.ts`, `@repo/harness`'s fake); the
# primary is a faux model whose script answers once and then answers 529 (`FAUX_FAIL`'s
# `overloaded:1`, as a `FAUX_MODEL_SCRIPTS` row). No real provider is called and no real key is read:
# the endpoint's key is a dummy minted here, and the drive checks it reached the fake and never the log.
#
# This script owns everything it drives: a scratch database minted on DATABASE_URL's server, the fake,
# and the API, booted twice over that database (the role phase, then the fallback phase). It leaves
# nothing running and drops the database.
#
#   DATABASE_URL=… ./model-fallback.sh
#   DATABASE_URL=… FALLBACK_PORT=9540 FALLBACK_FAKE_PORT=9541 ./model-fallback.sh
#
# Env: DATABASE_URL (required — it names the *server*), FALLBACK_PORT (the API, 9448 when unset),
# FALLBACK_FAKE_PORT (the fake, 9449), EVIDENCE_DIR.
#
# What the fake cannot prove: that a given vendor's Chat Completions server streams the same way, or
# that a real provider's outage is worded as pi-ai's retry pattern expects. See
# docs/testing-third-parties.md.
#
# Evidence: .verify/evidence/latest/api/model-fallback-{role,fallback}.json (each phase's checks,
# snapshots and the fake's ledger), model-fallback-process.json (this script's checks),
# model-fallback-api.log (both boots).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${FALLBACK_PORT:-9448}"
FAKE_PORT="${FALLBACK_FAKE_PORT:-9449}"
API_URL="http://127.0.0.1:$PORT"
FAKE_URL="http://127.0.0.1:$FAKE_PORT"
RUN_DIR="$ROOT/.verify/run/model-fallback"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LOG="$RUN_DIR/api.log"
READY="$RUN_DIR/fake.ready"
FAKE_PID_FILE="$RUN_DIR/fake.pid"
STAMP="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
# A dummy, never a real key: the drive checks the fake received it and the API's log never names it.
COMPAT_KEY="dummy-compat-key-$STAMP"
FAUX_COST="0.01"
PRICE_IN="3"
PRICE_OUT="15"
COMPAT_MODELS="[{\"id\":\"compat-1\",\"cost\":{\"input\":$PRICE_IN,\"output\":$PRICE_OUT}}]"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "model-fallback.sh needs DATABASE_URL naming the Postgres server to mint its database on" >&2
  exit 1
fi
SERVER_URL="$DATABASE_URL"
SCRATCH_DB="factory_verify_fallback_$STAMP"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-60s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-60s %s\n' "$1" "$3"
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

for port in "$PORT" "$FAKE_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set FALLBACK_PORT and FALLBACK_FAKE_PORT to free ones" >&2
    exit 1
  fi
done

stop_pid() { # pidfile
  [ -f "$1" ] || return 0
  local pid; pid="$(cat "$1")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$1"
}

scratch_sql() { # statement
  bun -e '
    const sql = new Bun.SQL(process.argv[1]);
    try { await sql.unsafe(process.argv[2]); } finally { await sql.close(); }
  ' "$SERVER_URL" "$1"
}
SCRATCH_CREATED=0
drop_scratch() {
  [ "$SCRATCH_CREATED" = "1" ] || return 0
  scratch_sql "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE)" >/dev/null 2>&1 ||
    echo "model-fallback.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
}

trap 'stop_pid "$RUN_DIR/api.pid"; stop_pid "$FAKE_PID_FILE"; drop_scratch' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "model-fallback.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DATABASE_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
export DATABASE_URL
echo "model-fallback: drive database $SCRATCH_DB (dropped on exit)"

start_fake() {
  stop_pid "$FAKE_PID_FILE"
  rm -f "$READY"
  ( exec env OPENAI_COMPATIBLE_FAKE_PORT="$FAKE_PORT" OPENAI_COMPATIBLE_FAKE_READY="$READY" \
      bun "$ROOT/.pi/skills/verify-api/openai-compatible-fake.ts" ) >> "$RUN_DIR/fake.log" 2>&1 &
  echo $! > "$FAKE_PID_FILE"
  for _ in $(seq 1 60); do
    [ -s "$READY" ] && return 0
    sleep 0.1
  done
  echo "the openai-compatible fake did not start — see $RUN_DIR/fake.log" >&2
  return 1
}

start_api() { # extra env assignments…
  echo "=== boot: $(printf '%s\n' "$@" | sed 's/=.*//' | tr '\n' ' ')===" >> "$LOG"
  rm -rf "$RUN_DIR/sessions"
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$PORT" \
      HOST="127.0.0.1" \
      MODEL_BACKEND=faux \
      FAUX_COST="$FAUX_COST" \
      OPENAI_COMPATIBLE_BASE_URL="$FAKE_URL/v1" \
      OPENAI_COMPATIBLE_MODELS="$COMPAT_MODELS" \
      OPENAI_COMPATIBLE_API_KEY="$COMPAT_KEY" \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      DATABASE_URL="$DATABASE_URL" \
      "$@" \
      bun run src/index.ts ) >> "$LOG" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
  for _ in $(seq 1 60); do
    curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "api did not become ready — see $LOG" >&2
  return 1
}

drive() { # phase
  API_URL="$API_URL" FAKE_URL="$FAKE_URL" EVIDENCE_DIR="$EVIDENCE_DIR" PHASE="$1" \
    COMPAT_KEY="$COMPAT_KEY" FAUX_COST="$FAUX_COST" COMPAT_PRICE_IN="$PRICE_IN" \
    COMPAT_PRICE_OUT="$PRICE_OUT" \
    bun "$ROOT/.pi/skills/verify-api/model-fallback.ts" > "$RUN_DIR/driver-$1.log" 2>&1
  local rc=$?
  cat "$RUN_DIR/driver-$1.log"
  check "the $1 phase passes its checks" "$([ "$rc" = "0" ] && echo 0 || echo 1)" "exit=$rc"
}

: > "$LOG"
: > "$RUN_DIR/fake.log"

# --- 1. a role on the second provider ------------------------------------------------------------
start_fake || exit 1
start_api ROLE_MODELS="specifier=openai-compatible/compat-1" || exit 1
check "the boot names the second provider and the variable its key comes from" \
  "$(grep -q "second provider: openai-compatible at $FAKE_URL/v1 serving compat-1 (OPENAI_COMPATIBLE_BASE_URL; auth: OPENAI_COMPATIBLE_API_KEY)" "$LOG" && echo 0 || echo 1)" \
  "boot line"
drive role
stop_pid "$RUN_DIR/api.pid"

# --- 2. a forced 529 from the primary, and the role's fallback -----------------------------------
start_fake || exit 1
start_api ROLE_MODELS="specifier=faux/primary" \
  ROLE_FALLBACKS="specifier=openai-compatible/compat-1" \
  FAUX_MODEL_SCRIPTS='{"primary":{"fail":"overloaded:1"}}' || exit 1
check "the boot names the specifier's fallback chain" \
  "$(grep -q "role fallbacks: specifier → openai-compatible/compat-1 (ROLE_FALLBACKS" "$LOG" && echo 0 || echo 1)" \
  "boot line"
drive fallback
check "the API logged the switch, naming both models" \
  "$(grep -q "model switch: faux/primary is unavailable .* go to openai-compatible/compat-1" "$LOG" && echo 0 || echo 1)" \
  "warning line"
stop_pid "$RUN_DIR/api.pid"

check "the endpoint's key is in no line the API logged" \
  "$(grep -q "$COMPAT_KEY" "$LOG" && echo 1 || echo 0)" \
  "grep for the dummy key"

cp "$LOG" "$EVIDENCE_DIR/model-fallback-api.log"
{
  printf '{\n  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/model-fallback-process.json"

if [ "$failed" -ne 0 ]; then
  echo "model-fallback: FAILED — see $EVIDENCE_DIR" >&2
  exit 1
fi
echo "model-fallback: all checks passed — evidence in $EVIDENCE_DIR"
