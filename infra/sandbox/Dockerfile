# syntax=docker/dockerfile:1.7
#
# The sandbox image (docs/design.md D13, LOB-90): the generic base every sandbox starts from —
# Bun, Node, git, gh and ripgrep, with Pi Durable and the harness from this repository — plus the
# environment relay a Kubernetes sandbox's `ExecutionEnv` reaches through (`factory-env-relay`).
# Repo-specific toolchains are not baked in: a session installs what its repository needs.
#
#   bash infra/sandbox/build.sh    # builds the tag in infra/sandbox/IMAGE, then prints every version
#
# The build context is the repository root, filtered by Dockerfile.dockerignore beside this file
# (no .git, no node_modules, no .env, no .verify). Every base is pinned by version; the tag this
# builds is pinned in infra/sandbox/IMAGE and in the runtime's SANDBOX_IMAGE, never `latest`.

ARG NODE_VERSION=24.16.0
ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION}-debian AS bun

# The repository with its dependencies installed, and the relay bundled for Node.
FROM node:${NODE_VERSION}-bookworm-slim AS repo
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/factory
COPY . .
# --ignore-scripts: the root `prepare` patches the type checker and installs motel, neither of
# which a sandbox runs.
RUN bun install --frozen-lockfile --ignore-scripts \
  && bun build packages/sandbox-kubernetes/src/relay/main.ts --target=node --outfile /opt/factory/relay.mjs

FROM node:${NODE_VERSION}-bookworm-slim
ARG BUN_VERSION
LABEL org.opencontainers.image.title="factory-sandbox" \
      org.opencontainers.image.description="The factory's generic sandbox base (D13)" \
      dev.factory.bun-version="${BUN_VERSION}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git gh ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=repo /opt/factory /opt/factory
COPY infra/sandbox/factory-env-relay infra/sandbox/factory-sandbox-versions /usr/local/bin/
WORKDIR /workspace
CMD ["sh", "-c", "trap 'exit 0' TERM; sleep infinity & wait"]
