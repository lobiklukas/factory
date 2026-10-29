/**
 * What the repository itself tells a run (S-repo-instructions-and-skills): its `AGENTS.md` (or, F20,
 * the `CLAUDE.md` or Copilot file a repo keeps instead), and the skills it ships as
 * `.pi/skills/<name>/SKILL.md` or `.agents/skills/<name>/SKILL.md`.
 *
 * Every comparable product reads a repo's instruction file and its skills in a cloud run, and this
 * repo's own `AGENTS.md` carries load-bearing rules (the gate, the Postgres port) that a factory run
 * would otherwise never see. The factory's own skills (B6, `./loader`) are a different thing: records
 * a board column binds, injected whole. The repo's are read from the repository, at open, and are
 * never stored in the factory's database.
 *
 * Two sections, measured the way pages are (`./pages`), with the estimator compaction uses:
 *
 * - **`repo_instructions`** is the instruction file verbatim under a one-line preamble that names it:
 *   the first of `REPO_INSTRUCTION_FILES` the repository has, so `AGENTS.md` wins over `CLAUDE.md`
 *   and that over `.github/copilot-instructions.md`. Capped at `REPO_INSTRUCTIONS_TOKEN_CAP`. A longer file is cut at a line boundary and says so, naming the file,
 *   so a run that needs the rest reads it rather than acting on half a rule.
 * - **`repo_skills`** is an index, not the bodies: one line per skill with its name, its frontmatter
 *   description and its path, capped at `REPO_SKILLS_TOKEN_CAP`. The run reads a skill's `SKILL.md`
 *   with its own tools when the description matches its task, so a repo with thirty skills does not
 *   pay for thirty bodies up front — and the factory never learns the skill exists.
 *   The `AGENTS.md` files nested in directories (F20) are listed after the skills the same way, by
 *   path and never injected: the run reads the one nearest the files it changes.
 *
 * Factory column skills stay authoritative where they overlap: a repo skill whose name the run's
 * column already binds is left out of the index (and recorded as shadowed), so the run is never told
 * two different `specify` skills. What both sections came to is committed to the log beside the page
 * prompt (`RepoPromptDoc`), so "what was this run told, and what did it cost" is a read.
 *
 * The harness only knows the text: the control plane reads the files at the session's base ref
 * (`@repo/core`'s `repoContext`) and hands them in, which keeps this module free of git.
 */
import type { Extension, PromptSection } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";

/** The instructions section's key, and so its `<repo_instructions>` tag. */
export const REPO_INSTRUCTIONS_SECTION_KEY = "repo_instructions";

/** The skills index's key, and so its `<repo_skills>` tag. */
export const REPO_SKILLS_SECTION_KEY = "repo_skills";

/** The extensions the two sections are installed as, at different places in the prompt. */
export const REPO_INSTRUCTIONS_EXTENSION = "factory.repo.instructions";
export const REPO_SKILLS_EXTENSION = "factory.repo.skills";

/**
 * The files a repository's standing instructions are read from, at the worktree's root, in the order
 * the first that exists wins (F20): the open standard, then the file Claude Code reads, then the one
 * Copilot does. A repo that keeps only `CLAUDE.md` as a regular file is still told its rules.
 */
export const REPO_INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
] as const;

/** The file that wins, and the name nested directories' instruction files carry. */
export const REPO_INSTRUCTIONS_FILE = REPO_INSTRUCTION_FILES[0];

/** The most nested `AGENTS.md` paths the skills index lists. */
export const REPO_NESTED_MAX = 20;

/**
 * The token budget `AGENTS.md` may spend. About 16 KB of text: this repo's own file is a tenth of
 * it, and a file several times larger than that is a manual rather than a set of standing rules — it
 * is cut, and the run is told where the rest is.
 */
export const REPO_INSTRUCTIONS_TOKEN_CAP = 4096;

/** The token budget of the skills index: dozens of one-line entries, never the bodies. */
export const REPO_SKILLS_TOKEN_CAP = 1536;

/** How much of one skill's description its index line carries, in characters. */
export const REPO_SKILL_DESCRIPTION_CHARS = 300;

