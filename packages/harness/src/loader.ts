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
 * - The column's `role` is carried through as declared, and `resolveRole` is where it becomes what
 *   B6 says a role is: the model the run talks to and the tools it is offered (LOB-207). Both halves
 *   are read here and nowhere else, so changing a role's model is one edit to the deployment's
 *   table (`RoleModels`, read from `ROLE_MODELS` at boot) and changing what a role may use is one
 *   edit to `./policy`'s `READ_ONLY_ROLES` (LOB-74). `openSession` takes the model, the withheld
 *   tools and the read-only stage from that one answer.
 */
import type { Extension } from "@earendil-works/pi-durable";
import {
  defineExtension,
  section,
  type PromptSection,
} from "@earendil-works/pi-durable";
import { Effect, Schema } from "effect";
import { modelAccessFor, type ModelAccess } from "./models";
import {
  readOnlyStageOf,
  STAGE_REFUSED_TOOLS,
  type ReadOnlyStage,
} from "./policy";

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
 * `BoardColumn` rather than the whole row: a run needs the column's name, its role and its skills.
 */
export type RunColumn = {
  readonly name: string;
  /** The role the column declares (B4), absent where B4 puts "—". */
  readonly role?: string;
  readonly skills: readonly string[];
};

/** What one run gets from its column: the sections its prompt carries, in the column's order. */
export type RunProfile = {
  /** The column the run started in; absent for a session with no card. */
  readonly column?: string;
  /**
   * The role that column declares (B6), which is what `resolveRole` turns into the run's model and
   * its tool policy at `openSession` (LOB-74, LOB-207). Absent for a session with no card and for a
   * column with no role.
   */
  readonly role?: string;
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
    return {
      column: column.name,
      ...(column.role === undefined ? {} : { role: column.role }),
      skills,
    };
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

// ---------------------------------------------------------------------------------------------
// The role: its model and its tools (B6, LOB-207)
// ---------------------------------------------------------------------------------------------

/** The deployment's role → model table is malformed, or names a model this process cannot serve. */
export class InvalidRoleModels extends Schema.TaggedError<InvalidRoleModels>()(
  "InvalidRoleModels",
  { message: Schema.String },
) {}

/**
 * The deployment's role → model table (B6), resolved against the model catalog the process serves:
 * one row per role that runs something other than the deployment's own model. A role with no row —
 * and a run with no role, and a session with no card — runs the deployment's model.
 *
 * It is deployment configuration rather than a column of the board definition because a model id is
 * a fact about a deployment (`faux/*` here, `anthropic/*` there), and a board is not: the same board
 * runs under both. A `Map` rather than an object literal, because a role is free text in a board
 * definition and `constructor` must not find `Object.prototype`'s.
 */
export type RoleModels = ReadonlyMap<string, ModelAccess>;

/** A deployment that names no role models: every run talks to the deployment's model. */
export const NO_ROLE_MODELS: RoleModels = new Map();

/**
 * Read the role → model table as a deployment writes it (`ROLE_MODELS`): a comma-separated list of
 * `role=provider/modelId`, in the shape `APPROVAL_REQUIRED` already uses. Blank entries are skipped,
 * so an empty value is an empty table. A row with no `=`, an empty side, or a role named twice is
 * refused rather than guessed at: two rows for one role would make "which model" depend on order.
 */
export const parseRoleModels = (
  text: string,
): Effect.Effect<ReadonlyMap<string, string>, InvalidRoleModels> =>
  Effect.gen(function* () {
    const table = new Map<string, string>();
    for (const raw of text.split(",")) {
      const entry = raw.trim();
      if (entry.length === 0) continue;
      const equals = entry.indexOf("=");
      const role = equals < 0 ? "" : entry.slice(0, equals).trim();
      const model = equals < 0 ? "" : entry.slice(equals + 1).trim();
      if (role.length === 0 || model.length === 0) {
        return yield* new InvalidRoleModels({
          message: `role model "${entry}" is not role=provider/modelId`,
        });
      }
      if (table.has(role)) {
        return yield* new InvalidRoleModels({
          message: `role ${role} is given a model twice`,
        });
      }
      table.set(role, model);
    }
    return table;
  });

/**
 * Resolve each row's `provider/modelId` against the catalog `deployment` was built with — the
 * lookup a replay does (`modelAccessFor`, LOB-198), done once, at boot. A row naming a model the
 * process cannot serve is refused, never quietly served by the deployment's model: a role that was
 * configured onto a model and silently runs another is the failure this check exists to make loud.
 */
export const resolveRoleModels = (
  deployment: ModelAccess,
  declared: ReadonlyMap<string, string>,
): Effect.Effect<RoleModels, InvalidRoleModels> =>
  Effect.gen(function* () {
    const resolved = new Map<string, ModelAccess>();
    for (const [role, key] of declared) {
      const access = modelAccessFor(deployment, key);
      if (access === undefined) {
        return yield* new InvalidRoleModels({
          message: `role ${role} names model ${key}, which this process does not serve`,
        });
      }
      resolved.set(role, access);
    }
    return resolved;
  });

/** What a run's role resolves to (B6): the model it talks to and the tools it is not offered. */
export type RoleResolution = {
  /** The role's model, or the deployment's when the role has no row (or there is no role). */
  readonly model: ModelAccess;
  /**
   * Tool names the run is not offered at all. `openSession` removes them from the run's tool list
   * (`AgentChange.tools`), so the model never sees them; a call it makes anyway is answered
   * `tool_unavailable` by Pi Durable, and the stage's hook refusal stands behind that.
   */
  readonly withheldTools: ReadonlySet<string>;
  /** The read-only stage the role makes the run (LOB-74), when it is one. */
  readonly stage?: ReadOnlyStage;
};

const NO_TOOLS_WITHHELD: ReadonlySet<string> = new Set();

/**
 * Resolve the run's role to its model and its tool policy — the one place B6 says that happens.
 *
 * The model is the role's row in `roles`, or `deployment` when there is none. The tool policy is
 * the read-only stage's (`READ_ONLY_ROLES`): a read-only role is not offered the tools the stage
 * refuses (`STAGE_REFUSED_TOOLS`), and every other role is offered every tool. Pure, so the whole
 * mapping is a table in a test.
 */
export const resolveRole = (
  run: RunProfile | undefined,
  deployment: ModelAccess,
  roles: RoleModels = NO_ROLE_MODELS,
): RoleResolution => {
  const model = run?.role === undefined ? undefined : roles.get(run.role);
  const stage = readOnlyStageOf(run);
  return {
    model: model ?? deployment,
    withheldTools:
      stage === undefined ? NO_TOOLS_WITHHELD : STAGE_REFUSED_TOOLS,
    ...(stage === undefined ? {} : { stage }),
  };
};
