#!/usr/bin/env bash
# Tear the sandbox tier down (LOB-89): delete the kind cluster, and with it every sandbox, pod and
# volume it held, then check nothing of it is left — no cluster, no node container.
#
# Env: KIND_CLUSTER (default factory-sandbox). Exit 1 if anything survived.
set -uo pipefail

KIND_CLUSTER="${KIND_CLUSTER:-factory-sandbox}"
command -v kind >/dev/null 2>&1 || { echo "down.sh: kind is not installed" >&2; exit 1; }

kind delete cluster --name "$KIND_CLUSTER"

left=0
if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
  echo "down.sh: cluster $KIND_CLUSTER still exists" >&2
  left=1
fi
containers="$(docker ps -a --filter "label=io.x-k8s.kind.cluster=$KIND_CLUSTER" --format '{{.Names}}' 2>/dev/null)"
if [ -n "$containers" ]; then
  echo "down.sh: node containers left: $containers" >&2
  left=1
fi
[ "$left" -eq 0 ] && echo "down.sh: cluster $KIND_CLUSTER deleted; no node, pod or volume of it is left"
exit "$left"