/** The instruction file as the control plane read it from the repository. */
export type RepoInstructions = {
  /**
   * The file's path from the worktree root: the one of `REPO_INSTRUCTION_FILES` that was read, or
   * the file a symlink there names.
   */
  readonly path: string;
  /** The file's size in bytes, as the repository holds it. */
  readonly bytes: number;
  /**
   * The file's text. Absent for a file larger than the control plane reads into a prompt: the
   * section then only says where the file is. An empty or all-whitespace file renders no section.
   */
  readonly text?: string;
};

/** One skill the repository ships, as its `SKILL.md` frontmatter names it. */
export type RepoSkill = {
  /** The frontmatter's `name`, else the skill's directory name. */
  readonly name: string;
  /** The frontmatter's `description`; empty when it has none. */
  readonly description: string;
  /** The `SKILL.md`'s path from the worktree root, which is what the run reads it by. */
  readonly path: string;
};

/** What the repository tells a run, read at the session's base ref. */
export type RepoContext = {
  /** The ref the files were read at: the base the session's worktree was cut from. */
  readonly ref: string;
  /** The commit `ref` named when they were read. */
  readonly commit: string;
  /** Absent: the repository has none of `REPO_INSTRUCTION_FILES` at that commit. */
  readonly instructions?: RepoInstructions;
  /** In the order the control plane listed them: `.pi/skills` first, then `.agents/skills`. */
  readonly skills: readonly RepoSkill[];
  /**
   * The paths of the `AGENTS.md` files nested in directories (F20), sorted, from the worktree root;
   * the root's own is not one. Absent or empty: none, or the listing was not read.
   */
  readonly nested?: readonly string[];
};

/** What the two sections came to: their text, their measured cost, and what they left out. */
export type RepoPrompt = {
  readonly ref: string;
  readonly commit: string;
  /** Absent when the repository has no instruction file, or an empty one: no section. */
  readonly instructions?: {
    readonly path: string;
    readonly bytes: number;
    /** The section's inner text. */
    readonly text: string;
    /** The rendered section's size in tokens, tag included. */
    readonly tokens: number;
    /** Whether the section carries less than the whole file. */
    readonly truncated: boolean;
    /** The budget the section was assembled under, in tokens. */
    readonly cap: number;
  };
  readonly skills: {
    /** The budget the index was assembled under, in tokens. */
    readonly cap: number;
    /** The index's inner text; absent when no skill and no nested file is listed: no section. */
    readonly text?: string;
    /** The rendered index's size in tokens, tag included. `0` when nothing is rendered. */
    readonly tokens: number;
    /** The skills the index carries, in order. */
    readonly listed: readonly RepoSkill[];
    /** The nested `AGENTS.md` paths the index carries, in order (F20). */
    readonly nested: readonly string[];
    /** The paths the budget left out, in order. */
    readonly dropped: readonly string[];
    /**
     * The paths left out because a skill of that name is already the run's: a factory skill its
     * column binds, or a repo skill listed before it.
     */
    readonly shadowed: readonly string[];
  };
};

/** The tag Pi Durable renders around a section, so a budget measures what the model is sent. */
const tagged = (key: string, inner: string): string =>
  `<${key}>\n${inner}\n</${key}>`;

const shortCommit = (commit: string): string => commit.slice(0, 12);

const instructionsPreamble = (context: RepoContext, path: string): string =>
  `The repository's ${path}, as committed at ${context.ref} (${shortCommit(context.commit)}). ` +
  "These are the repository's standing instructions to anyone working in it: follow them as " +
  "you would the task's own, unless the task says otherwise.";

/**
 * The instructions as the section's inner text, cut at a line boundary to fit `cap`.
 *
 * The cut is the longest prefix of whole lines whose section, with the note saying where the rest
 * is, fits; found by halving, because a file far over the cap would otherwise be re-measured once
 * per line. A file the control plane did not read (no `text`) is all note.
 */
