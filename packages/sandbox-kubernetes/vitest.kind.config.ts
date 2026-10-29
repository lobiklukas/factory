import { defineConfig } from "vitest/config";

/**
 * The kind-backed suite (`bun run test:kind`), never part of `bun run test`: it needs the cluster
 * `infra/kind/up.sh` brings up and the image `infra/sandbox/build.sh` loads into it. The
 * verify-sandbox skill runs it on purpose (`.pi/skills/verify-sandbox/conformance.sh`).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.kind.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
