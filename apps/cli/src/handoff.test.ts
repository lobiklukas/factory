/**
 * What `factory handoff` reads from a checkout (S-local-agent-handoff-mcp, `./handoff`): the work in
 * progress — a local commit, a staged edit, an unstaged edit and an untracked file — as one patch
 * against the remote's default branch, which applied to a fresh clone of the remote gives exactly
 * the local working tree; the operator's own index untouched; and the refusals, the cap's first.
 *
 * Real git, in temporary directories: a bare repository stands in for the remote, so nothing leaves
 * the machine.
 */
import { BunServices } from "@effect/platform-bun";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  handoffPatchWireBytes,
  MAX_HANDOFF_PATCH_BYTES,
} from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import {
  collectHandoff,
  handoffCardText,
  repoFromRemoteUrl,
  type CollectedHandoff,
} from "./handoff";

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  input?: string,
): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "handoff",
      GIT_AUTHOR_EMAIL: "handoff@localhost",
      GIT_COMMITTER_NAME: "handoff",
      GIT_COMMITTER_EMAIL: "handoff@localhost",
    },
  }).trim();

/** A remote with `main` (README, src.txt), and a clone of it on a feature branch, still clean. */
const fixture = () => {
  const remote = mkdtempSync(join(tmpdir(), "factory-handoff-remote-"));
  const seed = mkdtempSync(join(tmpdir(), "factory-handoff-seed-"));
  git(remote, ["init", "-q", "--bare", "-b", "main"]);
  git(seed, ["init", "-q", "-b", "main"]);
  writeFileSync(join(seed, "README.md"), "handoff\n");
  writeFileSync(join(seed, "src.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(seed, ".gitignore"), "build/\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "init"]);
  git(seed, ["push", "-q", remote, "main"]);
  const local = mkdtempSync(join(tmpdir(), "factory-handoff-local-"));
  git(local, ["clone", "-q", remote, "."]);
  git(local, ["remote", "set-url", "origin", remote]);
  git(local, ["checkout", "-q", "-b", "feature/retry"]);
  const base = git(local, ["rev-parse", "origin/main"]);
  return { remote, local, base };
};

const collect = (input: Parameters<typeof collectHandoff>[0]) =>
  Effect.runPromise(
    collectHandoff(input).pipe(Effect.provide(BunServices.layer)),
  );

const refusal = (input: Parameters<typeof collectHandoff>[0]) =>
  Effect.runPromise(
    collectHandoff(input).pipe(Effect.flip, Effect.provide(BunServices.layer)),
  );

