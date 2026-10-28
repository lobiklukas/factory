#!/usr/bin/env bash
# Prove a repo's scoped secrets over the real API and CLI (S-agent-secrets).
#
# The claim: a secret stored with `factory secret set` reaches only the command the repo's
# `.factory/config` declares it for at the base — its `verify` passes on it — while the value is in
# no row the session wrote, its transcript shows `[secret:TEST_API_KEY]`, and the agent's own `env`
# does not hold it; no RPC or CLI answer carries it; and a card's branch that commits it is refused
# `secret-found` before any push, the refusal named on the card. See `features/secrets.md`.
#
# Its own API (./up.sh, on API_PORT, with its own run directory and a store key minted per run), the
# faux model scripted to count TEST_API_KEY in its shell, commit a change (and a copy of the base's
# `leak-source` when there is one) and call `verify`, and fixture repos with no remote under
# .verify/run/secrets/. Every value is obviously fake.
#
#   ./secrets.sh
#   API_PORT=9520 ./secrets.sh
#
# Env: DATABASE_URL (the run's own database), API_PORT, EVIDENCE_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
RUN_DIR="$ROOT/.verify/run/secrets"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"

if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $API_PORT is already in use — set API_PORT to a free one" >&2
  exit 1
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/repos" "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api"

# The store's key, this run's own: a value stored here is readable by this API and nothing else.
FACTORY_SECRETS_KEY="$(bun -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))')"
export FACTORY_SECRETS_KEY
export FAUX_COMMAND="echo \"agent-env-key-count:\$(env | grep -c '^TEST_API_KEY=.')\"; mkdir -p src && echo change > src/change.txt; if [ -f leak-source ]; then cp leak-source leaked.txt; fi; git add -A && git commit -qm change; echo faux-ok"
export FAUX_VERIFY=true
# Long enough that the idle sweep never releases an owner between the drive's calls.
export SESSION_IDLE_TIMEOUT_MS=600000

stop() { VERIFY_RUN_DIR="$RUN_DIR" ./down.sh >/dev/null 2>&1 || true; }
trap 'cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/secrets-api.log" 2>/dev/null || true; stop' EXIT

VERIFY_RUN_DIR="$RUN_DIR" API_PORT="$API_PORT" ./up.sh || exit 1

env \
  API_URL="http://localhost:$API_PORT" \
  DATABASE_URL="${DATABASE_URL:?secrets needs DATABASE_URL from the run}" \
  SECRETS_REPOS="$RUN_DIR/repos" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$ROOT/.pi/skills/verify-api/secrets.ts" 2>&1 | tee "$RUN_DIR/driver.log"
RC=${PIPESTATUS[0]}
cp "$RUN_DIR/driver.log" "$EVIDENCE_DIR/secrets.log" 2>/dev/null || true

# The refused card as the CLI shows it: its note names `secret_found` and the secret by name.
TASK_ID="$(cat "$RUN_DIR/repos/leaky-task-id" 2>/dev/null)"
bun "$ROOT/apps/cli/src/index.ts" board show --task "$TASK_ID" --api "http://localhost:$API_PORT" \
  > "$EVIDENCE_DIR/secrets-board-show.txt" 2>&1
if grep -q 'secret_found' "$EVIDENCE_DIR/secrets-board-show.txt" &&
   grep -q 'the stored secret TEST_API_KEY at leaked.txt:1' "$EVIDENCE_DIR/secrets-board-show.txt"; then
  echo "PASS  factory board show prints the card's secret_found refusal"
else
  echo "FAIL  factory board show prints the card's secret_found refusal (see secrets-board-show.txt)" >&2
  RC=1
fi
# Nothing this drive wrote as evidence holds the value: the API's own log included.
if grep -rq 'verify-secrets-fake-value-' "$EVIDENCE_DIR"/secrets* "$RUN_DIR/api.log" 2>/dev/null; then
  echo "FAIL  no evidence file and no API log line holds the value" >&2
  RC=1
else
  echo "PASS  no evidence file and no API log line holds the value"
fi
exit "$RC"
