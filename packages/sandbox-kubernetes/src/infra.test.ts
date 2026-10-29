/**
 * The sandbox image's build context (LOB-90) leaves credentials out whichever builder reads it:
 * BuildKit reads `infra/sandbox/Dockerfile.dockerignore`, the legacy builder only the root
 * `.dockerignore`, so both must hold the same patterns, `.env` files first.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");

const patterns = (file: string): ReadonlyArray<string> =>
  readFileSync(join(ROOT, file), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

describe("the sandbox image's build context", () => {
  it("leaves the same files out for BuildKit and for the legacy builder, every .env among them", () => {
    const buildKit = patterns("infra/sandbox/Dockerfile.dockerignore");
    expect(patterns(".dockerignore")).toEqual(buildKit);
    expect(buildKit).toEqual(
      expect.arrayContaining(["**/.env", "**/.env.*", ".git", ".verify"]),
    );
  });
});
