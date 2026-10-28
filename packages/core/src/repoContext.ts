/**
 * Read what a repository tells a run (S-repo-instructions-and-skills): its `AGENTS.md`, and the
 * skills it ships as `.pi/skills/<name>/SKILL.md` or `.agents/skills/<name>/SKILL.md`, from the
 * session's worktree at the commit its base ref names.
 *
 * **At the base, not the worktree's files.** The run's own branch is the agent's to change, and a run
 * that edited `AGENTS.md` would otherwise be telling the next run on that worktree what to do. The
 * base is what the operator's repository holds — reviewed and merged — so the instructions a run is
 * given are the repository's, not the previous run's. The worktree shares the checkout's objects, so
 * the read is `git ls-tree` and `git cat-file` there: no checkout, no network.
 *
 * **Bounded.** The instructions are read whole up to `REPO_INSTRUCTIONS_READ_BYTES`; a larger file is
 * named by size and path only, and the run is told to read it (`@repo/harness`'s `repoContext` caps
 * what a prompt carries either way). Of a skill only its frontmatter is wanted, so a `SKILL.md` over
 * `REPO_SKILL_READ_BYTES` is listed by its directory name with no description, and at most
 * `REPO_SKILLS_MAX` skills are read at all. An `AGENTS.md` that is a symlink is followed once, to a
 * file inside the repository — the common `AGENTS.md -> CLAUDE.md` layout.
 *
 * **Never fails the open.** Every git question answers `undefined` on failure (`gitAnswer`), and a
 * repository whose base does not resolve, or a directory that is not the root of a work tree, reads
 * as no context at all: the session opens as it did before this existed. The skills are never stored
 * in the factory's database: this reads the repository, and the run reads the `SKILL.md` itself.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the local git CLI, as `repos.ts`'s probes are; a blob is read untrimmed, which `gitAnswer` is not.
import { execFile } from "node:child_process";
import { Effect } from "effect";
import { parseSkillDocument } from "@repo/domain/Skill";
import {
  REPO_INSTRUCTIONS_FILE,
  type RepoContext,
  type RepoInstructions,
  type RepoSkill,
} from "@repo/harness";
import { gitAnswer, resolveCommit } from "./repos";

/** The largest `AGENTS.md` read into memory; a larger one is named, not read. */
export const REPO_INSTRUCTIONS_READ_BYTES = 256 * 1024;

/** The largest `SKILL.md` whose frontmatter is read; a larger one is listed by directory name. */
export const REPO_SKILL_READ_BYTES = 64 * 1024;

/** The most repository skills one open reads; the index's budget lists far fewer. */
export const REPO_SKILLS_MAX = 100;

/** The directories a repository's skills are listed from, in the order the index lists them. */
export const REPO_SKILL_ROOTS = [".pi/skills", ".agents/skills"] as const;

/** How long one git read may take before it is answered as nothing. */
const GIT_READ_TIMEOUT_MS = 15_000;

/** A skill's `SKILL.md`, one directory under one of the roots. */
const SKILL_PATH = /^(\.pi|\.agents)\/skills\/([^/]+)\/SKILL\.md$/;

/**
 * A blob's text, untrimmed (a file is its bytes, and `gitAnswer` trims), or `undefined` when git
 * cannot answer. `maxBuffer` is the caller's bound, plus room, so a blob read is never cut short.
 */
const readBlob = (
  directory: string,
  object: string,
  maxBytes: number,
): Effect.Effect<string | undefined> =>
  Effect.callback<string | undefined>((resume, signal) => {
    execFile(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        directory,
        "cat-file",
        "blob",
        object,
      ],
      {
        encoding: "utf8",
        signal,
        timeout: GIT_READ_TIMEOUT_MS,
        maxBuffer: maxBytes + 1024,
      },
      (error, stdout) =>
        resume(Effect.succeed(error === null ? stdout : undefined)),
    );
  });

/** One `git ls-tree -l` entry: a path in the tree, its mode, its object and its size. */
type TreeEntry = {
  readonly mode: string;
  readonly type: string;
  readonly object: string;
  readonly bytes: number;
  readonly path: string;
};

/** `git ls-tree -l -z` output, one record per NUL: `<mode> <type> <object> <size>\t<path>`. */
export const parseTreeEntries = (output: string): readonly TreeEntry[] =>
  output.split("\0").flatMap((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) return [];
    const [mode, type, object, size] = record.slice(0, tab).trim().split(/\s+/);
    if (mode === undefined || type === undefined || object === undefined)
      return [];
    const bytes = Number(size);
    return [
      {
        mode,
        type,
        object,
        bytes: Number.isFinite(bytes) ? bytes : 0,
        path: record.slice(tab + 1),
      },
    ];
  });