const renderInstructions = (
  context: RepoContext,
  instructions: RepoInstructions,
  cap: number,
): RepoPrompt["instructions"] => {
  const { path, bytes, text } = instructions;
  const preamble = instructionsPreamble(context, path);
  if (text !== undefined && text.trim() === "") return undefined;
  if (text === undefined) {
    const inner = `${preamble}\n\n[${path} is ${bytes} bytes, more than a prompt carries: read it from the worktree before you start.]`;
    return {
      path,
      bytes,
      text: inner,
      tokens: estimateTextTokens(tagged(REPO_INSTRUCTIONS_SECTION_KEY, inner)),
      truncated: true,
      cap,
    };
  }
  const whole = `${preamble}\n\n${text}`;
  const wholeTokens = estimateTextTokens(
    tagged(REPO_INSTRUCTIONS_SECTION_KEY, whole),
  );
  if (wholeTokens <= cap) {
    return {
      path,
      bytes,
      text: whole,
      tokens: wholeTokens,
      truncated: false,
      cap,
    };
  }
  const lines = text.split("\n");
  const cutAt = (kept: number): string =>
    `${preamble}\n\n${lines.slice(0, kept).join("\n")}\n\n[${path} continues: this section carries its first ${kept} of ${lines.length} lines. Read ${path} for the rest before relying on what is missing here.]`;
  const fits = (kept: number): boolean =>
    estimateTextTokens(tagged(REPO_INSTRUCTIONS_SECTION_KEY, cutAt(kept))) <=
    cap;
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  const inner = cutAt(low);
  return {
    path,
    bytes,
    text: inner,
    tokens: estimateTextTokens(tagged(REPO_INSTRUCTIONS_SECTION_KEY, inner)),
    truncated: true,
    cap,
  };
};

const NESTED_PREAMBLE =
  "Instruction files nested in this repository's directories, by path. They are not loaded: before " +
  "you change files under one of these directories, read its AGENTS.md, which adds to the rules above.";

const SKILLS_PREAMBLE =
  "Skills this repository ships, by name, with what each is for and where it is. Their bodies are " +
  "not loaded: when a skill's description matches the task, read its SKILL.md (the path is from " +
  "the worktree root) before acting on it. A factory skill in this prompt is the one to follow " +
  "where the two disagree.";

/** One description as an index line carries it: one line, at most `REPO_SKILL_DESCRIPTION_CHARS`. */
const oneLine = (description: string): string => {
  const flat = description.replaceAll(/\s+/g, " ").trim();
  return flat.length <= REPO_SKILL_DESCRIPTION_CHARS
    ? flat
    : `${flat.slice(0, REPO_SKILL_DESCRIPTION_CHARS - 1).trimEnd()}…`;
};

const skillLine = (skill: RepoSkill): string => {
  const description = oneLine(skill.description);
  return `- ${skill.name} (${skill.path})${description === "" ? "" : `: ${description}`}`;
};

/**
 * Assemble both sections from what the repository holds, under their budgets.
 *
 * `factorySkills` are the names of the skills the run's column binds (B6): a repo skill of the same
 * name — compared lowercased, as `skillSectionKey` folds a name — is shadowed rather than listed.
 * The index is a prefix of the listed skills, as the page section is of its pages: the first one
 * that does not fit ends it, so the drop is by order rather than by size.
 */
