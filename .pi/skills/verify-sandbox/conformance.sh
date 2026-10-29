#!/usr/bin/env bash
# The shared SandboxRuntime cases and Pi Durable's ExecutionEnv suite against the Kubernetes
# runtime on real kind (packages/sandbox-kubernetes/src/conformance.kind.ts): every case makes a
# real Sandbox, pod and PVC and deletes them. Takes minutes. Run after ./up.sh.
#
# Env: KIND_CLUSTER, SANDBOX_NAMESPACE (default factory-conformance). Evidence:
# .verify/sandbox/conformance.log.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
mkdir -p "$ROOT/.verify/sandbox"
bash "$HERE/doctor.sh" >/dev/null
(cd "$ROOT/packages/sandbox-kubernetes" && bun run test:kind) 2>&1 | tee "$ROOT/.verify/sandbox/conformance.log"
