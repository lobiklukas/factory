#!/usr/bin/env bash
# Prove a run can use the MCP tools its repository allows, over the real API (S-agent-mcp-tools).
#
# The claim: a repo whose `.factory/config` allows a registered MCP server's tools gets them offered;
# the read tool runs unattended and its call and answer are in the transcript, with the bearer token
# from the repo's secret reaching the server and not the agent's shell; the write tool raises an
# approval, a denial reaches the agent as the blocked call's result, and the server never sees the
# write; a registered server the repo does not allow is not offered and is never contacted. See
# `features/mcp-tools.md`.
#
# Its own API (./up.sh, on API_PORT, with its own run directory), the faux model calling the three
# tools after its `bash` step on every turn (`FAUX_MCP_CALLS`), and a fake MCP server on loopback
# (`@repo/harness/mcpFake`, started by the driver on MCP_FAKE_PORT) standing in for both servers.
#
#   ./mcp-tools.sh
#   API_PORT=9510 MCP_FAKE_PORT=9511 ./mcp-tools.sh
#
# Env: DATABASE_URL (the run's own database), API_PORT, MCP_FAKE_PORT, EVIDENCE_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9446}"
MCP_FAKE_PORT="${MCP_FAKE_PORT:-9447}"
RUN_DIR="$ROOT/.verify/run/mcp-tools"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"

for port in "$API_PORT" "$MCP_FAKE_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set API_PORT / MCP_FAKE_PORT to free ones" >&2
    exit 1
  fi
done

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/repos" "$EVIDENCE_DIR"
cd "$ROOT/.pi/skills/verify-api"

# The repo secret the tracker's token is read from, and the store's key: a fresh pair per run.
FACTORY_SECRETS_KEY="$(bun -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))')"
MCP_TOOLS_TOKEN="mcp-token-$(bun -e 'console.log(require("node:crypto").randomBytes(12).toString("hex"))')"
export FACTORY_SECRETS_KEY MCP_TOOLS_TOKEN
export MCP_SERVERS="[{\"name\":\"tracker\",\"url\":\"http://127.0.0.1:$MCP_FAKE_PORT/tracker\",\"secret\":\"TRACKER_MCP_TOKEN\"},{\"name\":\"rogue\",\"url\":\"http://127.0.0.1:$MCP_FAKE_PORT/rogue\"}]"
export FAUX_MCP_CALLS='[{"tool":"mcp__tracker__get_issue","arguments":{"id":"ISS-7"}},{"tool":"mcp__tracker__update_issue","arguments":{"id":"ISS-7","state":"done"}},{"tool":"mcp__rogue__get_issue","arguments":{"id":"ISS-7"}}]'
# The agent's shell: whether the tracker's token reached it.
export FAUX_COMMAND='printenv TRACKER_MCP_TOKEN || echo no-mcp-token-in-shell'
export FAUX_EVERY_TURN=true
export SESSION_IDLE_TIMEOUT_MS=600000

trap 'cp "$RUN_DIR/api.log" "$EVIDENCE_DIR/mcp-tools-api.log" 2>/dev/null || true; VERIFY_RUN_DIR="$RUN_DIR" ./down.sh >/dev/null 2>&1 || true' EXIT

VERIFY_RUN_DIR="$RUN_DIR" API_PORT="$API_PORT" ./up.sh || exit 1
env \
  API_URL="http://localhost:$API_PORT" \
  DATABASE_URL="${DATABASE_URL:?mcp-tools needs DATABASE_URL from the run}" \
  MCP_FAKE_PORT="$MCP_FAKE_PORT" \
  MCP_TOOLS_REPOS="$RUN_DIR/repos" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun "$ROOT/.pi/skills/verify-api/mcp-tools.ts" 2>&1 | tee "$RUN_DIR/driver.log"
RC="${PIPESTATUS[0]}"
cp "$RUN_DIR/driver.log" "$EVIDENCE_DIR/mcp-tools.log" 2>/dev/null || true
exit "$RC"