const listTree = (
  directory: string,
  commit: string,
  paths: readonly string[],
  recursive: boolean,
): Effect.Effect<readonly TreeEntry[]> =>
  gitAnswer(directory, [
    "ls-tree",
    ...(recursive ? ["-r"] : []),
    "-l",
    "-z",
    "--end-of-options",
    commit,
    "--",
    ...paths,
  ]).pipe(
    Effect.map((output) =>
      output === undefined ? [] : parseTreeEntries(output),
    ),
  );

const isFile = (entry: TreeEntry): boolean =>
  entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");

const isSymlink = (entry: TreeEntry): boolean =>
  entry.type === "blob" && entry.mode === "120000";

/**
 * Where a symlink at the root points, as a path inside the repository, or `undefined` for a target
 * outside it (absolute, or climbing out with `..`), which is not the repository's to give.
 */
export const symlinkTargetInRepo = (target: string): string | undefined => {
  const trimmed = target.trim();
  if (trimmed === "" || trimmed.startsWith("/")) return undefined;
  // A link's target is a POSIX path in git whatever the host is: `.` and `..` resolved by hand.
  const kept: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") kept.push(segment);
    else if (kept.pop() === undefined) return undefined;
  }
  return kept.length === 0 ? undefined : kept.join("/");
};

/** `AGENTS.md` at `commit`, followed through one symlink; `undefined` when there is none. */
const readInstructions = (
  directory: string,
  commit: string,
): Effect.Effect<RepoInstructions | undefined> =>
  Effect.gen(function* () {
    const [entry] = yield* listTree(
      directory,
      commit,
      [REPO_INSTRUCTIONS_FILE],
      false,
    );
    if (entry === undefined) return undefined;
    let file = entry;
    if (isSymlink(entry)) {
      const target = yield* readBlob(directory, entry.object, 4096);
      const inRepo =
        target === undefined ? undefined : symlinkTargetInRepo(target);
      if (inRepo === undefined) return undefined;
      const [followed] = yield* listTree(directory, commit, [inRepo], false);
      if (followed === undefined || followed.path !== inRepo) return undefined;
      file = followed;
    }
    if (!isFile(file)) return undefined;
    if (file.bytes > REPO_INSTRUCTIONS_READ_BYTES) {
      return { path: file.path, bytes: file.bytes };
    }
    const text = yield* readBlob(directory, file.object, file.bytes);
    return text === undefined
      ? undefined
      : { path: file.path, bytes: file.bytes, text };
  });

/** The repository's skills at `commit`: `.pi/skills` first, then `.agents/skills`, each by name. */
const readSkills = (
  directory: string,
  commit: string,
): Effect.Effect<readonly RepoSkill[]> =>
  Effect.gen(function* () {
    const entries = yield* listTree(directory, commit, REPO_SKILL_ROOTS, true);
    const found = entries
      .flatMap((entry) => {
        const match = SKILL_PATH.exec(entry.path);
        return match === null || !isFile(entry)
          ? []
          : [{ entry, root: match[1] ?? "", directoryName: match[2] ?? "" }];
      })
      .sort((left, right) =>
        left.root === right.root
          ? left.directoryName.localeCompare(right.directoryName)
          : left.root === ".pi"
            ? -1
            : 1,
      )
      .slice(0, REPO_SKILLS_MAX);
    return yield* Effect.forEach(
      found,
      ({ entry, directoryName }) =>
        Effect.gen(function* () {
          const text =
            entry.bytes > REPO_SKILL_READ_BYTES
              ? undefined
              : yield* readBlob(directory, entry.object, entry.bytes);
          const document =
            text === undefined ? undefined : parseSkillDocument(text);
          return {
            name: document?.name ?? directoryName,
            description: document?.description ?? "",
            path: entry.path,
          };
        }),
      { concurrency: 4 },
    );
  });

/**
 * What the repository whose work tree is rooted at `directory` holds at `ref`: its `AGENTS.md` and
 * its skills. `undefined` when `directory` is not the root of a work tree (a directory nested in
 * some other repository is not that repository's session) or `ref` names no commit there.
 */
export const readRepoContext = (input: {
  readonly directory: string;
  readonly ref: string;
}): Effect.Effect<RepoContext | undefined> =>
  Effect.gen(function* () {
    const prefix = yield* gitAnswer(input.directory, [
      "rev-parse",
      "--show-prefix",
    ]);
    if (prefix !== "") return undefined;
    const commit = yield* resolveCommit(input.directory, input.ref);
    if (commit === undefined) return undefined;
    const [instructions, skills] = yield* Effect.all(
      [
        readInstructions(input.directory, commit),
        readSkills(input.directory, commit),
      ],
      { concurrency: 2 },
    );
    return {
      ref: input.ref,
      commit,
      ...(instructions === undefined ? {} : { instructions }),
      skills,
    };
  });
