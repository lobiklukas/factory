#!/usr/bin/env bash
# Prove the PR body's evidence block through the real service (LOB-79, part 2 of LOB-16).
#
# The claim: the body GitHub receives states what the run verified, from the log's `verify` record —
# the skill's name, its exit code and a bounded, visibly-truncated excerpt of its output — and says
# "No verification evidence" when the run never verified. See `features/pr-evidence.md`.
#
# The script owns everything it starts: the loopback GitHub fake (`./github-fake.ts`) on its own
# port, its fixture repos and session root under `.verify/run/pr-evidence/`, and the driver process,
# which builds `SessionService` in-process (no API server). The fake's ledger on disk is where the
# body is read back from; the fixture repos have no remote and the model is faux, so nothing here
# reaches a network.
#
#   ./pr-evidence.sh
#
# Env: API_PORT (the fake's port; 9411 when unset), PR_EVIDENCE_PORT (override), DATABASE_URL
# (required: the run's own database), EVIDENCE_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# No API runs here, so the port a run reserved for this surface is the fake's.
PORT="${PR_EVIDENCE_PORT:-${API_PORT:-9411}}"
GH_URL="http://127.0.0.1:$PORT"
RUN_DIR="$ROOT/.verify/run/pr-evidence"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
LEDGER="$RUN_DIR/github-ledger.json"
FAKE="$ROOT/.pi/skills/verify-api/github-fake.ts"
DRIVER="$ROOT/.pi/skills/verify-api/pr-evidence.ts"

stop_fake() {
  [ -f "$RUN_DIR/fake.pid" ] || return 0
  local pid; pid="$(cat "$RUN_DIR/fake.pid")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$RUN_DIR/fake.pid"
}

trap 'stop_fake' EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR/sessions" "$RUN_DIR/repos" "$EVIDENCE_DIR"

# --- the fake -------------------------------------------------------------------------------------
: > "$RUN_DIR/fake.log"
( exec env \
    GITHUB_FAKE_PORT="$PORT" \
    GITHUB_FAKE_LEDGER="$LEDGER" \
    bun "$FAKE" ) >> "$RUN_DIR/fake.log" 2>&1 &
echo $! > "$RUN_DIR/fake.pid"
# Wait for the listener and a live process, not for the ledger: the fake writes the empty ledger
# before `Bun.serve` runs, so a port something else holds would leave a ledger and a dead fake.
for _ in $(seq 1 60); do
  grep -q "github-fake listening" "$RUN_DIR/fake.log" 2>/dev/null && \
    kill -0 "$(cat "$RUN_DIR/fake.pid")" 2>/dev/null && break
  sleep 0.1
done
if ! grep -q "github-fake listening" "$RUN_DIR/fake.log" 2>/dev/null; then
  echo "the fake GitHub did not start on $PORT — see $RUN_DIR/fake.log" >&2
  exit 1
fi

env \
  GITHUB_API_URL="$GH_URL" \
  PR_EVIDENCE_LEDGER="$LEDGER" \
  SESSION_ROOT="$RUN_DIR/sessions" \
  PR_EVIDENCE_REPOS="$RUN_DIR/repos" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  DATABASE_URL="${DATABASE_URL:?pr-evidence needs DATABASE_URL from the run}" \
  bun "$DRIVER" 2>&1 | tee "$RUN_DIR/driver.log"
RC=${PIPESTATUS[0]}
cp "$RUN_DIR/driver.log" "$EVIDENCE_DIR/pr-evidence.log" 2>/dev/null || true
cp "$LEDGER" "$EVIDENCE_DIR/pr-evidence-ledger.json" 2>/dev/null || true
cp "$RUN_DIR/fake.log" "$EVIDENCE_DIR/pr-evidence-fake.log" 2>/dev/null || true
exit "$RC"
