#!/usr/bin/env bash
# Build the sandbox image from this repository (LOB-90) and print every tool's version from inside
# it. The tag is the one infra/sandbox/IMAGE pins; with KIND_CLUSTER set, the image is also loaded
# into that kind cluster's node, which never pulls it (`imagePullPolicy: IfNotPresent`).
#
#   bash infra/sandbox/build.sh                              # build, then print versions
#   KIND_CLUSTER=factory-sandbox bash infra/sandbox/build.sh # …and load it into kind
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="$(tr -d '[:space:]' < "$ROOT/infra/sandbox/IMAGE")"

case "$IMAGE" in
  *:latest|*:|"") echo "infra/sandbox/IMAGE must pin a tag, not '$IMAGE'" >&2; exit 1 ;;
  *:*) ;;
  *) echo "infra/sandbox/IMAGE must pin a tag, not '$IMAGE'" >&2; exit 1 ;;
esac
command -v docker >/dev/null 2>&1 || { echo "infra/sandbox/build.sh: docker is not installed" >&2; exit 1; }

docker build --file "$ROOT/infra/sandbox/Dockerfile" --tag "$IMAGE" "$ROOT"
docker run --rm "$IMAGE" factory-sandbox-versions

if [ -n "${KIND_CLUSTER:-}" ]; then
  command -v kind >/dev/null 2>&1 || { echo "infra/sandbox/build.sh: kind is not installed" >&2; exit 1; }
  kind load docker-image "$IMAGE" --name "$KIND_CLUSTER"
fi
