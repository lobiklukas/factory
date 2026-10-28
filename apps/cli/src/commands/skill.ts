import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  SkillName,
  SkillNotFound,
  type PutSkillInput,
  type SkillRecord,
  type SkillSummary,
} from "@repo/domain/Skill";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { BoardClient } from "../rpc";

/**
 * `factory skill` — the factory's skills from a terminal (D7): list them (`ls`), read one version
 * (`show`), and put a new version from a `SKILL.md` (`put --file`).
 *
 * A skill is the prompt text a board column binds (docs/board.md B6). A put is always a new version,
 * never an edit of one in place, and a run keeps the version its log pinned when it opened (B2): so
 * a put reaches the *next* run in a column that binds the skill, and `ls` prints which columns of the
 * default definition those are. The lines are built by the pure functions below, so the layout is a
 * table in a test and the commands only fetch and print.
 */

/** What a field with nothing in it prints, matching `factory repo`. */
export const NONE = "none";

/** What separates `factory skill ls`'s columns: a tab, so a script reads them with `cut -f`. */
export const SKILL_LS_SEPARATOR = "\t";

/** The header `factory skill ls` prints: one name per column, in row order. */
export const SKILL_LS_HEADER = [
  "name",
  "version",
  "columns",
  "updated-at",
  "description",
].join(SKILL_LS_SEPARATOR);

/** A description on one line: a frontmatter block can span several, and a row cannot. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * One `factory skill ls` row: the name, the newest version, the default definition's columns that
 * bind it (comma-separated, `none` when no column does), when the newest was put, and the
 * description.
 */
export const skillRow = (skill: SkillSummary): string =>
  [
    skill.name,
    String(skill.version),
    skill.columns.length === 0 ? NONE : skill.columns.join(","),
    skill.createdAt,
    oneLine(skill.description) || NONE,
  ].join(SKILL_LS_SEPARATOR);

/** `factory skill ls`, whole: the header and a row per skill, or `no skills`. */
export const skillLsLines = (
  skills: ReadonlyArray<SkillSummary>,
): ReadonlyArray<string> =>
  skills.length === 0
    ? ["no skills"]
    : [SKILL_LS_HEADER, ...skills.map(skillRow)];

/** `name@version`, the way a version is named everywhere a person reads one. */
export const skillLabel = (skill: {
  readonly name: string;
  readonly version: number;
}): string => `${skill.name}@${skill.version}`;

/**
 * The labelled header `show` and `put` print about one version: whether it is the newest, who put
 * it and when. The body follows `show`'s header after a blank line.
 */
export const skillHeaderLines = (skill: SkillRecord): ReadonlyArray<string> => [
  `name         ${skill.name}`,
  `version      ${skill.version}${skill.version === skill.newest ? " (newest)" : ` (newest is ${skill.newest})`}`,
  `description  ${oneLine(skill.description) || NONE}`,
  `author       ${skill.author === "" ? NONE : skill.author}`,
  `created-at   ${skill.createdAt}`,
  `attachments  ${skill.attachments.length === 0 ? NONE : skill.attachments.join(", ")}`,
];

/** `factory skill show`, whole: the header, a blank line, and the body exactly as stored. */
export const skillShowLines = (skill: SkillRecord): ReadonlyArray<string> => [
  ...skillHeaderLines(skill),
  "",
  skill.body.replace(/\n$/, ""),
];

/**
 * What `put` prints: the version it made, the one it superseded, and what that means for runs —
 * the sentence an operator needs before trusting an edit to reach (or not reach) a run in flight.
 */
export const skillPutLines = (
  put: SkillRecord,
  previous: SkillRecord | undefined,
): ReadonlyArray<string> => [
  `put          ${skillLabel(put)}`,
  `previous     ${previous === undefined ? `${NONE} (a new skill)` : skillLabel(previous)}`,
  ...skillHeaderLines(put).slice(2),
  previous === undefined
    ? `note         the next run in a column that binds ${put.name} is told ${skillLabel(put)}`
    : `note         runs already open keep ${skillLabel(previous)}; the next run is told ${skillLabel(put)}`,
];

/** The parts of a `SKILL.md` a put needs: its frontmatter's `name` and `description`, and the body. */
export type SkillDocument = {
  readonly name?: string;
  readonly description?: string;
  readonly body: string;
};

/**
 * Read a `SKILL.md` the way `.pi/skills/<name>/SKILL.md` is written: an optional `---` frontmatter
 * block, then the markdown body. Of the frontmatter only `name` and `description` are read — plain,
 * quoted, or a `|` / `>` block scalar — and every other key is ignored, because nothing else is a
 * field of a factory skill. The frontmatter is not part of the body, as the loader never injects it
 * (`@repo/harness`'s `RunSkill`). A file with no frontmatter is all body.
 *
 * Not a YAML parser: the subset the repo's own skills use, so a put of one of them round-trips.
 */
