#!/usr/bin/env bash
# Bring the local sandbox tier up from nothing (LOB-90): a kind cluster, then the released
# agent-sandbox controller and its `Sandbox` CRD, then wait until both answer.
#
#   bash infra/kind/up.sh
#
# Idempotent: an existing cluster of the same name is reused, and re-applying the manifest changes
# nothing. It needs `docker` (a running daemon), `kind` and `kubectl` on PATH, and it stops at the
# first one missing, naming it — it never skips a step. Nothing here reaches a cloud or uses a
# credential: the cluster is containers on this machine, and the only downloads are the public kind
# node image and the controller image the manifest pins.
#
# KIND_CLUSTER (default factory-sandbox) names the cluster; the kubectl context is kind-$KIND_CLUSTER.
# The sandbox image is built and loaded separately (infra/sandbox/build.sh), because a cluster is
# useful without it and the image is rebuilt far more often than the cluster.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIND_CLUSTER="${KIND_CLUSTER:-factory-sandbox}"
CONTEXT="kind-$KIND_CLUSTER"
MANIFEST="$HERE/agent-sandbox/sandbox-v1.0.8.yaml"

for tool in docker kind kubectl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "infra/kind/up.sh: $tool is not installed (not on PATH); the sandbox tier needs docker, kind and kubectl" >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "infra/kind/up.sh: docker is installed but its daemon does not answer (docker info failed)" >&2
  exit 1
fi

# The vendored release, byte for byte: a hand-edited manifest is not the one the version names.
(cd "$HERE/agent-sandbox" && shasum -a 256 -c SHA256SUMS >/dev/null) || {
  echo "infra/kind/up.sh: $MANIFEST does not match agent-sandbox/SHA256SUMS" >&2
  exit 1
}

if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
  echo "cluster $KIND_CLUSTER: exists, reused"
else
  kind create cluster --name "$KIND_CLUSTER" --config "$HERE/cluster.yaml" --wait 120s
fi

kubectl --context "$CONTEXT" apply --server-side -f "$MANIFEST" >/dev/null
kubectl --context "$CONTEXT" wait --for condition=Established --timeout=60s \
  crd/sandboxes.agents.x-k8s.io >/dev/null
kubectl --context "$CONTEXT" -n agent-sandbox-system rollout status \
  deployment/agent-sandbox-controller --timeout=180s >/dev/null
echo "agent-sandbox v1.0.8: CRD established, controller available (context $CONTEXT)"
