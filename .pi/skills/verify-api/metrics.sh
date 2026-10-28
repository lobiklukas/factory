#!/usr/bin/env bash
# Prove the documented metric set reaches a local collector (LOB-69), across a process boundary.
#
#   DATABASE_URL=postgres://…/factory_<slug> API_PORT=9200 OTLP_RECEIVER_PORT=9201 ./metrics.sh
#
# Starts ./otlp-receiver.ts on loopback, boots this skill's API (./up.sh, faux) with
# OTEL_EXPORTER_OTLP_METRICS_ENDPOINT at the receiver and a half-second export interval, then
# `metrics.ts` creates and runs a session over RPC, has an oversized message refused, and waits for
# one export carrying every metric in docs/metrics.md with its documented unit. motel is not started
# and MOTEL_URL is unset: the receiver's record is the only oracle.
#
# Env: API_PORT (9200 when unset), OTLP_RECEIVER_PORT (API_PORT + 1 when unset), DATABASE_URL
# (required: up.sh migrates it), EVIDENCE_DIR.
# Evidence: .verify/evidence/latest/api/metrics.json (every check and the matched export's reading),
# metrics-received.ndjson (every body the receiver was sent), metrics-api.log (the API's own log).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9200}"
OTLP_RECEIVER_PORT="${OTLP_RECEIVER_PORT:-$((API_PORT + 1))}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "metrics.sh needs DATABASE_URL naming this worktree's own database (never the shared default)" >&2
  exit 1
fi
mkdir -p "$EVIDENCE_DIR"
rm -f "$EVIDENCE_DIR/metrics-received.ndjson"
cd "$ROOT/.pi/skills/verify-api"

./down.sh >/dev/null 2>&1 || true
receiver_pid=""
cleanup() {
  ./down.sh >/dev/null 2>&1 || true
  [ -n "$receiver_pid" ] && kill "$receiver_pid" 2>/dev/null || true
}
trap cleanup EXIT

OTLP_RECEIVER_PORT="$OTLP_RECEIVER_PORT" EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun otlp-receiver.ts > "$EVIDENCE_DIR/metrics-receiver.log" 2>&1 &
receiver_pid=$!
for _ in $(seq 1 40); do
  curl -sf -m 1 "http://127.0.0.1:$OTLP_RECEIVER_PORT/received" >/dev/null 2>&1 && break
  sleep 0.25
done

unset MOTEL_URL
API_PORT="$API_PORT" \
  MODEL_BACKEND=faux \
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="http://127.0.0.1:$OTLP_RECEIVER_PORT/v1/metrics" \
  OTEL_METRIC_EXPORT_INTERVAL=500 \
  ./up.sh || exit 1

API_URL="http://localhost:$API_PORT" \
  OTLP_RECEIVER_URL="http://127.0.0.1:$OTLP_RECEIVER_PORT" \
  EVIDENCE_DIR="$EVIDENCE_DIR" \
  bun metrics.ts
status=$?
cp "$ROOT/.verify/run/api.log" "$EVIDENCE_DIR/metrics-api.log"
# The boot says where it exports, so an operator can tell an exporter that is off from one that is on.
if grep -qF "Exporting OTLP metrics to http://127.0.0.1:$OTLP_RECEIVER_PORT/v1/metrics" "$EVIDENCE_DIR/metrics-api.log"; then
  echo "PASS  the API log names the metrics endpoint"
else
  echo "FAIL  the API log does not name the metrics endpoint" >&2
  status=1
fi
echo "evidence: $EVIDENCE_DIR/metrics.json"
exit "$status"
