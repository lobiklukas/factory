#!/usr/bin/env bash
# Drive `factory doctor` (E8) against real control planes: what a first-run operator reads when the
# machine can or cannot turn a task into a PR.
#
# The CLI is run as a subprocess and its stdout, stderr and exit code are kept: doctor is a
# non-interactive report, so there is no terminal behaviour to prove beyond its lines and its exit.
# Three API instances, all this script's own (own ports, session roots, logs and pid files), none of
# them the one ./up.sh started:
#
#   * a faux API with a checkout registered and a dummy GITHUB_TOKEN / ANTHROPIC_API_KEY set, which
#     is what makes "no credential in the output" a check that can fail;
#   * the same CLI pointed at a port nothing listens on;
#   * a faux API whose DATABASE_URL names a port nothing listens on, the degraded case of verify-api's
#     degraded.sh without stopping the shared Postgres other worktrees are using.
#
#   ./preflight.sh          # faux API :9480 (DOCTOR_PORT), degraded API :9481, dead port :9482
#
# Evidence: .verify/evidence/latest/cli/doctor-*.txt (the raw output) and doctor.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${DOCTOR_PORT:-9480}"
DEGRADED_PORT="${DOCTOR_DEGRADED_PORT:-$((PORT + 1))}"
DEAD_PORT="${DOCTOR_DEAD_PORT:-$((PORT + 2))}"
API_URL="http://localhost:$PORT"
DEGRADED_URL="http://localhost:$DEGRADED_PORT"
DEAD_URL="http://127.0.0.1:$DEAD_PORT"
RUN_DIR="$ROOT/.verify/run/cli-doctor"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
# Dummies, distinct, so a leak names which one leaked. Neither reaches a real service: the model is
# faux and the forge is never called by a doctor run.
FAKE_ANTHROPIC="sk-ant-doctor-verify-0123456789abcdef"
FAKE_GITHUB="ghp_doctorverify0123456789abcdef0123456789"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-66s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-66s %s\n' "$1" "$3"
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

# start_api <name> <port> <database url>
start_api() {
  ( cd "$ROOT/apps/api" && exec env \
      PORT="$2" \
      HOST="127.0.0.1" \
      ALLOWED_ORIGINS="http://localhost:$2" \
      MODEL_BACKEND=faux \
      ANTHROPIC_API_KEY="$FAKE_ANTHROPIC" \
      GITHUB_TOKEN="$FAKE_GITHUB" \
      DATABASE_URL="$3" \
      SESSION_ROOT="$RUN_DIR/sessions-$1" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      bun run src/index.ts ) >> "$RUN_DIR/api-$1.log" 2>&1 &
  echo $! > "$RUN_DIR/$1.pid"
}

wait_for() { # url path
  for _ in $(seq 1 60); do
    curl -s -m 1 -o /dev/null "$1$2" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

stop_apis() {
  local pidfile
  for pidfile in "$RUN_DIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    local pid; pid="$(cat "$pidfile")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  done
}

# A database of this run's own, so repos an earlier run registered cannot change what "no repo is
# registered" and the exit codes mean. `CREATE`/`DROP DATABASE` run over the configured server's
# connection; the name is an identifier minted from hex, so quoting it is all the escaping it needs.
SERVER_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory}"
SCRATCH_DB="factory_verify_doctor_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
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
    echo "preflight.sh: could not drop $SCRATCH_DB — drop it by hand" >&2
}
trap 'stop_apis; drop_scratch' EXIT

for port in "$PORT" "$DEGRADED_PORT" "$DEAD_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set DOCTOR_PORT (and _DEGRADED_PORT, _DEAD_PORT) to free ones" >&2
    exit 1
  fi
done

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1
scratch_sql "CREATE DATABASE \"$SCRATCH_DB\"" || { echo "preflight.sh: could not create $SCRATCH_DB" >&2; exit 1; }
SCRATCH_CREATED=1
DB_URL="$(bun -e '
  const url = new URL(process.argv[1]);
  url.pathname = "/" + process.argv[2];
  console.log(url.toString());
' "$SERVER_URL" "$SCRATCH_DB")"
echo "preflight: drive database $SCRATCH_DB (dropped on exit)"

