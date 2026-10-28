#!/usr/bin/env bash
# Prove control-plane identity over the real API (LOB-20).
#
#   DATABASE_URL=postgres://…/factory_<slug> API_PORT=9200 ./identity.sh
#
# Boots this skill's API (./up.sh) with a token table — the shared FACTORY_API_TOKEN as
# `verify-operator`, and FACTORY_API_TOKENS naming `amy` — a generic trigger rule and its signing
# secret, then `identity.ts` drives it: an RPC with no credential and with a wrong one, unary
# (`listSessions`) and streaming (`watchSession`), must fail `Unauthenticated`; with amy's credential,
# `createSession` + `requestApproval`/`decideApproval` + `createTask`/`moveTask`, each sent with a body
# actor naming `mallory`, and a `factory board move --actor mallory` through the real CLI, must record
# `amy` — read back from `sessions`, `session_approvals` and `task_events`, and from `listSpend`; a
# signed generic delivery with no credential must still start a session, attributed
# `trigger:generic`. Every token is a throwaway made here and nothing leaves loopback.
#
# Env: API_PORT (9200 when unset), DATABASE_URL (required: up.sh migrates it), EVIDENCE_DIR.
# Evidence: .verify/evidence/latest/api/identity.json (every check and every recorded actor) and
# identity-api.log (the API's log: the auth boot line and each refused call, never a token).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "identity.sh needs DATABASE_URL naming this worktree's own database (never the shared default)" >&2
  exit 1
fi
mkdir -p "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api"

# Throwaway credentials, minted per run so a token in an old evidence file opens nothing.
RUN_TAG="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
export IDENTITY_SHARED_TOKEN="identity-shared-$RUN_TAG-0123456789"
export IDENTITY_AMY_TOKEN="identity-amy-$RUN_TAG-0123456789"
export IDENTITY_SHARED_ACTOR="verify-operator"
export TRIGGER_SECRET="identity-trigger-secret-$RUN_TAG"
export IDENTITY_REPO="acme/verify-identity-$RUN_TAG"

./down.sh >/dev/null 2>&1 || true
trap './down.sh >/dev/null 2>&1 || true' EXIT

API_PORT="$API_PORT" \
  MODEL_BACKEND=faux \
  FACTORY_API_TOKEN="$IDENTITY_SHARED_TOKEN" \
  FACTORY_API_ACTOR="$IDENTITY_SHARED_ACTOR" \
  FACTORY_API_TOKENS="amy=$IDENTITY_AMY_TOKEN" \
  TRIGGER_SECRET="$TRIGGER_SECRET" \
  TRIGGER_RULES="[{\"label\":\"factory\",\"repo\":\"$IDENTITY_REPO\",\"baseRef\":\"main\",\"prompt\":\"Work on {{title}}\"}]" \
  ./up.sh || exit 1

API_URL="http://localhost:$API_PORT" EVIDENCE_DIR="$EVIDENCE_DIR" \
  CLI_ENTRY="$ROOT/apps/cli/src/index.ts" \
  bun identity.ts
status=$?
cp "$ROOT/.verify/run/api.log" "$EVIDENCE_DIR/identity-api.log"
for token in "$IDENTITY_SHARED_TOKEN" "$IDENTITY_AMY_TOKEN"; do
  if grep -qF -- "$token" "$EVIDENCE_DIR/identity-api.log" "$EVIDENCE_DIR/identity.json"; then
    echo "FAIL  the API log or the evidence carries a token's value" >&2
    status=1
  fi
done
if grep -q "control-plane auth: bearer token on every RPC" "$EVIDENCE_DIR/identity-api.log"; then
  echo "PASS  the boot says every RPC needs a bearer token"
else
  echo "FAIL  the boot line naming the auth mode is missing" >&2
  status=1
fi
[ "$status" -eq 0 ] && echo "PASS  no token's value in the API log or the evidence"
echo "evidence: $EVIDENCE_DIR/identity.json"
exit "$status"
