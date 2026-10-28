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
import { checkBaseRef, workTreeRoot } from "./repos";

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

/** A repository with one commit on `main`, and the directory of a bare clone that fetched it. */
const withCommit = () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-baseref-"));
  const git = (cwd: string, args: string) =>
    execSync(
      `git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${args}`,
      { cwd, stdio: "ignore" },
    );
  git(dir, "init -q -b main");
  git(dir, "commit -q --allow-empty -m first");
  git(dir, "branch feature");
  // The factory's clone holds the base ref as a remote-tracking ref, never as a branch (RepoMirror).
  const mirror = mkdtempSync(join(tmpdir(), "factory-baseref-mirror-"));
  git(mirror, "init -q --bare");
  git(mirror, `fetch -q ${dir} +refs/heads/main:refs/remotes/origin/main`);
  return { dir: realpathSync(dir), mirror };
};

describe("checkBaseRef (E8)", () => {
  const { dir, mirror } = withCommit();
  const check = (
    ref: string,
    where: { workTree?: string; mirrorPath?: string },
  ) =>
    Effect.runPromise(
      checkBaseRef({
        ref,
        workTree: where.workTree,
        mirrorPath: where.mirrorPath,
      }),
    );

  /** Mutation: ask for a branch that is not there, and call it ok anyway. */
  it("resolves a branch the checkout has, and says which commit", async () => {
    const answer = await check("main", { workTree: dir });
    expect(answer.status).toBe("ok");
    expect(answer.message).toMatch(/^main resolves to [0-9a-f]{7}$/);
    expect((await check("feature", { workTree: dir })).status).toBe("ok");
  });

  it("is unresolved for a ref the checkout does not have, naming it and the checkout", async () => {
    const answer = await check("trunk", { workTree: dir });
    expect(answer.status).toBe("unresolved");
    expect(answer.message).toBe(`no commit named trunk in ${dir}`);
  });

  /** Mutation: ask a ref that starts with a dash as an option. */
  it("does not read a ref that looks like an option as one", async () => {
    expect((await check("--all", { workTree: dir })).status).toBe("unresolved");
  });

  /** Mutation: look for a local branch in the clone, which never has one. */
  it("asks the factory's clone for the remote-tracking ref it is fetched into", async () => {
    expect((await check("main", { mirrorPath: mirror })).status).toBe("ok");
    const missing = await check("feature", { mirrorPath: mirror });
    expect(missing.status).toBe("unresolved");
    expect(missing.message).toBe(`the clone ${mirror} has no feature`);
  });

  it("prefers the checkout when a repo has both", async () => {
    const answer = await check("feature", {
      workTree: dir,
      mirrorPath: mirror,
    });
    expect(answer.status).toBe("ok");
  });

  it("is no_checkout, not unresolved, for a repo with nothing to ask", async () => {
    expect((await check("main", {})).status).toBe("no_checkout");
  });
});
