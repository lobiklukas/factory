/**
 * A repository's policy read at a base (S-factory-config-as-code, `./repoPolicy`): from a git
 * checkout's objects at a ref, never from its files on disk, and refused with a typed
 * `RepoPolicyRejected` when it is not a policy or would allow something the deployment denies.
 *
 * The fixtures are local git repos with no remote.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_AUTONOMY } from "@repo/harness";
import { Effect, Exit } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { decodePolicy, readRepoPolicy } from "./repoPolicy";

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

describe("readRepoPolicy at a base", () => {
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

  it("reads a subdirectory checkout's config under its prefix", async () => {
    const checkout = fixtureRepo({
      "fixtures/app/.factory/config": config({ deny: ["rm -rf"] }),
    });
    const exit = await read(checkout, "main", "fixtures/app");
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      source: { path: "fixtures/app/.factory/config", found: true },
      policy: { denied: ["rm -rf"] },
    });
  });

  it("answers unread for a ref that names no commit", async () => {
    const exit = await read(fixtureRepo({}), "no-such-branch");
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      _tag: "unread",
      problem: expect.stringContaining("no-such-branch names no commit"),
    });
  });
});

describe("a policy that cannot be loaded is a typed RepoPolicyRejected", () => {
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
      ".factory/config": config({ allowedHosts: ["github.com", "evil.example"] }),
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
    expect(error).toMatchObject({ kind: "invalid" });
    expect(error.reasons[0]).toContain("pushRefPrefixes");
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
    ).toMatchObject({ kind: "unreadable", reasons: [".factory/config is not JSON"] });
    expect(
      await rejection({ ".factory/config": "[]" }),
    ).toMatchObject({ kind: "unreadable" });
  });
});

describe("decodePolicy", () => {
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
