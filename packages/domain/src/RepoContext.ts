import { Schema } from "effect";

/**
 * What a session's repository told its last run (S-repo-instructions-and-skills, F19), as the log
 * records it and `getSessionContext` answers it: where the files were read, the instruction file's
 * path and size in the repository and in the prompt (and whether the cap cut it), and the skills the
 * index listed, dropped for its budget, or left to the column's own skill of the same name.
 * Sizes and names, never the text: the text is in the recorded prompt, and a second copy here would
 * be one a reader could find disagreeing with the first.
 */
export const RepoInstructionsRecord = Schema.Struct({
  /** The file that was read: `AGENTS.md`, else `CLAUDE.md`, else the Copilot file (F20). */
  path: Schema.String,
  /** The file's size in the repository, in bytes. */
  bytes: Schema.Finite,
  /** What the rendered section cost in the prompt, tag included. */
  tokens: Schema.Finite,
  /** The budget the section was assembled under, in tokens. */
  cap: Schema.Finite,
  /** Whether the section carries less than the whole file. */
  truncated: Schema.Boolean,
});
export type RepoInstructionsRecord = typeof RepoInstructionsRecord.Type;

export const RepoPromptRecord = Schema.Struct({
  /** The ref and the commit it named when the files were read. */
  ref: Schema.String,
  commit: Schema.String,
  /** `null` when no instruction file was rendered: the repo has none, or only an empty one. */
  instructions: Schema.NullOr(RepoInstructionsRecord),
  skills: Schema.Struct({
    tokens: Schema.Finite,
    cap: Schema.Finite,
    listed: Schema.Array(
      Schema.Struct({ name: Schema.String, path: Schema.String }),
    ),
    /** The nested `AGENTS.md` paths the index named (F20). */
    nested: Schema.Array(Schema.String),
    /** The skill paths the index's budget left out. */
    dropped: Schema.Array(Schema.String),
    /** The skill paths left out because a skill of that name is already the run's. */
    shadowed: Schema.Array(Schema.String),
  }),
});
export type RepoPromptRecord = typeof RepoPromptRecord.Type;

/**
 * What a session's run was told beyond its task, as far as the control plane records it.
 * `repo` is absent for a session with no repository (a scratch session) and for one whose log
 * predates the record: "never recorded" is not "recorded nothing", which is a record with no
 * instructions and no skills.
 */
export const SessionContext = Schema.Struct({
  repo: Schema.optional(RepoPromptRecord),
});
export type SessionContext = typeof SessionContext.Type;

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The one line a run's repo instructions come to, for `factory show` and the session pane (F19):
 * "told AGENTS.md (5823 bytes, 1522 tokens) and 8 repo skills", with a truncated file, nested
 * instruction files, and the skills dropped for the budget or shadowed by the column's own called out;
 * "no repo instructions" for a scratch session and for a repo with neither file nor skills.
 */
export const repoContextText = (repo: RepoPromptRecord | undefined): string => {
  if (repo === undefined) return "no repo instructions";
  const { instructions, skills } = repo;
  const parts: string[] = [];
  if (instructions !== null) {
    const facts = [
      `${plural(instructions.bytes, "byte")}`,
      `${plural(instructions.tokens, "token")}`,
    ];
    if (instructions.truncated)
      facts.push(
        `truncated: the prompt carries only part of it, cap ${instructions.cap} tokens`,
      );
    parts.push(`${instructions.path} (${facts.join(", ")})`);
  }
  const notes = [
    ...(skills.dropped.length === 0
      ? []
      : [`${skills.dropped.length} dropped for the budget`]),
    ...(skills.shadowed.length === 0
      ? []
      : [`${skills.shadowed.length} shadowed by the column's own skills`]),
  ];
  if (skills.listed.length > 0 || notes.length > 0) {
    parts.push(
      `${plural(skills.listed.length, "repo skill")}${
        notes.length === 0 ? "" : ` (${notes.join(", ")})`
      }`,
    );
  }
  if (skills.nested.length > 0) {
    parts.push(`${plural(skills.nested.length, "nested AGENTS.md")} listed`);
  }
  return parts.length === 0
    ? "no repo instructions"
    : `told ${parts.join(" and ")}`;
};
