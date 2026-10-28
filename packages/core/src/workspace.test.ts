/**
 * `resolveWorkspace`'s worktree cut hands the base ref to git as an argv entry, never through a
 * shell (LOB-260): a session's or a card's base ref is stored text, and a shell would expand
 * `$(...)` inside the double quotes `JSON.stringify` puts around it.
 */
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Path } from "effect";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RepoSlug } from "@repo/domain/Session";
import { resolveWorkspace } from "./workspace";

const root = mkdtempSync(join(tmpdir(), "workspace-argv-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  }).trim();

const cut = (localPath: string, sessionId: string, baseRef: string) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* resolveWorkspace(
        {
          sessionRoot: join(root, "sessions"),
          sessionId,
          repo: RepoSlug.make("factory-test/argv"),
          localPath,
          baseRef,
        },
        { fs, path },
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

describe("resolveWorkspace's worktree cut (LOB-260)", () => {
  /** Mutation: put the `git worktree add -b` line back through `execSync` — the marker is touched. */
  it("passes the base ref to git as one argument, so a shell substitution in it never runs", async () => {
    const local = join(root, "checkout");
    git(root, "init", "-q", "-b", "main", local);
    writeFileSync(join(local, "README.md"), "seed\n");
    git(local, "add", "README.md");
    git(local, "commit", "-q", "-m", "seed");
    const marker = join(root, "touched");

    const refused = await cut(local, "ses_argv_injected", `$(touch ${marker})`);
    expect(Exit.isFailure(refused)).toBe(true);
    expect(existsSync(marker)).toBe(false);

    const made = await cut(local, "ses_argv_main", "main");
    expect(Exit.isSuccess(made)).toBe(true);
    if (Exit.isSuccess(made)) {
      expect(git(made.value.path, "rev-parse", "HEAD")).toBe(
        git(local, "rev-parse", "main"),
      );
    }
  });
});

describe("resolveWorkspace's commands (S-env-setup)", () => {
  /**
   * A checkout registered at a subdirectory of its work tree — a verify skill's fixture inside the
   * factory's monorepo — reads its own config from that place in the session's worktree, not the
   * enclosing repo's root config. Mutation: read `directory` alone again — `install` is the root's.
   */
  it("reads a subdirectory checkout's config at its place in the worktree, not the root's", async () => {
    const mono = join(root, "mono");
    git(root, "init", "-q", "-b", "main", mono);
    mkdirSync(join(mono, ".factory"), { recursive: true });
    writeFileSync(
      join(mono, ".factory", "config"),
      JSON.stringify({ install: "bun install" }),
    );
    const fixture = join(mono, "fixtures", "repo");
    mkdirSync(join(fixture, ".factory"), { recursive: true });
    writeFileSync(
      join(fixture, ".factory", "config"),
      JSON.stringify({ verify: "fixture-verify" }),
    );
    git(mono, "add", "-A");
    git(mono, "commit", "-q", "-m", "seed");

    const sub = await cut(fixture, "ses_sub_config", "main");
    const top = await cut(mono, "ses_root_config", "main");
    expect(Exit.isSuccess(sub) && sub.value.commands).toEqual({
      verify: "fixture-verify",
    });
    expect(Exit.isSuccess(top) && top.value.commands).toEqual({
      install: "bun install",
    });
  });
});