export const assembleRepoPrompt = (
  context: RepoContext,
  factorySkills: readonly string[] = [],
  caps: { readonly instructions: number; readonly skills: number } = {
    instructions: REPO_INSTRUCTIONS_TOKEN_CAP,
    skills: REPO_SKILLS_TOKEN_CAP,
  },
): RepoPrompt => {
  const taken = new Set(factorySkills.map((name) => name.toLowerCase()));
  const listed: RepoSkill[] = [];
  const dropped: string[] = [];
  const shadowed: string[] = [];
  let inner = SKILLS_PREAMBLE;
  let full = false;
  for (const skill of context.skills) {
    const folded = skill.name.toLowerCase();
    if (taken.has(folded)) {
      shadowed.push(skill.path);
      continue;
    }
    taken.add(folded);
    if (full) {
      dropped.push(skill.path);
      continue;
    }
    const candidate = `${inner}\n${listed.length === 0 ? "\n" : ""}${skillLine(skill)}`;
    if (
      estimateTextTokens(tagged(REPO_SKILLS_SECTION_KEY, candidate)) >
      caps.skills
    ) {
      full = true;
      dropped.push(skill.path);
      continue;
    }
    inner = candidate;
    listed.push(skill);
  }
  // The nested files follow the skills, best effort within what the budget leaves: the skills are
  // the index's purpose, so these never crowd them out.
  const nested: string[] = [];
  const indexText = (paths: readonly string[]): string | undefined => {
    const parts = [
      ...(listed.length === 0 ? [] : [inner]),
      ...(paths.length === 0
        ? []
        : [
            `${NESTED_PREAMBLE}\n\n${paths.map((path) => `- ${path}`).join("\n")}`,
          ]),
    ];
    return parts.length === 0 ? undefined : parts.join("\n\n");
  };
  for (const path of (context.nested ?? []).slice(0, REPO_NESTED_MAX)) {
    const candidate = indexText([...nested, path]);
    if (
      candidate === undefined ||
      estimateTextTokens(tagged(REPO_SKILLS_SECTION_KEY, candidate)) >
        caps.skills
    )
      break;
    nested.push(path);
  }
  const text = indexText(nested);
  const instructions =
    context.instructions === undefined
      ? undefined
      : renderInstructions(context, context.instructions, caps.instructions);
  return {
    ref: context.ref,
    commit: context.commit,
    ...(instructions === undefined ? {} : { instructions }),
    skills:
      text === undefined
        ? { cap: caps.skills, tokens: 0, listed, nested, dropped, shadowed }
        : {
            cap: caps.skills,
            text,
            tokens: estimateTextTokens(tagged(REPO_SKILLS_SECTION_KEY, text)),
            listed,
            nested,
            dropped,
            shadowed,
          },
  };
};

/**
 * The instructions as an extension. Installed first, ahead of the column's skills, so the factory's
 * own text for the stage comes after — and reads as the more specific word — the repository's.
 */
export const repoInstructionsExtension = (prompt: RepoPrompt): Extension => {
  const sections: PromptSection[] = [
    section(REPO_INSTRUCTIONS_SECTION_KEY, () => prompt.instructions?.text),
  ];
  return defineExtension({ name: REPO_INSTRUCTIONS_EXTENSION, sections });
};

/** The skills index as an extension, installed right after the column's skills it defers to. */
export const repoSkillsExtension = (prompt: RepoPrompt): Extension => {
  const sections: PromptSection[] = [
    section(REPO_SKILLS_SECTION_KEY, () => prompt.skills.text),
  ];
  return defineExtension({ name: REPO_SKILLS_EXTENSION, sections });
};

/**
 * What the two sections came to when a session opened, as the log records it (`RepoPromptDoc`):
 * where the files were read, the instructions' size in the repository and in the prompt, and which
 * skills the index named, dropped or deferred to the column's. Sizes and names, not the text: the
 * text is the `pi.system` entry the sections were committed as, and a second copy here is one a
 * reader could find disagreeing with the first.
 */
export type RepoPromptRecord = {
  /** The ref and commit the files were read at. */
  readonly ref: string;
  readonly commit: string;
  /** The instructions section; `null` when none was rendered (no instruction file, or an empty one). */
  readonly instructions: {
    readonly path: string;
    readonly bytes: number;
    readonly tokens: number;
    readonly cap: number;
    readonly truncated: boolean;
  } | null;
  readonly skills: {
    readonly tokens: number;
    readonly cap: number;
    readonly listed: readonly {
      readonly name: string;
      readonly path: string;
    }[];
    /** The nested `AGENTS.md` paths the index named (F20). */
    readonly nested: readonly string[];
    readonly dropped: readonly string[];
    readonly shadowed: readonly string[];
  };
};

/** The record of an open, from the prompt it rendered. */
export const repoPromptRecord = (prompt: RepoPrompt): RepoPromptRecord => ({
  ref: prompt.ref,
  commit: prompt.commit,
  instructions:
    prompt.instructions === undefined
      ? null
      : {
          path: prompt.instructions.path,
          bytes: prompt.instructions.bytes,
          tokens: prompt.instructions.tokens,
          cap: prompt.instructions.cap,
          truncated: prompt.instructions.truncated,
        },
  skills: {
    tokens: prompt.skills.tokens,
    cap: prompt.skills.cap,
    listed: prompt.skills.listed.map(({ name, path }) => ({ name, path })),
    nested: [...prompt.skills.nested],
    dropped: [...prompt.skills.dropped],
    shadowed: [...prompt.skills.shadowed],
  },
});
