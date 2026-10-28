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
 * as no context at all: the session opens as it did before this existed. What was not read, and
 * why, is the answer's `problems`, for the caller to log. The skills are never stored in the
 * factory's database: this reads the repository, and the run reads the `SKILL.md` itself.
 */
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

/**
 * The most skill directories one open asks for a `SKILL.md` in: a bound on the argument list and
 * on the listing, well past `REPO_SKILLS_MAX`, so a root holding directories with no `SKILL.md`
 * still yields its skills.
 */
const REPO_SKILL_DIRECTORIES_MAX = 1_000;

/**
 * The most a tree listing may print. A listing here is one entry per skill directory or file asked
 * for — never a recursive walk of what a skill directory holds — so this is far past any real one.
 */
const LISTING_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A blob's text, untrimmed (a file is its bytes), or `undefined` when git cannot answer.
 * `maxBuffer` is the caller's bound, plus room, so a blob read is never cut short.
 */
const readBlob = (
  directory: string,
  object: string,
  maxBytes: number,
): Effect.Effect<string | undefined> =>
  gitAnswer(directory, ["cat-file", "blob", object], {
    trim: false,
    maxBuffer: maxBytes + 1024,
    timeoutMs: GIT_READ_TIMEOUT_MS,
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

/**
 * `git ls-tree -l` of `paths` at `commit`, non-recursive: an entry per path, or per child of a path
 * given with a trailing `/`. `undefined` when git could not answer, which is not the same as the
 * empty listing of a path the commit does not have. Paths are literal, never globs: a directory
 * named `*` is that directory.
 */
const listTree = (
  directory: string,
  commit: string,
  paths: readonly string[],
): Effect.Effect<readonly TreeEntry[] | undefined> =>
  gitAnswer(
    directory,
    [
      "--literal-pathspecs",
      "ls-tree",
      "-l",
      "-z",
      "--end-of-options",
      commit,
      "--",
      ...paths,
    ],
    {
      trim: false,
      maxBuffer: LISTING_MAX_BYTES,
      timeoutMs: GIT_READ_TIMEOUT_MS,
    },
  ).pipe(
    Effect.map((output) =>
      output === undefined ? undefined : parseTreeEntries(output),
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

/** What one part of the read came to: its value, and what it could not read. */
type Part<A> = { readonly value: A; readonly problems: readonly string[] };

/** `AGENTS.md` at `commit`, followed through one symlink; `undefined` when there is none. */
const readInstructions = (
  directory: string,
  commit: string,
): Effect.Effect<Part<RepoInstructions | undefined>> =>
  Effect.gen(function* () {
    const failed = (problem: string) => ({
      value: undefined,
      problems: [problem],
    });
    const listed = yield* listTree(directory, commit, [REPO_INSTRUCTIONS_FILE]);
    if (listed === undefined)
      return failed(`git could not list ${REPO_INSTRUCTIONS_FILE}`);
    const [entry] = listed;
    if (entry === undefined) return { value: undefined, problems: [] };
    let file = entry;
    if (isSymlink(entry)) {
      const target = yield* readBlob(directory, entry.object, 4096);
      if (target === undefined)
        return failed(`git could not read where ${entry.path} points`);
      const inRepo = symlinkTargetInRepo(target);
      if (inRepo === undefined)
        return failed(`${entry.path} points outside the repository`);
      const [followed] = (yield* listTree(directory, commit, [inRepo])) ?? [];
      if (followed === undefined || followed.path !== inRepo)
        return failed(`${entry.path} points to ${inRepo}, which is not there`);
      file = followed;
    }
    if (!isFile(file)) return failed(`${file.path} is not a file`);
    if (file.bytes > REPO_INSTRUCTIONS_READ_BYTES) {
      return { value: { path: file.path, bytes: file.bytes }, problems: [] };
    }
    const text = yield* readBlob(directory, file.object, file.bytes);
    return text === undefined
      ? failed(`git could not read ${file.path}`)
      : {
          value: { path: file.path, bytes: file.bytes, text },
          problems: [],
        };
  });

/** A skill root's directory: where its `SKILL.md` would be. */
type SkillDirectory = {
  readonly root: (typeof REPO_SKILL_ROOTS)[number];
  readonly name: string;
};

const rootOrder = (root: SkillDirectory["root"]): number =>
  REPO_SKILL_ROOTS.indexOf(root);

/**
 * The repository's skills at `commit`: `.pi/skills` first, then `.agents/skills`, each by name.
 *
 * Two listings, neither recursive: the directories under each root, then the `SKILL.md` in each.
 * A skill directory's own files — fixtures, evidence, a vendored tree — are never listed, so how
 * much a skill holds does not bear on whether it is found.
 */
const readSkills = (
  directory: string,
  commit: string,
): Effect.Effect<Part<readonly RepoSkill[]>> =>
  Effect.gen(function* () {
    const roots = yield* listTree(
      directory,
      commit,
      REPO_SKILL_ROOTS.map((root) => `${root}/`),
    );
    if (roots === undefined)
      return {
        value: [],
        problems: [`git could not list ${REPO_SKILL_ROOTS.join(" or ")}`],
      };
    const directories = roots
      .flatMap((entry): SkillDirectory[] => {
        if (entry.type !== "tree") return [];
        const root = REPO_SKILL_ROOTS.find((candidate) =>
          entry.path.startsWith(`${candidate}/`),
        );
        const name =
          root === undefined ? "" : entry.path.slice(root.length + 1);
        return root === undefined || name === "" || name.includes("/")
          ? []
          : [{ root, name }];
      })
      .sort((left, right) =>
        left.root === right.root
          ? left.name.localeCompare(right.name)
          : rootOrder(left.root) - rootOrder(right.root),
      )
      .slice(0, REPO_SKILL_DIRECTORIES_MAX);
    if (directories.length === 0) return { value: [], problems: [] };
    const listed = yield* listTree(
      directory,
      commit,
      directories.map(({ root, name }) => `${root}/${name}/SKILL.md`),
    );
    if (listed === undefined)
      return {
        value: [],
        problems: ["git could not list the skill directories' SKILL.md"],
      };
    const byPath = new Map(listed.map((entry) => [entry.path, entry]));
    const found = directories
      .flatMap(({ root, name }) => {
        const entry = byPath.get(`${root}/${name}/SKILL.md`);
        return entry === undefined || !isFile(entry)
          ? []
          : [{ entry, directoryName: name }];
      })
      .slice(0, REPO_SKILLS_MAX);
    const skills = yield* Effect.forEach(
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
    return { value: skills, problems: [] };
  });

/**
 * What one read of a repository came to: the context, when there was one to read, and each thing
 * that was not read with why — the whole context's reason when it is absent, a part's (the skill
 * listing, the instructions' blob) when it is present but short of that part.
 */
export type RepoContextRead = {
  readonly context?: RepoContext;
  readonly problems: readonly string[];
};

/**
 * What the repository whose work tree is rooted at `directory` holds at `ref`: its `AGENTS.md` and
 * its skills. No context when `directory` is not the root of a work tree (a directory nested in
 * some other repository is not that repository's session), when git cannot say whether it is, or
 * when `ref` names no commit there; `problems` says which.
 */
export const readRepoContext = (input: {
  readonly directory: string;
  readonly ref: string;
}): Effect.Effect<RepoContextRead> =>
  Effect.gen(function* () {
    const prefix = yield* gitAnswer(input.directory, [
      "rev-parse",
      "--show-prefix",
    ]);
    if (prefix === undefined)
      return {
        problems: [
          "git could not say whether it is a work tree (not one, or git failed or timed out)",
        ],
      };
    if (prefix !== "")
      return {
        problems: [
          `it is not the root of a work tree (it is ${prefix} inside one)`,
        ],
      };
    const commit = yield* resolveCommit(input.directory, input.ref);
    if (commit === undefined)
      return { problems: [`${input.ref} names no commit there`] };
    const [instructions, skills] = yield* Effect.all(
      [
        readInstructions(input.directory, commit),
        readSkills(input.directory, commit),
      ],
      { concurrency: 2 },
    );
    return {
      context: {
        ref: input.ref,
        commit,
        ...(instructions.value === undefined
          ? {}
          : { instructions: instructions.value }),
        skills: skills.value,
      },
      problems: [...instructions.problems, ...skills.problems],
    };
  });