# A throwaway checkout to register: one commit on main, and no `.factory/config`, which doctor warns
# about. The registry only reads it, so no remote is needed.
rm -rf "${RUN_DIR:?}/checkout" "${RUN_DIR:?}"/sessions-*
rm -f "${RUN_DIR:?}"/api-*.log
mkdir -p "$RUN_DIR/checkout"
git init -q -b main "$RUN_DIR/checkout"
git -C "$RUN_DIR/checkout" config user.email verify-cli@localhost
git -C "$RUN_DIR/checkout" config user.name "verify-cli"
git -C "$RUN_DIR/checkout" commit -q --allow-empty -m "doctor checkout"
REPO_OK="acme/doctor-ok"
REPO_BAD="acme/doctor-badref"

start_api faux "$PORT" "$DB_URL"
wait_for "$API_URL" /readyz || { echo "api did not become ready — see $RUN_DIR/api-faux.log" >&2; exit 1; }

# Run `factory <args>` and leave stdout+stderr in doctor-<name>.txt and the exit in doctor-<name>.exit.
doctor() { # name, args...
  local name="$1"; shift
  $FACTORY "$@" > "$EVIDENCE_DIR/doctor-$name.txt" 2>&1
  echo $? > "$EVIDENCE_DIR/doctor-$name.exit"
}
code() { cat "$EVIDENCE_DIR/doctor-$1.exit"; }
has() { grep -qF -- "$2" "$EVIDENCE_DIR/doctor-$1.txt"; }   # <name> <fixed string>
hasre() { grep -qE -- "$2" "$EVIDENCE_DIR/doctor-$1.txt"; } # <name> <extended regex>

# --- a faux API: the warning, the exit, and --allow-faux --------------------------------------------
doctor faux doctor --api "$API_URL"
check "faux API: prints the faux warning with what chose it" \
  "$(has faux 'warn model: faux (selected by MODEL_BACKEND)' && echo 0 || echo 1)" "$(grep -m1 '^warn model' "$EVIDENCE_DIR/doctor-faux.txt" | cut -c1-60)"
check "faux API: exits 1" "$([ "$(code faux)" = "1" ] && echo 0 || echo 1)" "exit=$(code faux)"
check "the API line names the URL it asked" "$(has faux "ok api: $API_URL reachable" && echo 0 || echo 1)" "$API_URL"
check "readiness: postgres, migrations and schema are ok" \
  "$(hasre faux '^ok postgres: ' && hasre faux '^ok migrations: ' && hasre faux '^ok schema: ' && echo 0 || echo 1)" "readyz"
check "the models line: default and role models are served" "$(hasre faux '^ok models: default faux/faux-1' && echo 0 || echo 1)" "ok models"
check "every webhook route is listed, armed or not, with the variable that arms it" \
  "$(hasre faux '^warn webhook github: not armed.*GITHUB_WEBHOOK_SECRET' && hasre faux '^warn webhook linear: not armed.*LINEAR_WEBHOOK_SECRET' && echo 0 || echo 1)" "webhook lines"
check "the trigger rules and env files are reported" \
  "$(hasre faux '^(ok|warn) trigger-rules: ' && hasre faux '^ok env-files: ' && echo 0 || echo 1)" "trigger-rules, env-files"
check "no repo is registered yet: it says so, and the forge is checked once" \
  "$(hasre faux '^ok repos: none registered' && hasre faux '^ok forge: static-token' && echo 0 || echo 1)" "forge static-token"

doctor allow doctor --allow-faux --api "$API_URL"
check "--allow-faux: the warning is still printed" "$(has allow 'warn model: faux (selected by MODEL_BACKEND)' && echo 0 || echo 1)" "warn kept"
check "--allow-faux: exits 0" "$([ "$(code allow)" = "0" ] && echo 0 || echo 1)" "exit=$(code allow)"

# --- registered repos: checkout, base ref, config, forge -------------------------------------------
$FACTORY repo add "$REPO_OK" --path "$RUN_DIR/checkout" --api "$API_URL" > "$EVIDENCE_DIR/doctor-repo-add-ok.txt" 2>&1
$FACTORY repo add "$REPO_BAD" --path "$RUN_DIR/checkout" --base-ref trunk --api "$API_URL" > "$EVIDENCE_DIR/doctor-repo-add-bad.txt" 2>&1
doctor repos doctor --allow-faux --api "$API_URL"
check "a registered checkout: repo, base-ref and forge are ok" \
  "$(has repos "ok repo $REPO_OK: checkout " && hasre repos "^ok base-ref $REPO_OK: main resolves to [0-9a-f]{7}" && hasre repos "^ok forge $REPO_OK: static-token resolves a token for $REPO_OK" && echo 0 || echo 1)" "$REPO_OK"
