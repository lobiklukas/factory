#!/usr/bin/env bash
# Prove `getServerInfo` and each session's `model` over the real RPC client (LOB-269).
#
#   DATABASE_URL=postgres://…/factory_<slug> API_PORT=9200 ./server-info.sh
#
# Boots this skill's API (./up.sh, so `MODEL_BACKEND=faux` and up.sh's `replay-target=faux/faux-2`
# row) with a role table of its own, an approval gate, a default budget, two armed webhook routes
# and a dummy `ANTHROPIC_API_KEY`, then `server-info.ts` asks what it is running and creates one
# session: the backend, the default and role models, the config and the model on `getSession` and
# `listSessions` are checked, and so is the raw NDJSON body — none of the dummy credentials may
# appear in it. Every credential is a dummy and a faux boot sends no model request, so nothing
# reaches Anthropic, GitHub or Linear.
#
# Env: API_PORT (9200 when unset), DATABASE_URL (required: up.sh migrates it), EVIDENCE_DIR.
# Evidence: .verify/evidence/latest/api/server-info.json (every check, the answer, the session) and
# server-info-api.log (the API's own log of the boot).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "server-info.sh needs DATABASE_URL naming this worktree's own database (never the shared default)" >&2
  exit 1
fi
mkdir -p "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api"

# The dummies the answer must not carry: the driver reads the same variables to look for them.
export SERVER_INFO_ANTHROPIC_KEY="sk-ant-dummy-server-info-0123456789"
export SERVER_INFO_GITHUB_SECRET="dummy-github-webhook-secret-server-info"
export SERVER_INFO_LINEAR_SECRET="dummy-linear-webhook-secret-server-info"

./down.sh >/dev/null 2>&1 || true
trap './down.sh >/dev/null 2>&1 || true' EXIT

API_PORT="$API_PORT" \
  MODEL_BACKEND=faux \
  ROLE_MODELS="specifier=faux/faux-spec" \
  APPROVAL_REQUIRED="npm publish" \
  SESSION_BUDGET="3" \
  ANTHROPIC_API_KEY="$SERVER_INFO_ANTHROPIC_KEY" \
  GITHUB_WEBHOOK_SECRET="$SERVER_INFO_GITHUB_SECRET" \
  LINEAR_WEBHOOK_SECRET="$SERVER_INFO_LINEAR_SECRET" \
  ./up.sh || exit 1

API_URL="http://localhost:$API_PORT" EVIDENCE_DIR="$EVIDENCE_DIR" bun server-info.ts
status=$?
cp "$ROOT/.verify/run/api.log" "$EVIDENCE_DIR/server-info-api.log"
# The boot's own log must not carry the dummies either: it names the variable, never the value.
for secret in "$SERVER_INFO_ANTHROPIC_KEY" "$SERVER_INFO_GITHUB_SECRET" "$SERVER_INFO_LINEAR_SECRET"; do
  if grep -qF -- "$secret" "$EVIDENCE_DIR/server-info-api.log"; then
    echo "FAIL  the API log carries a dummy credential's value" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "PASS  the API log carries no dummy credential's value"
echo "evidence: $EVIDENCE_DIR/server-info.json"
exit "$status"
