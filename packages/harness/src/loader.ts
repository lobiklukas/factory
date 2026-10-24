/**
 * What a run is given at open, resolved from the column it started in (docs/board.md B6, LOB-48).
 *
 * A column declares `role`, `skills[]` and `requires[]` (B6). The skills are factory-owned records
 * (LOB-172/LOB-173) and reach the model as prompt sections installed beside `CodingTools` at
 * `openSession` — today the only model-facing seam the harness has. This module is where that
 * resolution happens, so "what a run in this column is told" is one function rather than logic
 * spread over the control plane:
 *
 * - `loadRun` turns the column's skill *names* into the records themselves, failing on a name the
 *   factory does not hold rather than injecting a section that silently says nothing. A column with
 *   no skills (or a session with no card, which is a scratch session) resolves to no sections.
 * - `skillsExtension` turns those records into one prompt section each, rendered in the order the
 *   column names them.
 *
 * **The role is not resolved here yet, and that is not an oversight.** B6 gives the role the model
 * and the tool policy. Neither has a source of truth in the repo today: the model is the
 * deployment's (one per process, `./models`), and the tool policy is D11's session policy, which is
 * per worktree rather than per role. Inventing a per-role table here would be a config surface
 * nobody asked for, so this issue resolves the column's skills and nothing else — the role clause
 * of B6 is LOB-207, which is where a role → model and tool-policy mapping gets decided.
 */
import type { Extension } from "@earendil-works/pi-durable";
import {
  defineExtension,
  section,
  type PromptSection,
} from "@earendil-works/pi-durable";
import { Effect, Schema } from "effect";

/** A column names a skill the factory does not hold. */
export class MissingSkill extends Schema.TaggedError<MissingSkill>()(
  "MissingSkill",
  {
    column: Schema.String,
    skill: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * One factory skill, as the run's prompt needs it: the markdown body, and the name it is addressed
 * by. The record's description, version and attachments are deliberately not here — none of them is
 * prompt text (B6's stored shape mirrors `.pi/skills/<name>/SKILL.md`, whose frontmatter is not
 * injected either).
 */
export type RunSkill = {
  readonly name: string;
  readonly body: string;
};

/**
 * A run's column as the board definition declares it (B4, B6). Read by the control plane from the
 * definition version the run's card is pinned to, which is why this is a subset of the domain's
 * `BoardColumn` rather than the whole row: a run needs the column's name and its skills.
 */
export type RunColumn = {
  readonly name: string;
  readonly skills: readonly string[];
};

/** What one run gets from its column: the sections its prompt carries, in the column's order. */
export type RunProfile = {
  /** The column the run started in; absent for a session with no card. */
  readonly column?: string;
  readonly skills: readonly RunSkill[];
};

/** A run with no card, or in a column that names no skills: nothing is injected. */
export const EMPTY_RUN_PROFILE: RunProfile = { skills: [] };

/**
 * Resolve a column's skills against the factory's records.
 *
 * Order is the column's, so a board author controls the order the sections render in. A name with
 * no record is a `MissingSkill`: the column asked for text the run would not get, and a silently
 * missing section is the failure this check exists to make loud.
 */
export const loadRun = (
  column: RunColumn | undefined,
  library: readonly RunSkill[],
): Effect.Effect<RunProfile, MissingSkill> =>
  Effect.gen(function* () {
    if (column === undefined) return EMPTY_RUN_PROFILE;
    const byName = new Map(library.map((skill) => [skill.name, skill]));
    const skills: RunSkill[] = [];
    for (const name of column.skills) {
      const found = byName.get(name);
      if (found === undefined) {
        return yield* new MissingSkill({
          column: column.name,
          skill: name,
          message: `column "${column.name}" names skill "${name}", which the factory does not hold`,
        });
      }
      skills.push(found);
    }
    return { column: column.name, skills };
  });

/** The name the skills extension is installed under, so a conversation can select it by name. */
export const SKILLS_EXTENSION = "skills";

/**
 * The prompt section key one skill renders under.
 *
 * Pi Durable validates a section key against `/^[a-z][a-z0-9_-]*$/`, and a factory skill's name is
 * free text (the domain only requires it to be unique), so the name is folded into that shape
 * rather than assumed to be in it: `Specify` and `specify` address the same section. Two names that
 * fold together would share one section — the factory's names are lowercase stage words today,
 * which is the case this reads well for. The prefix also guarantees the leading letter the pattern
 * requires, whatever the skill is called.
 */
export const skillSectionKey = (name: string): string =>
  `skill_${name.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "_")}`;

/**
 * One prompt section per skill, carrying the skill's body verbatim. An empty body renders no
 * section at all rather than an empty tag: a section with nothing in it is noise in the prompt.
 *
 * The tag is Pi Durable's default (`<skill_specify>\n…\n</skill_specify>`), which is what tells the
 * model where one skill ends and the next begins, and what a later `pi.system` entry replaces by
 * name.
 */
export const skillsExtension = (skills: readonly RunSkill[]): Extension => {
  const sections: PromptSection[] = skills.map((skill) =>
    section(skillSectionKey(skill.name), () =>
      skill.body.trim().length === 0 ? undefined : skill.body,
    ),
  );
  return defineExtension({ name: SKILLS_EXTENSION, sections });
};
