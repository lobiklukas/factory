#!/usr/bin/env bash
# Drive `factory show` (F19, F20): the `context` line says what a run was told about its repository, so an
# operator need not read the log. Real runs of the faux model on fixture repos, then `factory show` on
# each, in the words of the checks below:
#
#   AGENTS.md, two skills, a nested file   told AGENTS.md (<bytes> bytes, <tokens> tokens) and 2 repo skills
#                                          and 1 nested AGENTS.md listed — <bytes> is the file's own size
#   AGENTS.md and CLAUDE.md                AGENTS.md wins (F20): the line names AGENTS.md
#   only CLAUDE.md, only the Copilot file  the line names the file that was read (F20)
#   an AGENTS.md far over the cap          the line says it was truncated
#   nothing, and a scratch session         no repo instructions
#   an unknown id                          error: not_found, non-zero
#
# Not ./up.sh's instance: this script starts and stops its own API, session root and checkouts.
#
#   ./repo-context.sh                  # API on :9394
#   CONTEXT_PORT=9554 ./repo-context.sh
#
# Evidence: .verify/evidence/latest/cli/repo-context-*.txt (each `factory show`), repo-context.json.
set -uo pipefail

unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${CONTEXT_PORT:-9394}"
API_URL="http://localhost:$PORT"
RUN_DIR="$ROOT/.verify/run/cli-repo-context"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
FACTORY=(bun run "$ROOT/apps/cli/src/index.ts")
TAG="$(date +%s)$$"
UNKNOWN="ses_00000000000000000000000000"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"${3//\"/\'}\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-80s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-80s %s\n' "$1" "$3"
  fi
}
yes_if() { if eval "$1"; then echo 0; else echo 1; fi; }

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — set CONTEXT_PORT to a free one" >&2
  exit 1
fi

