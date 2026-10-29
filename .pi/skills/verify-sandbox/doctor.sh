#!/usr/bin/env bash
# Read-only check: is the local sandbox tier up, and is it the one this repository pins? (LOB-89)
#
# It never skips. A missing tool — kind first, since nothing here exists without it — is a failure
# that names the tool and exits 1 at once; every other check prints its line and the verdict is the
# last line: `doctor: READY` (exit 0) or `doctor: NOT READY` (exit 1). Changes nothing.
#
# Env: KIND_CLUSTER (default factory-sandbox).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
KIND_CLUSTER="${KIND_CLUSTER:-factory-sandbox}"
CONTEXT="kind-$KIND_CLUSTER"
IMAGE="$(tr -d '[:space:]' < "$ROOT/infra/sandbox/IMAGE")"
CONTROLLER="registry.k8s.io/agent-sandbox/agent-sandbox-controller:v1.0.8"

note() { printf '%-26s %s\n' "$1" "$2"; }

for tool in kind kubectl docker; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    note "$tool:" "NOT INSTALLED — not on PATH ($PATH)"
    echo "doctor: NOT READY — $tool is required and missing; install it, then run ./up.sh" >&2
    exit 1
  fi
done

fail=0
note "kind:" "$(kind version 2>/dev/null | head -n 1)"

if ! docker info >/dev/null 2>&1; then
  note "docker daemon:" "DOES NOT ANSWER (docker info failed)"
  echo "doctor: NOT READY" >&2
  exit 1
fi
note "docker daemon:" "answers"

if ! kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
  note "cluster $KIND_CLUSTER:" "MISSING — run ./up.sh"
  echo "doctor: NOT READY" >&2
  exit 1
fi
note "cluster $KIND_CLUSTER:" "exists"

k() { kubectl --context "$CONTEXT" "$@"; }

if k get --raw /readyz >/dev/null 2>&1; then
  note "api server:" "ready ($CONTEXT)"
else
  note "api server:" "NOT READY ($CONTEXT)"
  fail=1
fi

established="$(k get crd sandboxes.agents.x-k8s.io -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null)"
if [ "$established" = "True" ]; then
  note "Sandbox CRD:" "established"
else
  note "Sandbox CRD:" "MISSING or not established — infra/kind/up.sh applies it"
  fail=1
fi

available="$(k -n agent-sandbox-system get deployment agent-sandbox-controller -o jsonpath='{.status.availableReplicas}' 2>/dev/null)"
running_image="$(k -n agent-sandbox-system get deployment agent-sandbox-controller -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)"
if [ "${available:-0}" -ge 1 ] && [ "$running_image" = "$CONTROLLER" ]; then
  note "controller:" "available, $running_image"
else
  note "controller:" "NOT AVAILABLE (replicas ${available:-0}, image ${running_image:-none}; want $CONTROLLER)"
  fail=1
fi

node="$KIND_CLUSTER-control-plane"
if docker exec "$node" crictl images 2>/dev/null | awk '{print $1":"$2}' | grep -qx "docker.io/library/$IMAGE"; then
  note "sandbox image:" "$IMAGE loaded on $node"
else
  note "sandbox image:" "$IMAGE NOT LOADED on $node — ./up.sh builds and loads it"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "doctor: READY"
else
  echo "doctor: NOT READY" >&2
fi
exit "$fail"
