import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    // Resolving the config loads Vite and every plugin: past the 30 s this was beside a full `bun
    // run test` on a loaded machine (DEFLAKE).
  }, 120_000);

  it("reads VITE_PORT from a .env in envDir, with the shell winning, else 3000", async () => {
    // Loaded by path: the helper belongs to the Node-side tsconfig project, which the app project
    // references but cannot import from without a build.
    const { devPort } = (await import(
      pathToFileURL(join(WEB_ROOT, "vite-port.ts")).href
    )) as {
      devPort: (
        mode: string,
        envDir: string,
        shell: Record<string, string | undefined>,
      ) => number;
    };
    const dir = mkdtempSync(join(tmpdir(), "vite-port-"));
    const empty = mkdtempSync(join(tmpdir(), "vite-port-empty-"));
    try {
      writeFileSync(join(dir, ".env"), "VITE_PORT=3987\n");
      expect(devPort("development", dir, {})).toBe(3987);
      expect(devPort("development", dir, { VITE_PORT: "3555" })).toBe(3555);
      expect(devPort("development", empty, {})).toBe(3000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
