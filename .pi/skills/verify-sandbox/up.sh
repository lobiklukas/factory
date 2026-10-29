#!/usr/bin/env bash
# Bring the sandbox tier up from nothing and prove it is ready (LOB-89, LOB-90): the kind cluster
# and the pinned agent-sandbox release (infra/kind/up.sh), the sandbox image built from this
# repository and loaded into the node (infra/sandbox/build.sh), then ./doctor.sh.
#
# Env: KIND_CLUSTER (default factory-sandbox). Evidence: .verify/sandbox/up.log.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
export KIND_CLUSTER="${KIND_CLUSTER:-factory-sandbox}"
EVIDENCE="$ROOT/.verify/sandbox"
mkdir -p "$EVIDENCE"

{
  bash "$ROOT/infra/kind/up.sh"
  bash "$ROOT/infra/sandbox/build.sh"
  bash "$HERE/doctor.sh"
} 2>&1 | tee "$EVIDENCE/up.log"
