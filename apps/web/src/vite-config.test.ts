import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";

/**
 * The dashboard reads `VITE_*` from the repository-root `.env`, the same file `apps/api` and `apps/cli`
 * load with `--env-file=../../.env` (LOB-256). Vite looks for `.env` in `envDir`, which defaults to the
 * package, so without this setting a `VITE_SERVER_URL` in the root file is silently ignored.
 *
 * The case resolves the real config and reads `envDir` back; it never reads a `.env`, so a developer's
 * real file stays out of a test.
 */
const WEB_ROOT = dirname(
  fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
);
const REPO_ROOT = join(WEB_ROOT, "..", "..");

describe("vite.config.ts", () => {
  it("looks for .env files in the repository root, not the package", async () => {
    const config = await resolveConfig(
      { root: WEB_ROOT, configFile: join(WEB_ROOT, "vite.config.ts") },
      "serve",
    );
    expect(config.envDir).toBe(REPO_ROOT);
    // The root is the repository's, not merely two levels up: it holds the file the README names.
    expect(existsSync(join(REPO_ROOT, ".env.example"))).toBe(true);
  }, 30_000);
});