describe("collectHandoff (S-local-agent-handoff-mcp)", () => {
  /**
   * Mutations this catches: diff `HEAD` rather than the working tree — the unstaged edit and the
   * untracked file are missing; diff the operator's index — the unstaged edit is missing and
   * `git add` touched their staging; diff from `HEAD` rather than the merge base — the local commit
   * is missing; drop `--binary`/`--full-index` — the binary file does not apply.
   */
  it("takes every kind of local work as one patch against the remote's default branch, and leaves the index alone", async () => {
    const { local, remote, base } = fixture();
    // A local commit, then a staged edit, an unstaged edit, an untracked text file, an untracked
    // binary file, and an ignored build output that must stay out.
    writeFileSync(join(local, "committed.txt"), "committed locally\n");
    git(local, ["add", "committed.txt"]);
    git(local, ["commit", "-q", "-m", "local commit"]);
    writeFileSync(join(local, "README.md"), "handoff, staged\n");
    git(local, ["add", "README.md"]);
    writeFileSync(join(local, "src.txt"), "one\ntwo, unstaged\nthree\n");
    writeFileSync(join(local, "notes.md"), "untracked\n");
    writeFileSync(join(local, "blob.bin"), Buffer.from([0, 1, 2, 255, 0, 7]));
    execFileSync("mkdir", ["-p", join(local, "build")]);
    writeFileSync(join(local, "build", "out.js"), "ignored\n");
    const stagedBefore = git(local, ["diff", "--cached", "--name-only"]);

    const collected = await collect({ cwd: join(local) });

    expect(collected.baseRef).toBe("main");
    expect(collected.handoff.baseCommit).toBe(base);
    expect(collected.handoff.branch).toBe("feature/retry");
    expect([...collected.files].sort()).toEqual([
      "README.md",
      "blob.bin",
      "committed.txt",
      "notes.md",
      "src.txt",
    ]);
    expect(collected.bytes).toBe(
      new TextEncoder().encode(collected.handoff.patch).length,
    );
    // The operator's staging is exactly what it was.
    expect(git(local, ["diff", "--cached", "--name-only"])).toBe(stagedBefore);
    expect(git(local, ["status", "--porcelain", "--", "notes.md"])).toBe(
      "?? notes.md",
    );

    // The same work: applied to a fresh clone of the remote's base, the tree is the local one.
    const fresh = mkdtempSync(join(tmpdir(), "factory-handoff-fresh-"));
    git(fresh, ["clone", "-q", remote, "."]);
    git(fresh, ["apply", "--index", "-"], collected.handoff.patch);
    git(local, ["add", "-A"]);
    expect(git(fresh, ["write-tree"])).toBe(git(local, ["write-tree"]));
  }, 60_000);

  /** Mutations this catches: a default base that is not the remote's — `--base` is ignored. */
  it("takes the patch against the base it is told to, and names that base", async () => {
    const { local } = fixture();
    const release = git(local, ["rev-parse", "HEAD"]);
    git(local, ["branch", "release", release]);
    writeFileSync(join(local, "notes.md"), "untracked\n");
    const collected = await collect({ cwd: local, base: "release" });
    expect(collected.baseRef).toBe("release");
    expect(collected.handoff.baseCommit).toBe(release);
    expect(collected.files).toEqual(["notes.md"]);
  }, 60_000);

  /**
   * Mutations this catches: drop the cap — a patch over it is sent; count characters rather than
   * bytes; hold the whole diff in memory past the cap — `stdout` is the whole patch; reword the
   * refusal — the CLI and the server no longer say the same thing.
   */
  it("refuses a patch over the cap with its size and the cap, before sending anything", async () => {
    const { local } = fixture();
    writeFileSync(
      join(local, "big.txt"),
      `${"x".repeat(MAX_HANDOFF_PATCH_BYTES)}\n`,
    );
    const refused = await refusal({ cwd: local });
    expect(refused._tag).toBe("HandoffRefused");
    expect(refused.message).toMatch(
      new RegExp(
        `^the handoff patch is \\d+ bytes as a card carries it, over the ${MAX_HANDOFF_PATCH_BYTES}-byte cap: commit and push the work to a branch and hand off from it \\(--base\\), or hand off a smaller change$`,
      ),
    );
    const bytes = Number(/is (\d+) bytes/.exec(refused.message)?.[1]);
    expect(bytes).toBeGreaterThan(MAX_HANDOFF_PATCH_BYTES);

    // A cap of its own (a test's) is held the same way, and a patch exactly at it passes. The cap
    // counts the patch as the request carries it: escaped, so larger than its bytes on disk.
    writeFileSync(join(local, "big.txt"), "small\n");
    const fits = await collect({ cwd: local });
    const wire = handoffPatchWireBytes(fits.handoff.patch);
    expect(wire).toBeGreaterThan(fits.bytes);
    const atCap = await collect({ cwd: local, maxBytes: wire });
    expect(atCap.bytes).toBe(fits.bytes);
    const over = await refusal({ cwd: local, maxBytes: wire - 1 });
    expect(over.message).toBe(
      `the handoff patch is ${wire} bytes as a card carries it, over the ${wire - 1}-byte cap`,
    );
  }, 60_000);

  /**
   * Mutations this catches: count the patch's raw bytes — an ESC-heavy file at the cap in bytes
   * passes, and its request overruns the API's limit (six bytes per ESC once escaped).
   */
  it("counts the patch escaped, so an escape-heavy one is held to the request it makes", async () => {
    const { local } = fixture();
    writeFileSync(join(local, "ansi.log"), `${"\u001b[0m".repeat(200)}\n`);
    const fits = await collect({ cwd: local });
    const refused = await refusal({ cwd: local, maxBytes: fits.bytes });
    expect(refused.message).toBe(
      `the handoff patch is ${handoffPatchWireBytes(fits.handoff.patch)} bytes as a card carries it, over the ${fits.bytes}-byte cap`,
    );
  }, 60_000);

  /**
   * Mutations this catches: decode git's output leniently — a Latin-1 file travels with U+FFFD in
   * place of its bytes and the run gets a different file; refuse every non-ASCII byte — the UTF-8
   * file is refused too.
   */
  it("refuses a text file that is not UTF-8, naming it, and carries a UTF-8 one byte for byte", async () => {
    const { local, remote } = fixture();
    writeFileSync(join(local, "utf8.txt"), "café ☕\n");
    const fits = await collect({ cwd: local });
    const fresh = mkdtempSync(join(tmpdir(), "factory-handoff-fresh-"));
    git(fresh, ["clone", "-q", remote, "."]);
    git(fresh, ["apply", "--index", "-"], fits.handoff.patch);
    expect(readFileSync(join(fresh, "utf8.txt"))).toEqual(
      readFileSync(join(local, "utf8.txt")),
    );

    writeFileSync(join(local, "latin1.txt"), Buffer.from([99, 97, 102, 233, 10]));
    const refused = await refusal({ cwd: local });
    expect(refused.message).toBe(
      "latin1.txt is a text file that is not UTF-8, which a handoff patch cannot carry byte for byte: commit and push the work to a branch and hand off from it (--base), or convert it to UTF-8",
    );
  }, 60_000);

  /**
   * Mutations this catches: ignore `untracked: false` — the stray untracked file travels; leave the
   * tracked edits out with it — the edit is missing.
   */
  it("leaves untracked files out when told to, and keeps every tracked change", async () => {
    const { local } = fixture();
    writeFileSync(join(local, "src.txt"), "one\ntwo, unstaged\nthree\n");
    writeFileSync(join(local, ".env.local"), "TOKEN=local\n");
    const all = await collect({ cwd: local });
    expect([...all.files].sort()).toEqual([".env.local", "src.txt"]);
    const tracked = await collect({ cwd: local, untracked: false });
    expect(tracked.files).toEqual(["src.txt"]);
    expect(tracked.handoff.patch).not.toContain("TOKEN=local");
  }, 60_000);

  it("refuses a clean tree, a directory that is no checkout, and a base the checkout lacks", async () => {
    const { local } = fixture();
    const clean = await refusal({ cwd: local });
    expect(clean.message).toContain("there is no work to hand off");
    const outside = await refusal({
      cwd: mkdtempSync(join(tmpdir(), "factory-handoff-none-")),
    });
    expect(outside.message).toContain("is not inside a git checkout");
    writeFileSync(join(local, "notes.md"), "untracked\n");
    const unknown = await refusal({ cwd: local, base: "nope" });
    expect(unknown.message).toContain("the base nope is not a branch");
  }, 60_000);
});

