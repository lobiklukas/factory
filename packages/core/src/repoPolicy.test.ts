/**
 * A repository's policy read at a base (S-factory-config-as-code, `./repoPolicy`): from a git
 * checkout's objects at a ref, never from its files on disk, and refused with a typed
 * `RepoPolicyRejected` when it is not a policy or would allow something the deployment denies.
 *
 * The fixtures are local git repos with no remote. Each case makes its own, which under the whole
 * gate's load takes seconds rather than milliseconds, so the suites allow 30 s a case.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { DEFAULT_AUTONOMY } from "@repo/harness";
import { Effect, Exit, FileSystem, Path } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { decodePolicy, readRepoPolicy } from "./repoPolicy";
import { workTreePrefix } from "./workspace";

const scratch = mkdtempSync(join(tmpdir(), "factory-core-repo-policy-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (root: string, command: string) =>
  execSync(command, { cwd: root, stdio: "ignore" });

let fixtures = 0;
/** A checkout with `files` committed on `main`. */
const fixtureRepo = (files: Record<string, string>): string => {
  fixtures += 1;
  const root = join(scratch, `repo-${fixtures}`);
  mkdirSync(root, { recursive: true });
  git(root, "git init -q -b main");
  git(root, "git config user.email policy@localhost");
  git(root, "git config user.name policy");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  git(root, "git add -A");
  git(root, "git commit -q --allow-empty -m base");
  return root;
};

const read = (checkout: string, ref = "main", prefix = "") =>
  Effect.runPromiseExit(
    readRepoPolicy(
      { repo: "acme/widgets", checkout, prefix, ref },
      DEFAULT_AUTONOMY,
    ),
  );

const config = (policy: unknown) =>
  JSON.stringify({ install: "bun install", policy });

describe("readRepoPolicy at a base", { timeout: 30_000 }, () => {
  /** Mutation: read the policy block's keys under other names — the gate is lost. */
  it("reads the policy block's gates, deny list and hosts, and says where it read them", async () => {
    const checkout = fixtureRepo({
      ".factory/config": config({
        approvalRequired: [" bun publish "],
        deny: ["terraform destroy"],
        allowedHosts: ["github.com"],
      }),
    });
    const exit = await read(checkout);
    const commit = execSync("git rev-parse main", {
      cwd: checkout,
      encoding: "utf8",
    }).trim();
    expect(exit).toEqual(
      Exit.succeed({
        _tag: "read",
        source: { ref: "main", commit, path: ".factory/config", found: true },
        policy: {
          approvalRequired: ["bun publish"],
          denied: ["terraform destroy"],
          allowedHosts: ["github.com"],
        },
      }),
    );
  });

  /** Mutation: read `.factory/config` from the checkout's files — the uncommitted edit wins. */
  it("reads the commit, not the files on disk: an uncommitted edit is not the policy", async () => {
    const checkout = fixtureRepo({
      ".factory/config": config({ approvalRequired: ["bun publish"] }),
    });
    writeFileSync(join(checkout, ".factory/config"), config({}));
    git(checkout, "git checkout -q -b relaxed");
    git(checkout, "git commit -q -am relaxed");
    const atMain = await read(checkout, "main");
    const atRelaxed = await read(checkout, "relaxed");
    expect(Exit.isSuccess(atMain) && atMain.value).toMatchObject({
      policy: { approvalRequired: ["bun publish"] },
    });
    expect(Exit.isSuccess(atRelaxed) && atRelaxed.value).toMatchObject({
      policy: { approvalRequired: [] },
    });
  });

  /** Mutation: treat a missing config as unread — a repo that declares nothing is never pinned. */
  it("reads a base with no config, or no policy block, as no policy", async () => {
    const bare = await read(fixtureRepo({ "README.md": "hi\n" }));
    expect(Exit.isSuccess(bare) && bare.value).toMatchObject({
      _tag: "read",
      source: { found: false, path: ".factory/config" },
      policy: { approvalRequired: [], denied: [] },
    });
    const commandsOnly = await read(
      fixtureRepo({ ".factory/config": JSON.stringify({ test: "true" }) }),
    );
    expect(Exit.isSuccess(commandsOnly) && commandsOnly.value).toMatchObject({
      _tag: "read",
      source: { found: true },
      policy: { approvalRequired: [], denied: [] },
    });
  });

  /**
   * Mutation: drop `--full-tree` from the ls-tree — git reads the pathspec relative to the
   * subdirectory, finds no `fixtures/app/fixtures/app/.factory/config`, and the policy is lost.
   */
  it("reads a subdirectory checkout's config under its prefix, as the service calls it", async () => {
    const root = fixtureRepo({
      "fixtures/app/.factory/config": config({ deny: ["rm -rf"] }),
    });
    // The service passes the registered path — the subdirectory — and its prefix in the work tree.
    const checkout = join(root, "fixtures/app");
    const prefix = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return yield* workTreePrefix(checkout, { fs, path });
      }).pipe(Effect.provide(BunServices.layer)),
    );
    expect(prefix).toBe("fixtures/app");
    const exit = await read(checkout, "main", prefix);
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      source: { path: "fixtures/app/.factory/config", found: true },
      policy: { denied: ["rm -rf"] },
    });
  });

  /**
   * Mutation: answer a config git cannot read as `unread` or as no config — the session runs with
   * the repo's gates dropped. Once the base names a commit, a config listed there that git cannot
   * read refuses the load, as unavailable rather than as a fault in the config.
   */
  it("refuses a base whose config git cannot read, rather than reading it as no policy", async () => {
    const checkout = fixtureRepo({
      ".factory/config": config({ approvalRequired: ["bun publish"] }),
    });
    const blob = execSync("git rev-parse main:.factory/config", {
      cwd: checkout,
      encoding: "utf8",
    }).trim();
    // The tree still lists the config; its object is gone, as a corrupt or unreadable store's is.
    rmSync(join(checkout, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    const exit = await read(checkout);
    if (Exit.isSuccess(exit)) throw new Error("expected a rejection");
    const failure = exit.cause.reasons[0];
    if (failure?._tag !== "Fail") throw new Error("expected a typed failure");
    expect(failure.error).toMatchObject({
      _tag: "RepoPolicyUnavailable",
      repo: "acme/widgets",
      ref: "main",
      message: expect.stringContaining("git could not read .factory/config"),
    });
  });

  /**
   * Mutation: answer every failed `rev-parse` as a ref that names no commit (`unread`) — a git that
   * fails or times out looking the base up opens the run under the deployment's policy alone.
   */
  it("refuses a base git could not look up, rather than answering unread", async () => {
    // Not a repository: `rev-parse` exits 128, not the 1 that says the ref names nothing.
    const notARepo = join(scratch, `plain-${fixtures}`);
    mkdirSync(notARepo, { recursive: true });
    const exit = await read(notARepo);
    if (Exit.isSuccess(exit)) throw new Error("expected a refusal");
    const failure = exit.cause.reasons[0];
    if (failure?._tag !== "Fail") throw new Error("expected a typed failure");
    expect(failure.error).toMatchObject({
      _tag: "RepoPolicyUnavailable",
      repo: "acme/widgets",
      ref: "main",
      message: expect.stringContaining("git could not look up main"),
    });
    expect(failure.error).not.toHaveProperty("commit");
  });

  it("answers unread for a ref that names no commit", async () => {
    const exit = await read(fixtureRepo({}), "no-such-branch");
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      _tag: "unread",
      problem: expect.stringContaining("no-such-branch names no commit"),
    });
  });
});