check "a checkout with no .factory/config is a warning that names the path" \
  "$(hasre repos "^warn config $REPO_OK: no \.factory/config" && echo 0 || echo 1)" "warn config"
check "a base ref the checkout lacks is a fail naming the ref, with the command to fix it" \
  "$(hasre repos "^fail base-ref $REPO_BAD: no commit named trunk in " && grep -q "factory repo add $REPO_BAD --base-ref" "$EVIDENCE_DIR/doctor-repos.txt" && echo 0 || echo 1)" "fail base-ref"
check "and that fail makes doctor exit 1, even with --allow-faux" \
  "$([ "$(code repos)" = "1" ] && echo 0 || echo 1)" "exit=$(code repos)"
doctor one doctor "$REPO_OK" --allow-faux --api "$API_URL"
check "doctor <repo> checks that one repo alone" \
  "$(has one "ok repo $REPO_OK: " && ! grep -q "$REPO_BAD" "$EVIDENCE_DIR/doctor-one.txt" && [ "$(code one)" = "0" ] && echo 0 || echo 1)" "exit=$(code one)"

# --- --live: one request, only when asked -----------------------------------------------------------
check "without --live there is no model request line" \
  "$(grep -q 'live-model' "$EVIDENCE_DIR/doctor-repos.txt" && echo 1 || echo 0)" "no live-model"
doctor live doctor --allow-faux --live --api "$API_URL" "$REPO_OK"
check "--live: one minimal request to the default model, answered" \
  "$(hasre live '^ok live-model: faux/faux-1 answered .*[0-9]+ in / [0-9]+ out' && echo 0 || echo 1)" "$(grep -m1 'live-model' "$EVIDENCE_DIR/doctor-live.txt" | cut -c1-60)"

# --- a credential in the environment is in no line of output -----------------------------------------
leak=0
for out in "$EVIDENCE_DIR"/doctor-*.txt; do
  grep -qF -e "$FAKE_ANTHROPIC" -e "$FAKE_GITHUB" "$out" && leak=1
done
check "the dummy ANTHROPIC_API_KEY and GITHUB_TOKEN appear in no output" "$leak" "$(ls "$EVIDENCE_DIR"/doctor-*.txt | wc -l | tr -d ' ') outputs searched"

# --- an API nothing listens on ------------------------------------------------------------------------
doctor dead doctor --api "$DEAD_URL"
check "an unreachable API: fail api with the URL it tried" \
  "$(hasre dead "^fail api: $DEAD_URL is not reachable" && echo 0 || echo 1)" "$(grep -m1 '^fail api' "$EVIDENCE_DIR/doctor-dead.txt" | cut -c1-60)"
check "and it exits 1, asking nothing else" \
  "$([ "$(code dead)" = "1" ] && [ "$(grep -c '^ok \|^warn ' "$EVIDENCE_DIR/doctor-dead.txt")" = "0" ] && echo 0 || echo 1)" "exit=$(code dead)"

# --- Postgres down: the API is up, the database is not -------------------------------------------
start_api degraded "$DEGRADED_PORT" "postgres://factory:factory@127.0.0.1:1/unreachable"
wait_for "$DEGRADED_URL" /livez || { echo "degraded api did not start — see $RUN_DIR/api-degraded.log" >&2; exit 1; }
doctor degraded doctor --allow-faux --api "$DEGRADED_URL"
check "Postgres down: fail postgres, with how to start it" \
  "$(hasre degraded '^fail postgres: .* -- fix: docker compose up -d --wait postgres' && echo 0 || echo 1)" "$(grep -m1 '^fail postgres' "$EVIDENCE_DIR/doctor-degraded.txt" | cut -c1-60)"
check "and exits 1" "$([ "$(code degraded)" = "1" ] && echo 0 || echo 1)" "exit=$(code degraded)"
check "the checks that need no database are still answered, and the registry says why it cannot be read" \
  "$(has degraded 'warn model: faux' && hasre degraded '^fail repos: the registry could not be read' && echo 0 || echo 1)" "model, repos"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n'
  printf '}\n'
} > "$EVIDENCE_DIR/doctor.json"
cp "$RUN_DIR"/api-*.log "$EVIDENCE_DIR/" 2>/dev/null || true

echo
if [ "$failed" -eq 0 ]; then
  echo "doctor: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "doctor: some checks FAILED — see $EVIDENCE_DIR" >&2
fi
exit "$failed"