stop_api() {
  [ -f "$RUN_DIR/api.pid" ] || return 0
  local pid; pid="$(cat "$RUN_DIR/api.pid")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$RUN_DIR/api.pid"
}
cleanup() {
  stop_api
  cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/repo-context-api.log" 2>/dev/null || true
  bun -e '
    const sql = new Bun.SQL(process.argv[1]);
    try { await sql`DELETE FROM repos WHERE slug LIKE ${"verify-context-%"}`; } finally { await sql.close(); }
  ' "${DATABASE_URL:-postgres://factory:factory@localhost:5442/factory}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

rm -rf "$RUN_DIR/sessions" "$RUN_DIR/checkouts"
mkdir -p "$RUN_DIR/sessions" "$RUN_DIR/checkouts"
: > "$RUN_DIR/api.log"

# A checkout with the given files committed on main: `fixture name path=content ...`.
fixture() {
  local name="$1"; shift
  local dir="$RUN_DIR/checkouts/$name"
  git init -q -b main "$dir"
  local pair
  for pair in "$@"; do
    mkdir -p "$dir/$(dirname "${pair%%=*}")"
    printf '%b' "${pair#*=}" > "$dir/${pair%%=*}"
  done
  echo "$name" > "$dir/README.md"
  git -C "$dir" add -A
  git -C "$dir" -c user.email=verify-context@localhost -c user.name=verify-context commit -q -m seed
}
AGENTS_TEXT="# Rules ($TAG)\n\n- Run the gate.\n- Say what it printed.\n"
SKILL_A="---\nname: probe-a\ndescription: Probe the first thing.\n---\n\nbody\n"
SKILL_B="---\nname: probe-b\ndescription: Probe the second thing.\n---\n\nbody\n"
fixture told "AGENTS.md=$AGENTS_TEXT" ".pi/skills/probe-a/SKILL.md=$SKILL_A" \
  ".agents/skills/probe-b/SKILL.md=$SKILL_B" "packages/web/AGENTS.md=# Web rules\n"
fixture both "AGENTS.md=# Agents rules\n" "CLAUDE.md=# Claude rules\n"
fixture claude "CLAUDE.md=# Claude rules\n\n- Use bun.\n"
fixture copilot ".github/copilot-instructions.md=# Copilot rules\n"
fixture bare
LONG_TEXT="$(for i in $(seq 1 3000); do printf -- '- rule %s: keep the gate green\\n' "$i"; done)"
fixture long "AGENTS.md=$LONG_TEXT"

( cd "$ROOT/apps/api" && exec env \
    PORT="$PORT" HOST="127.0.0.1" ALLOWED_ORIGINS="http://localhost:$PORT" \
    MODEL_BACKEND=faux FAUX_COMMAND="echo faux-ok" \
    SESSION_ROOT="$RUN_DIR/sessions" SESSION_IDLE_TIMEOUT_MS=600000 \
    bun run src/index.ts ) >> "$RUN_DIR/api.log" 2>&1 &
echo $! > "$RUN_DIR/api.pid"
ready=0
for _ in $(seq 1 60); do
  curl -sf -m 1 "$API_URL/readyz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 0.5
done
[ "$ready" -eq 1 ] || { echo "api did not become ready — see $RUN_DIR/api.log" >&2; exit 1; }

register() { # slug, path
  printf '{"_tag":"Request","id":"1","tag":"registerRepo","payload":{"repo":"%s","localPath":"%s"},"headers":[]}\n' "$1" "$2" |
    curl -s -m 10 -H 'content-type: application/ndjson' --data-binary @- "$API_URL/rpc" | grep -q '"_tag":"Success"'
}
cli() { "${FACTORY[@]}" "$@" --api "$API_URL"; }

# Run the faux model on `name`'s repo (or a scratch session for none) and print `factory show` of it.
show_for() { # name ('' = scratch)
  local out="$EVIDENCE_DIR/repo-context-${1:-scratch}.txt"
  if [ -n "$1" ]; then
    register "verify-context-$TAG/$1" "$RUN_DIR/checkouts/$1" || { echo "could not register $1" >&2; exit 1; }
    cli run "look at the rules" --repo "verify-context-$TAG/$1" > "$out.run" 2>&1
  else
    cli run "look at the rules" > "$out.run" 2>&1
  fi
  local id; id="$(grep -o '^session ses_[0-9a-z]\{26\}' "$out.run" | head -1 | cut -d' ' -f2)"
  cli show "$id" > "$out" 2>&1
  echo "$out"
}
context_of() { grep '^context ' "$1" | head -1; }

TOLD="$(show_for told)"
BYTES="$(printf '%b' "$AGENTS_TEXT" | wc -c | tr -d ' ')"
check "AGENTS.md, two skills and a nested file: the line counts the file's bytes, its tokens and the skills" \
  "$(yes_if "grep -Eqx 'context told AGENTS.md \\($BYTES bytes, [0-9]+ tokens\\) and 2 repo skills and 1 nested AGENTS.md listed' '$TOLD'")" \
  "$(context_of "$TOLD")"
check "and names the nested file, the commit it was read at" \
  "$(yes_if "grep -qx 'context-nested packages/web/AGENTS.md' '$TOLD' && grep -Eq '^context-read main \\([0-9a-f]{12}\\)$' '$TOLD'")" \
  "$(grep -E '^context-(nested|read)' "$TOLD" | tr '\n' ' ')"

BOTH="$(show_for both)"
check "with AGENTS.md and CLAUDE.md the line names AGENTS.md: it wins" \
  "$(yes_if "grep -q '^context told AGENTS.md (' '$BOTH' && ! grep -q 'CLAUDE.md' '$BOTH'")" \
  "$(context_of "$BOTH")"
CLAUDE="$(show_for claude)"
check "a repo that keeps only CLAUDE.md is told CLAUDE.md, and the line names it" \
  "$(yes_if "grep -q '^context told CLAUDE.md (' '$CLAUDE'")" \
  "$(context_of "$CLAUDE")"
COPILOT="$(show_for copilot)"
check "a repo that keeps only the Copilot file is told that file" \
  "$(yes_if "grep -q '^context told .github/copilot-instructions.md (' '$COPILOT'")" \
  "$(context_of "$COPILOT")"
LONG="$(show_for long)"
check "a file far over the cap says it was truncated" \
  "$(yes_if "grep -q '^context told AGENTS.md (.*truncated' '$LONG'")" \
  "$(context_of "$LONG" | cut -c1-120)"
BARE="$(show_for bare)"
SCRATCH="$(show_for '')"
check "a repo with neither file and a scratch session say no repo instructions" \
  "$(yes_if "grep -qx 'context no repo instructions' '$BARE' && grep -qx 'context no repo instructions' '$SCRATCH'")" \
  "bare: $(context_of "$BARE"); scratch: $(context_of "$SCRATCH")"

cli show "$UNKNOWN" > "$EVIDENCE_DIR/repo-context-unknown.txt" 2>&1
RC=$?
check "showing an unknown id is error: not_found, non-zero" \
  "$(yes_if "[ $RC -ne 0 ] && grep -q '^error: not_found' '$EVIDENCE_DIR/repo-context-unknown.txt'")" \
  "exit=$RC"

{
  printf '{\n  "apiUrl": "%s",\n  "checks": {\n' "$API_URL"
  first=1
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n  }\n}\n'
} > "$EVIDENCE_DIR/repo-context.json"

if [ "$failed" -eq 0 ]; then
  echo "repo-context: all checks passed"
else
  echo "repo-context: some checks failed — see $EVIDENCE_DIR" >&2
fi
exit "$failed"