describe("repoFromRemoteUrl", () => {
  it("reads owner/name from https and scp-style URLs, and nothing from a path", () => {
    expect(repoFromRemoteUrl("https://github.com/acme/widget.git")).toBe(
      "acme/widget",
    );
    expect(repoFromRemoteUrl("git@github.com:acme/widget.git\n")).toBe(
      "acme/widget",
    );
    expect(repoFromRemoteUrl("ssh://git@github.com/acme/widget")).toBe(
      "acme/widget",
    );
    expect(repoFromRemoteUrl("/tmp/remote.git")).toBeUndefined();
    expect(
      repoFromRemoteUrl("https://gitlab.com/group/sub/widget"),
    ).toBeUndefined();
  });
});

describe("handoffCardText", () => {
  const collected: CollectedHandoff = {
    root: "/tmp/x",
    handoff: {
      patch: "diff --git a/a b/a\n",
      branch: "feature/retry",
      baseCommit: "a".repeat(40),
    },
    baseRef: "main",
    files: ["a.ts", "b.ts"],
    bytes: 1234,
  };

  /**
   * Mutations this catches: a body without the handoff paragraph — the run is never told its
   * worktree starts on the work; a title that ignores the note.
   */
  it("titles the card from the note and tells every run what it starts on", () => {
    const text = handoffCardText({
      collected,
      note: "Finish the retry loop\nThe tests are the spec.",
    });
    expect(text.title).toBe("Finish the retry loop");
    expect(text.body).toBe(
      [
        "Finish the retry loop\nThe tests are the spec.",
        "",
        `Handed off from a local checkout on \`feature/retry\`, taken against \`${"a".repeat(40)}\` (base \`main\`): 2 files, 1234 bytes.`,
        "The run's worktree starts with that work committed on its branch: continue it rather than redo it.",
        "",
        "- a.ts",
        "- b.ts",
      ].join("\n"),
    );
    expect(handoffCardText({ collected, title: " Named " }).title).toBe(
      "Named",
    );
    expect(handoffCardText({ collected }).title).toBe("Continue feature/retry");
  });
});
