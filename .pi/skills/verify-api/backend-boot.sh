#!/usr/bin/env bash
# Prove the model backend is chosen by what pi-ai can authenticate with, and that a wrong choice
# fails the boot (LOB-258).
#
#   DATABASE_URL=postgres://…/factory_<slug> ./backend-boot.sh   # api on :9426 (BACKEND_BOOT_PORT)
#
# DATABASE_URL is required, so a run never migrates the shared default database (each boot runs the
# migrations against it): point it at this worktree's own database.
#
# Five boots, one after another, each on the same port and each stopped before the next:
#   1. MODEL_BACKEND=faux          → ready, and the log says faux was selected by MODEL_BACKEND.
#   2. MODEL_BACKEND=anthropic, the only key whitespace → the process exits non-zero before it
#      binds, with AnthropicCredentialMissing listing every accepted variable.
#   2b. MODEL_BACKEND=anthropic, federation naming a token file that does not exist → exits non-zero
#      before it binds, with AnthropicIdentityTokenFileMissing naming the path.
#   3. a dummy ANTHROPIC_OAUTH_TOKEN alone → ready on anthropic, the log names the variable and never
#      its value.
#   4. the same through turbo (`turbo run dev --filter=@repo/api`, Strict Mode) with a dummy
#      ANTHROPIC_AUTH_TOKEN: the variable reaches the API only if apps/api/turbo.json passes it
#      through. Skipped when a repo-root .env exists, because `bun run dev` loads it and a real
#      credential in it would decide the boot instead (the file is never read here).
#
# Every boot starts from an empty environment (`env -i`) plus what the case names, and the direct
# boots run `bun --no-env-file`, so no shell variable or .env file lends a credential. Every
# credential is a dummy, and a boot sends no model request, so nothing reaches Anthropic.
#
# Evidence: .verify/evidence/latest/api/backend-boot.json and backend-boot-<case>.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${BACKEND_BOOT_PORT:-9426}"
RUN_DIR="$ROOT/.verify/run/backend-boot"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "backend-boot.sh needs DATABASE_URL naming this worktree's own database (never the shared default)" >&2
  exit 1
fi

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is taken; set BACKEND_BOOT_PORT" >&2
  exit 1
fi

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-58s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-58s %s\n' "$1" "$3"
  fi
}

# Whether `$2` occurs in file `$1` (0 = yes), for `check`.
has() { grep -qF -- "$2" "$1"; echo $?; }
lacks() { grep -qF -- "$2" "$1" && echo 1 || echo 0; }

PID=""
stop() {
  [ -n "$PID" ] || return 0
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  PID=""
  # turbo's child can outlive turbo by a moment; the next boot needs the port.
  for _ in $(seq 1 50); do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.1
  done
}
trap stop EXIT

