/**
 * Reading what a repository tells a run (S-repo-instructions-and-skills) from a real git checkout:
 * `AGENTS.md` and the `.pi/skills` / `.agents/skills` index at the base's commit — never the
 * worktree's uncommitted or branch-only edits — bounded, and answering nothing rather than failing.
 *
 * The fixtures are local repositories with no remote.
 */
import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
  parseTreeEntries,
  readRepoContext,
  REPO_INSTRUCTIONS_READ_BYTES,
  symlinkTargetInRepo,
} from "./repoContext";

const scratch = mkdtempSync(join(tmpdir(), "factory-core-repo-context-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const git = (root: string, command: string): string =>
  execSync(command, { cwd: root, encoding: "utf8" }).trim();

const write = (root: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
};

/** A checkout with `files` committed on `main`. */
const fixture = (name: string, files: Record<string, string>): string => {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  git(root, "git init -q -b main");
  git(root, "git config user.email context@localhost");
  git(root, "git config user.name context");
  write(root, files);
  git(root, "git add -A");
  git(root, "git commit -q -m base");
  return root;
};

const read = (directory: string, ref = "main") =>
  Effect.runPromise(readRepoContext({ directory, ref }));

const SKILL = (name: string, description: string, body = "the body") =>
  `---\nname: ${name}\ndescription: |\n  ${description}\n---\n\n# ${name}\n\n${body}\n`;

describe("reading a repository's instructions and skills", () => {
  it("reads AGENTS.md and lists .pi/skills before .agents/skills, by frontmatter", async () => {
    const root = fixture("both", {
      "AGENTS.md": "# Rules\n\nPostgres is on 5442.\n",
      ".pi/skills/verify-web/SKILL.md": SKILL(
        "verify-web",
        "Drive the dashboard.",
      ),
      ".pi/skills/effect/SKILL.md": SKILL("effect", "Effect v4 guide."),
      ".pi/skills/effect/references/SCHEMA.md": "not a skill",
      ".pi/skills/lib/helper.sh": "echo not a skill",
      ".agents/skills/plain/SKILL.md": "No frontmatter at all.\n",
    });
    const context = await read(root);

    expect(context).toEqual({
      ref: "main",
      commit: git(root, "git rev-parse main"),
      instructions: {
        path: "AGENTS.md",
        bytes: "# Rules\n\nPostgres is on 5442.\n".length,
        text: "# Rules\n\nPostgres is on 5442.\n",
      },
      skills: [
        {
          name: "effect",
          description: "Effect v4 guide.",
          path: ".pi/skills/effect/SKILL.md",
        },
        {
          name: "verify-web",
          description: "Drive the dashboard.",
          path: ".pi/skills/verify-web/SKILL.md",
        },
        // No frontmatter: the directory names it.
        {
          name: "plain",
          description: "",
          path: ".agents/skills/plain/SKILL.md",
        },
      ],
    });
  });

  it("reads the base's commit, not what the worktree's branch changed", async () => {
    const root = fixture("base", {
      "AGENTS.md": "base rules\n",
      ".pi/skills/kept/SKILL.md": SKILL("kept", "On the base."),
    });
    const base = git(root, "git rev-parse main");
    // The run's branch rewrites the rules and adds a skill, committed and uncommitted.
    git(root, "git checkout -q -b factory/run");
    write(root, {
      "AGENTS.md": "the run's own rules\n",
      ".pi/skills/added/SKILL.md": SKILL("added", "Branch only."),
    });
    git(root, "git add -A");
    git(root, "git commit -q -m branch");
    write(root, { "AGENTS.md": "uncommitted rules\n" });

    const context = await read(root, "main");

    // Mutation: read the worktree's file — the run's own rules come back.
    expect(context?.commit).toBe(base);
    expect(context?.instructions?.text).toBe("base rules\n");
    expect(context?.skills.map((skill) => skill.name)).toEqual(["kept"]);
  });

  it("follows an AGENTS.md symlink inside the repository, and not one leaving it", async () => {
    const inside = fixture("link-in", { "docs/agents.md": "linked rules\n" });
    symlinkSync("docs/agents.md", join(inside, "AGENTS.md"));
    git(inside, "git add -A");
    git(inside, "git commit -q -m link");
    const outside = fixture("link-out", { "README.md": "readme\n" });
    symlinkSync("../link-in/docs/agents.md", join(outside, "AGENTS.md"));
    git(outside, "git add -A");
    git(outside, "git commit -q -m link");

    expect((await read(inside))?.instructions).toEqual({
      path: "docs/agents.md",
      bytes: "linked rules\n".length,
      text: "linked rules\n",
    });
    expect((await read(outside))?.instructions).toBeUndefined();
  });

  it("names an AGENTS.md too large to read by its size, without its text", async () => {
    const big = `${"x".repeat(99)}\n`.repeat(
      Math.ceil((REPO_INSTRUCTIONS_READ_BYTES + 1) / 100),
    );
    const root = fixture("big", { "AGENTS.md": big });

    expect((await read(root))?.instructions).toEqual({
      path: "AGENTS.md",
      bytes: big.length,
    });
  });

  it("answers a repository with neither file as no instructions and no skills", async () => {
    const root = fixture("bare", { "README.md": "nothing for agents\n" });

    expect(await read(root)).toEqual({
      ref: "main",
      commit: git(root, "git rev-parse main"),
      skills: [],
    });
  });

  it("answers nothing for a base that names no commit, or a directory that is not a root", async () => {
    const root = fixture("nested", {
      "AGENTS.md": "the outer repository's rules\n",
      "sub/file.txt": "inside\n",
    });

    expect(await read(root, "no-such-branch")).toBeUndefined();
    // A session directory inside some other checkout is not that checkout's session.
    expect(await read(join(root, "sub"))).toBeUndefined();
    expect(await read(join(scratch, "not-a-repo-at-all"))).toBeUndefined();
  });
});

describe("the tree and symlink parsers", () => {
  it("reads ls-tree -l -z records, padded sizes and tabs in paths included", () => {
    expect(
      parseTreeEntries(
        "100644 blob abc     12\tAGENTS.md\u0000120000 blob def      9\tlink\twith tab\u0000",
      ),
    ).toEqual([
      {
        mode: "100644",
        type: "blob",
        object: "abc",
        bytes: 12,
        path: "AGENTS.md",
      },
      {
        mode: "120000",
        type: "blob",
        object: "def",
        bytes: 9,
        path: "link\twith tab",
      },
    ]);
  });

  it("keeps a symlink target inside the repository", () => {
    expect(symlinkTargetInRepo("CLAUDE.md")).toBe("CLAUDE.md");
    expect(symlinkTargetInRepo("./docs/../AGENTS.md")).toBe("AGENTS.md");
    expect(symlinkTargetInRepo("../elsewhere.md")).toBeUndefined();
    expect(symlinkTargetInRepo("/etc/passwd")).toBeUndefined();
    expect(symlinkTargetInRepo("docs/../..")).toBeUndefined();
  });
});