export const parseSkillDocument = (text: string): SkillDocument => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { body: text };
  const close = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (close < 0) return { body: text };
  const fields = new Map<string, string>();
  for (let index = 1; index < close; index += 1) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[index] ?? "");
    if (match === null) continue;
    const key = match[1] ?? "";
    const raw = (match[2] ?? "").trim();
    if (/^[|>][+-]?$/.test(raw)) {
      // A block scalar: the indented lines after the key, joined as `|` keeps them or `>` folds them.
      const block: string[] = [];
      while (index + 1 < close) {
        const next = lines[index + 1] ?? "";
        if (next.trim() !== "" && !/^\s/.test(next)) break;
        block.push(next.trim());
        index += 1;
      }
      fields.set(key, block.join(raw.startsWith("|") ? "\n" : " ").trim());
      continue;
    }
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    fields.set(key, quoted === null ? raw : (quoted[2] ?? ""));
  }
  const name = fields.get("name");
  const description = fields.get("description");
  return {
    ...(name === undefined || name === "" ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    body: lines
      .slice(close + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
};

/** Whether `name` is one a skill may be put under (the domain's `SkillName`). */
const isSkillName = (name: string): boolean => Schema.is(SkillName)(name);

/**
 * The put a document makes: the name from `--name`, else the frontmatter's; the description from the
 * frontmatter, else the newest version's (a body edit does not wipe the description); the
 * attachments always the newest version's, since a `SKILL.md` declares none. A name that is not a
 * skill name is refused here, before anything is sent.
 */
export const putInputFor = (
  document: SkillDocument,
  flagName: string | undefined,
  previous: SkillRecord | undefined,
): { readonly input: PutSkillInput } | { readonly refused: string } => {
  const name = flagName ?? document.name;
  if (name === undefined) {
    return {
      refused:
        "the file has no frontmatter name: add `name:` to it or pass --name",
    };
  }
  if (!isSkillName(name)) {
    return {
      refused: `"${name}" is not a skill name (lowercase letters, digits, - and _, starting with a letter)`,
    };
  }
  return {
    input: {
      name,
      description: document.description ?? previous?.description ?? "",
      body: document.body,
      attachments: previous?.attachments ?? [],
    },
  };
};

const apiFlag = Flag.String("api").pipe(
  Flag.withDescription("Control plane base URL"),
  Flag.optional,
);

/** `factory skill ls` — every skill, its newest version, and the columns that bind it. */
const lsCommand = Command.make(
  "ls",
  { api: apiFlag },
  Effect.fnUntraced(function* ({ api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const skills = yield* client.listSkills({});
      for (const line of skillLsLines(skills)) yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "List the skills: each one's newest version and the default definition's columns that bind it",
  ),
);

/**
 * `factory skill show <name> [--version N]` — one version, header and body. The version defaults to
 * the newest; an unknown name or version is the server's `skill_not_found`, non-zero.
 */
const showCommand = Command.make(
  "show",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription("The skill's name (e.g. specify)"),
    ),
    version: Flag.Int("version").pipe(
      Flag.withDescription("The version to show (defaults to the newest)"),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ name, version, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      if (Option.isSome(version) && version.value < 1) {
        return yield* reportFailure(
          "invalid_input",
          `--version ${version.value} is not a version (versions start at 1)`,
        );
      }
      const { client } = yield* BoardClient;
      const skill = yield* client.getSkill({
        name,
        ...(Option.isSome(version) ? { version: version.value } : {}),
      });
      for (const line of skillShowLines(skill)) yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Show one version of a skill: who put it, and its body",
  ),
  Command.withExamples([
    {
      command: "factory skill show specify --version 1",
      description: "The specify skill as it was seeded",
    },
  ]),
);

/**
 * `factory skill put --file SKILL.md [--name …]` — a new version from a file (`-` reads stdin). The
 * newest version is read first, so the answer names what it superseded and an edit keeps the
 * description and attachments the file does not declare. Unreadable or nameless is `invalid_input`
 * and nothing is sent; a blank body is the server's `invalid_skill`, and nothing is written.
 */
const putCommand = Command.make(
  "put",
  {
    file: Flag.String("file").pipe(
      Flag.withDescription("The SKILL.md to put (- for stdin)"),
    ),
    name: Flag.String("name").pipe(
      Flag.withDescription(
        "The skill's name (defaults to the file's frontmatter name)",
      ),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ file, name, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const fs = yield* FileSystem.FileSystem;
    const read = yield* Effect.result(
      fs.readFileString(file === "-" ? "/dev/stdin" : file),
    );
    if (read._tag === "Failure") {
      return yield* reportFailure(
        "invalid_input",
        `--file "${file}" cannot be read: ${read.failure.message}`,
      );
    }
    const document = parseSkillDocument(read.success);
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const named = Option.getOrUndefined(name) ?? document.name;
      // The newest version, when there is one: what the put supersedes and inherits from.
      const previous =
        named === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* client.getSkill({ name: named }).pipe(
                Effect.asSome,
                Effect.catchIf(
                  Schema.is(SkillNotFound),
                  () => Effect.succeedNone,
                ),
              ),
            );
      const decided = putInputFor(
        document,
        Option.getOrUndefined(name),
        previous,
      );
      if ("refused" in decided) {
        return yield* reportFailure("invalid_input", decided.refused);
      }
      const put = yield* client.putSkill(decided.input);
      for (const line of skillPutLines(put, previous)) yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Put a new version of a skill from a SKILL.md: the next run is told it, runs already open are not",
  ),
  Command.withExamples([
    {
      command: "factory skill put --file SKILL.md",
      description:
        "Put the next version of the skill the file's frontmatter names",
    },
    {
      command: "factory skill put --file notes.md --name specify",
      description:
        "Put a file with no frontmatter as the specify skill's next version",
    },
  ]),
);

export const skillCommand = Command.make("skill").pipe(
  Command.withDescription(
    "Read the skills a board's columns bind, and put new versions of them",
  ),
  Command.withSubcommands([lsCommand, showCommand, putCommand]),
);