describe(
  "a policy that cannot be loaded is a typed RepoPolicyRejected",
  { timeout: 30_000 },
  () => {
    const rejection = async (files: Record<string, string>) => {
      const exit = await read(fixtureRepo(files));
      if (Exit.isSuccess(exit)) throw new Error("expected a rejection");
      const failure = exit.cause.reasons[0];
      if (failure?._tag !== "Fail") throw new Error("expected a typed failure");
      return failure.error;
    };

    /** Mutation: drop the `repoPolicyWidening` check — a host the deployment refuses loads. */
    it("refuses a host the deployment does not allow", async () => {
      const error = await rejection({
        ".factory/config": config({
          allowedHosts: ["github.com", "evil.example"],
        }),
      });
      expect(error._tag).toBe("RepoPolicyRejected");
      expect(error).toMatchObject({
        repo: "acme/widgets",
        ref: "main",
        path: ".factory/config",
        kind: "widens",
        reasons: [expect.stringContaining("allowedHosts names evil.example")],
      });
      expect(error.message).toContain("cannot be loaded");
    });

    /** Mutation: decode the block with excess keys ignored — `pushRefPrefixes` is silently dropped. */
    it("refuses a key it does not know, rather than dropping it", async () => {
      const error = await rejection({
        ".factory/config": config({ pushRefPrefixes: ["refs/heads/"] }),
      });
      expect(error).toMatchObject({
        kind: "invalid",
        reasons: [expect.stringContaining("pushRefPrefixes")],
      });
    });

    it("refuses a policy block of the wrong shape, and a config that is not JSON", async () => {
      expect(
        await rejection({
          ".factory/config": config({ approvalRequired: "bun publish" }),
        }),
      ).toMatchObject({ kind: "invalid" });
      expect(
        await rejection({ ".factory/config": config({ deny: ["  "] }) }),
      ).toMatchObject({ kind: "invalid" });
      expect(
        await rejection({ ".factory/config": config("deny everything") }),
      ).toMatchObject({ kind: "invalid" });
      expect(
        await rejection({ ".factory/config": "{ policy: oops" }),
      ).toMatchObject({
        kind: "unreadable",
        reasons: [".factory/config is not JSON"],
      });
      expect(await rejection({ ".factory/config": "[]" })).toMatchObject({
        kind: "unreadable",
      });
    });
  },
);

describe("decodePolicy", () => {
  it("fails with a tagged RepoConfigUndecodable", async () => {
    const exit = await Effect.runPromiseExit(decodePolicy("{ nope"));
    if (Exit.isSuccess(exit)) throw new Error("expected a failure");
    const failure = exit.cause.reasons[0];
    if (failure?._tag !== "Fail") throw new Error("expected a typed failure");
    expect(failure.error).toMatchObject({
      _tag: "RepoConfigUndecodable",
      kind: "unreadable",
    });
  });

  it("reads an empty block as no policy, and keeps an empty allowlist as no egress", async () => {
    expect(await Effect.runPromise(decodePolicy(config({})))).toEqual({
      approvalRequired: [],
      denied: [],
    });
    expect(
      await Effect.runPromise(decodePolicy(config({ allowedHosts: [] }))),
    ).toEqual({ approvalRequired: [], denied: [], allowedHosts: [] });
  });
});
