/**
 * The checkout probe behind the repo registry (LOB-253): which work tree a path is inside, and that
 * asking does not hold the event loop. `SessionService.test.ts` drives the same probe through
 * `registerRepo`, `listRepos` and `getRepo` against Postgres; these cases need no database.
 */
import { Effect } from "effect";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workTreeRoot } from "./repos";

const checkout = mkdtempSync(join(tmpdir(), "factory-repos-"));
execSync("git init -q -b main", { cwd: checkout, stdio: "ignore" });
const nested = join(checkout, "packages", "nested");
mkdirSync(nested, { recursive: true });

describe("workTreeRoot", () => {
  it("names a checkout's own root", async () => {
    expect(await Effect.runPromise(workTreeRoot(checkout))).toBe(
      realpathSync(checkout),
    );
  });

  it("names the enclosing root for a directory inside a checkout", async () => {
    expect(await Effect.runPromise(workTreeRoot(nested))).toBe(
      realpathSync(checkout),
    );
  });

  it("answers undefined for a plain directory, a missing one, and a .git directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "factory-repos-plain-"));
    const answers = await Effect.runPromise(
      Effect.all([
        workTreeRoot(plain),
        workTreeRoot(join(plain, "gone")),
        workTreeRoot(join(checkout, ".git")),
      ]),
    );
    expect(answers).toEqual([undefined, undefined, undefined]);
  });

  it("yields while git runs, so a second fiber is not held behind it", async () => {
    // With a synchronous probe the first fiber would finish before the second started.
    const order: string[] = [];
    await Effect.runPromise(
      Effect.all(
        [
          workTreeRoot(checkout).pipe(
            Effect.tap(() => Effect.sync(() => order.push("probe"))),
          ),
          Effect.sync(() => order.push("other")),
        ],
        { concurrency: 2 },
      ),
    );
    expect(order).toEqual(["other", "probe"]);
  });
});
