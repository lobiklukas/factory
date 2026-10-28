/**
 * Which secrets a session's commands are given (S-agent-secrets): the names `.factory/config`
 * declares at the base — never the run's branch — and the store's values for them.
 */
import { BunServices } from "@effect/platform-bun";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Path, Redacted } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { RepoSlug } from "@repo/domain/Session";
import type { SecretServiceShape } from "./SecretService";
import { grantSecrets, secretNeedsAt } from "./secretNeeds";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });

const writeConfig = (root: string, config: unknown) => {
  mkdirSync(join(root, ".factory"), { recursive: true });
  writeFileSync(join(root, ".factory", "config"), JSON.stringify(config));
};

const needsAt = (directory: string, ref: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* secretNeedsAt({ directory, ref }, { fs, path });
    }).pipe(Effect.provide(BunServices.layer)),
  );

describe("secretNeedsAt", () => {
  it("reads the declaration at the base, whatever the branch's config says", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-needs-"));
    dirs.push(root);
    git(root, "init", "-q", "-b", "main");
    writeConfig(root, {
      verify: "true",
      secrets: { verify: ["TEST_API_KEY"], setup: ["NPM_TOKEN"] },
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "work");
    // The run's branch asks for one more, committed and in the worktree alike.
    writeConfig(root, {
      verify: "true",
      secrets: { verify: ["TEST_API_KEY", "DEPLOY_TOKEN"] },
    });
    git(root, "commit", "-qam", "ask for more");

    expect(await needsAt(root, "main")).toEqual({
      verify: ["TEST_API_KEY"],
      setup: ["NPM_TOKEN"],
    });
    expect(await needsAt(root, "no-such-ref")).toBeUndefined();
  });
});

describe("grantSecrets", () => {
  const repo = RepoSlug.make("needs/repo");
  const store = (stored: Record<string, string>, unreadable: string[] = []) => {
    const asked: Array<readonly string[] | undefined> = [];
    const shape: SecretServiceShape = {
      configured: true,
      set: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
      reveal: (_repo, names) =>
        Effect.sync(() => {
          asked.push(names);
          return {
            values: Object.entries(stored)
              .filter(([name]) => names === undefined || names.includes(name))
              .map(([name, value]) => ({ name, value: Redacted.make(value) })),
            unreadable,
          };
        }),
    };
    return { shape, asked };
  };

  it("gives each step its declared names only, and names those the store does not hold", async () => {
    const { shape, asked } = store(
      {
        TEST_API_KEY: "fake-verify-value-1",
        NPM_TOKEN: "fake-setup-value-22",
        UNDECLARED: "fake-never-given-333",
      },
      ["BROKEN"],
    );
    const granted = await Effect.runPromise(
      grantSecrets(shape, repo, {
        verify: ["TEST_API_KEY", "MISSING"],
        setup: ["NPM_TOKEN", "BROKEN"],
      }),
    );
    expect(asked).toEqual([["NPM_TOKEN", "BROKEN", "TEST_API_KEY", "MISSING"]]);
    expect(granted.verify.values.map((secret) => secret.name)).toEqual([
      "TEST_API_KEY",
    ]);
    expect(granted.verify.missing).toEqual(["MISSING"]);
    expect(granted.setup.values.map((secret) => secret.name)).toEqual([
      "NPM_TOKEN",
    ]);
    expect(granted.setup.missing).toEqual(["BROKEN"]);
    expect(granted.all.map((secret) => secret.name).sort()).toEqual([
      "NPM_TOKEN",
      "TEST_API_KEY",
    ]);
  });

  it("asks the store nothing when nothing is declared", async () => {
    const { shape, asked } = store({ TEST_API_KEY: "fake-verify-value-1" });
    const granted = await Effect.runPromise(grantSecrets(shape, repo, {}));
    expect(asked).toEqual([]);
    expect(granted.all).toEqual([]);
  });
});