# Start one boot in the background: log file, then `KEY=value` pairs, then the command.
start() {
  local log="$1"; shift
  local vars=()
  while [ $# -gt 0 ] && [[ "$1" == *=* ]]; do vars+=("$1"); shift; done
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    DATABASE_URL="$DATABASE_URL" \
    PORT="$PORT" \
    HOST="127.0.0.1" \
    ALLOWED_ORIGINS="http://localhost:$PORT" \
    SESSION_ROOT="$RUN_DIR/sessions" \
    "${vars[@]}" \
    "$@" > "$log" 2>&1 &
  PID=$!
}

# 0 once /readyz answers 200 within 30s, 1 otherwise.
ready() {
  for _ in $(seq 1 60); do
    curl -sf -m 1 "http://localhost:$PORT/readyz" >/dev/null 2>&1 && { echo 0; return; }
    kill -0 "$PID" 2>/dev/null || { echo 1; return; }
    sleep 0.5
  done
  echo 1
}

API=(bun --no-env-file "$ROOT/apps/api/src/index.ts")
ACCEPTED=(ANTHROPIC_AUTH_TOKEN ANTHROPIC_OAUTH_TOKEN ANTHROPIC_API_KEY
  ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID ANTHROPIC_IDENTITY_TOKEN_FILE)

# 1. MODEL_BACKEND=faux.
LOG="$EVIDENCE_DIR/backend-boot-faux.log"
start "$LOG" MODEL_BACKEND=faux ANTHROPIC_API_KEY=dummy-key-faux-must-ignore "${API[@]}"
check "faux: ready" "$(ready)" "/readyz 200 on :$PORT"
check "faux: selected by MODEL_BACKEND" "$(has "$LOG" "model backend: faux (selected by MODEL_BACKEND)")" "the boot line"
check "faux: the key's value is not logged" "$(lacks "$LOG" "dummy-key-faux-must-ignore")" "no line carries it"
stop

# Wait up to 20s for the boot to exit on its own; sets `code` (empty when it did not).
exited() {
  code=""
  for _ in $(seq 1 100); do
    if ! kill -0 "$PID" 2>/dev/null; then
      wait "$PID"; code=$?; PID=""; break
    fi
    sleep 0.2
  done
}

# 2. MODEL_BACKEND=anthropic with nothing that resolves.
LOG="$EVIDENCE_DIR/backend-boot-forced-missing.log"
start "$LOG" MODEL_BACKEND=anthropic "ANTHROPIC_API_KEY=   " "${API[@]}"
exited
check "forced anthropic, no credential: exits" "$([ -n "$code" ] && echo 0 || echo 1)" "exit ${code:-none within 20s}"
check "forced anthropic, no credential: non-zero" "$([ -n "$code" ] && [ "$code" -ne 0 ] && echo 0 || echo 1)" "exit ${code:-none}"
check "forced anthropic, no credential: typed error" "$(has "$LOG" "AnthropicCredentialMissing")" "AnthropicCredentialMissing in the log"
missing=""
for name in "${ACCEPTED[@]}"; do grep -qF "$name" "$LOG" || missing="$missing $name"; done
check "forced anthropic, no credential: lists accepted variables" "$([ -z "$missing" ] && echo 0 || echo 1)" "${missing:-all ${#ACCEPTED[@]} named}"
check "forced anthropic, no credential: never listened" "$(lacks "$LOG" "Listening on")" "no Listening line"
stop

# 2b. MODEL_BACKEND=anthropic, federation whose identity token file does not exist.
LOG="$EVIDENCE_DIR/backend-boot-forced-federation-no-file.log"
NO_FILE="$RUN_DIR/no-such-identity-token"
rm -f "$NO_FILE"
start "$LOG" MODEL_BACKEND=anthropic ANTHROPIC_FEDERATION_RULE_ID=dummy-rule \
  ANTHROPIC_ORGANIZATION_ID=dummy-org "ANTHROPIC_IDENTITY_TOKEN_FILE=$NO_FILE" "${API[@]}"
exited
check "forced federation, no token file: non-zero exit" "$([ -n "$code" ] && [ "$code" -ne 0 ] && echo 0 || echo 1)" "exit ${code:-none within 20s}"
check "forced federation, no token file: typed error" "$(has "$LOG" "AnthropicIdentityTokenFileMissing")" "AnthropicIdentityTokenFileMissing in the log"
check "forced federation, no token file: names the path" "$(has "$LOG" "$NO_FILE")" "the path in the error"
check "forced federation, no token file: never listened" "$(lacks "$LOG" "Listening on")" "no Listening line"
stop

# 3. A dummy ANTHROPIC_OAUTH_TOKEN alone.
LOG="$EVIDENCE_DIR/backend-boot-oauth-token.log"
start "$LOG" ANTHROPIC_OAUTH_TOKEN=dummy-oauth-token-0123456789 "${API[@]}"
check "oauth token: ready" "$(ready)" "/readyz 200 on :$PORT"
check "oauth token: anthropic, auth named" "$(has "$LOG" "model backend: anthropic (auth: ANTHROPIC_OAUTH_TOKEN)")" "the boot line"
check "oauth token: the value is not logged" "$(lacks "$LOG" "dummy-oauth-token-0123456789")" "no line carries it"
stop

# 4. Through turbo (Strict Mode): the variable must be passed through by apps/api/turbo.json.
LOG="$EVIDENCE_DIR/backend-boot-turbo.log"
if [ -f "$ROOT/.env" ]; then
  : > "$LOG"
  echo "SKIP  turbo: a repo-root .env exists and bun run dev would load it"
  rows+=("\"turbo: auth token passed through\": {\"passed\": null, \"detail\": \"skipped: a repo-root .env exists\"}")
else
  # turbo resolves the workspace from its working directory; `$!` is turbo itself, which forwards
  # the SIGTERM `stop` sends to the API it spawned.
  cd "$ROOT" || exit 1
  start "$LOG" ANTHROPIC_AUTH_TOKEN=dummy-auth-token-0123456789 \
    DO_NOT_TRACK=1 TURBO_TELEMETRY_DISABLED=1 TURBO_NO_UPDATE_NOTIFIER=1 \
    "$ROOT/node_modules/.bin/turbo" run dev --filter=@repo/api --ui=stream
  check "turbo: ready" "$(ready)" "/readyz 200 on :$PORT"
  check "turbo: auth token passed through" "$(has "$LOG" "model backend: anthropic (auth: ANTHROPIC_AUTH_TOKEN)")" "the boot line"
  check "turbo: the value is not logged" "$(lacks "$LOG" "dummy-auth-token-0123456789")" "no line carries it"
  stop
fi

{
  printf '{\n  "skill": "verify-api",\n  "script": "backend-boot.sh",\n  "port": %s,\n  "checks": {\n' "$PORT"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/backend-boot.json"

echo "evidence: $EVIDENCE_DIR/backend-boot.json"
exit "$failed"
