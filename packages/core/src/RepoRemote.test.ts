/**
 * Which base a session's branch is measured against, and which forge URL a registration reaches
 * (C17). Real git in a scratch repository; no network, no database.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoSlug } from "@repo/domain/Session";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { forgeUrlFor, githubUrlOfRemote, measureBaseOf } from "./RepoRemote";

// oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
// oxlint-disable-next-line effecttsgo/process-env -- as above.
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";

/**
 * Each case spawns git a dozen times or more, and `bun run test` runs every package's suites at once,
 * so a case's wall clock is mostly the machine's load: the slowest here took 3.5 s alone and 15 s beside a full
 * `bun run test`. vitest's 5 s default is under that,
 * so these cases carry a budget sized to the work instead (DEFLAKE).
 */
const GIT_CASES = { timeout: 60_000 };

const roots: Array<string> = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  // Removing every case's checkouts outran vitest's 10 s hook default on a loaded machine (DEFLAKE).
}, 60_000);

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

const commit = (cwd: string, file: string): string => {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
};

/** A checkout with `main` at A, and B a child of A that `main` does not have. */
const checkout = () => {
  const root = mkdtempSync(join(tmpdir(), "factory-measure-base-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  const a = commit(root, "A.md");
  git(root, "checkout", "-q", "-b", "elsewhere");
  const b = commit(root, "B.md");
  git(root, "checkout", "-q", "main");
  git(root, "branch", "-q", "-D", "elsewhere");
  return { root, a, b };
};

const measure = (directory: string, head: string) =>
  Effect.runPromise(measureBaseOf({ directory, base: "main", head }));

const diffNames = (cwd: string, range: string): string =>
  git(cwd, "diff", "--name-only", range);

describe("measureBaseOf", GIT_CASES, () => {
  /**
   * Mutation: measure against the local base whatever was fetched — the forge's B is counted as
   * the run's change, and an empty run measures non-empty.
   */
  it("answers the fetched tip for a branch cut from it while the local base is behind", async () => {
    const { root, b } = checkout();
    git(root, "update-ref", "refs/remotes/factory/main", b);
    git(root, "branch", "-q", "factory/s1", b);
    const base = await measure(root, "factory/s1");
    expect(base).toBe("refs/remotes/factory/main");
    expect(diffNames(root, `${base}...factory/s1`)).toBe("");
    // What the board measured before: the forge's own commit, as if it were the run's.
    expect(diffNames(root, "main...factory/s1")).toBe("B.md");
  });

  /**
   * Mutation: answer the tracking ref whenever it exists — the operator's pulled commit is counted
   * as the session's, and the PR body lists a file the run never touched.
   */
  it("answers the local base for a branch cut from it beside a stale tracking ref", async () => {
    const { root, a } = checkout();
    git(root, "update-ref", "refs/remotes/factory/main", a);
    const pulled = commit(root, "PULLED.md");
    git(root, "branch", "-q", "factory/s2", pulled);
    git(root, "checkout", "-q", "factory/s2");
    commit(root, "RUN.md");
    git(root, "checkout", "-q", "main");
    const base = await measure(root, "factory/s2");
    expect(base).toBe("main");
    expect(diffNames(root, `${base}...factory/s2`)).toBe("RUN.md");
  });

  it("answers the base when nothing was fetched, and the tracking ref when there is no local base", async () => {
    const { root, b } = checkout();
    git(root, "branch", "-q", "factory/s3", "main");
    expect(await measure(root, "factory/s3")).toBe("main");
    git(root, "update-ref", "refs/remotes/factory/main", b);
    git(root, "branch", "-q", "factory/s4", b);
    git(root, "checkout", "-q", "factory/s4");
    git(root, "branch", "-q", "-D", "main");
    expect(await measure(root, "factory/s4")).toBe("refs/remotes/factory/main");
  });

  /**
   * A git slower than a probe's five seconds is still waited for: a loaded machine took that long
   * over a local `merge-base`, and the question it timed out on answered the local base (DEFLAKE).
   * The `git` first on `PATH` naps 6 s before `--is-ancestor`, and runs the real one.
   *
   * Mutation: drop `patient` from the `--is-ancestor` question — the answer is `main`.
   */
  it("waits for a slow git rather than reading its silence as the local base", async () => {
    const { root, b } = checkout();
    git(root, "update-ref", "refs/remotes/factory/main", b);
    git(root, "branch", "-q", "factory/s5", b);
    const real = execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    const bin = mkdtempSync(join(tmpdir(), "factory-slow-git-"));
    roots.push(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *--is-ancestor*) sleep 6 ;; esac\nexec "${real}" "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    // oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
    const path = process.env["PATH"];
    // oxlint-disable-next-line effecttsgo/process-env -- as above.
    process.env["PATH"] = `${bin}:${path ?? ""}`;
    try {
      expect(await measure(root, "factory/s5")).toBe(
        "refs/remotes/factory/main",
      );
    } finally {
      // oxlint-disable-next-line effecttsgo/process-env -- as above.
      process.env["PATH"] = path;
    }
  });

  it("answers the base for a head that does not resolve, so the measurement fails on its own terms", async () => {
    const { root, b } = checkout();
    git(root, "update-ref", "refs/remotes/factory/main", b);
    expect(await measure(root, "factory/missing")).toBe("main");
  });
});

describe("githubUrlOfRemote", () => {
  const repo = RepoSlug.make("acme/app");
  const https = "https://github.com/acme/app.git";

  it("reads the spellings git clone leaves behind, and always answers https", () => {
    for (const remote of [
      "https://github.com/acme/app.git",
      "https://github.com/acme/app",
      "https://github.com/Acme/App.git/",
      "git@github.com:acme/app.git",
      "github.com:acme/app",
      "ssh://git@github.com/acme/app.git",
      "ssh://git@github.com:22/acme/app",
    ])
      expect(githubUrlOfRemote(repo, remote), remote).toBe(https);
  });

  /** Mutation: accept any host or any repo — a fork's or another forge's remote is sent the token. */
  it("answers nothing for another host, another repository, a credential, or a local path", () => {
    for (const remote of [
      "https://github.com/acme/fork.git",
      "https://gitlab.com/acme/app.git",
      "https://x-access-token:secret@github.com/acme/app.git",
      "http://github.com/acme/app.git",
      "git@example.com:acme/app.git",
      "/srv/git/acme/app.git",
      "file:///srv/git/acme/app.git",
      "",
    ])
      expect(githubUrlOfRemote(repo, remote), remote).toBeUndefined();
  });
});

describe("forgeUrlFor", GIT_CASES, () => {
  const repo = RepoSlug.make("acme/app");
  const withOrigin = (origin: string): string => {
    const root = mkdtempSync(join(tmpdir(), "factory-forge-url-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "remote", "add", "origin", origin);
    return root;
  };
  const urlFor = (url: string, local: string | null) =>
    Effect.runPromise(forgeUrlFor(repo, url, local));

  /**
   * Mutation: read only the registry's URL — the `factory repo add <slug> --path <dir>` operators
   * are told to run pushes nothing, and GitHub refuses the PR for a head it does not have.
   */
  it("derives the GitHub URL from a URL-less registration's checkout whose origin names the repo", async () => {
    expect(await urlFor("", withOrigin("git@github.com:acme/app.git"))).toBe(
      "https://github.com/acme/app.git",
    );
  });

  it("keeps a registered URL it accepts, and second-guesses none it refuses", async () => {
    const local = withOrigin("https://github.com/acme/app.git");
    expect(await urlFor("http://127.0.0.1:9/acme/app.git", local)).toBe(
      "http://127.0.0.1:9/acme/app.git",
    );
    expect(
      await urlFor("https://gitlab.com/acme/app.git", local),
    ).toBeUndefined();
  });

  it("answers nothing with no checkout, or one whose origin is not the repo on GitHub", async () => {
    expect(await urlFor("", null)).toBeUndefined();
    expect(await urlFor("", withOrigin("/srv/git/app.git"))).toBeUndefined();
    expect(
      await urlFor("", withOrigin("https://github.com/acme/other.git")),
    ).toBeUndefined();
  });
});
