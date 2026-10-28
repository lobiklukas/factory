/**
 * What an authored definition version is held to before it is written (D4): `defineBoard` and
 * `factory board define --file`.
 *
 * Until D4 the only writers of `board_definitions` were migrations, and `columns` is unconstrained
 * JSONB (0007): a row can hold anything, and a fault in one surfaced only when a card met it — an
 * unknown skill as `MissingSkill` at run start, a lane with no way out as a card that never leaves.
 * An authored version is refused for each such fault up front, naming the field, and nothing is
 * written. The rules, beyond `@repo/domain/Task`'s `definitionFaults` (a column named twice, no
 * columns, an initial column or a move target the definition does not declare, a move to itself or
 * to one target twice, a gate with no name), are:
 *
 * - **a name** for the version and for every column — a blank one is a lane nobody can name;
 * - **an initial column**, and one that is not terminal: an authored version says where a new card
 *   starts (a migration's version 1–3 falls back to its first column, an authored one never does),
 *   and a card that starts finished never runs;
 * - **declared moves**: a terminal column declares none (a finished card does not move, and its runs'
 *   worktrees are released on arrival), every other column at least one (a card in it could never
 *   leave), and at least one column is terminal (a card could never finish). An authored version
 *   therefore always declares its own moves, so it is never read through the default pipeline's
 *   table (`columnTransitions`) — what the file says is what a card meets;
 * - **known requirement keys** (`KNOWN_REQUIREMENTS`), each declared once per column;
 * - **known skills**: every name a column binds is one the skill library holds (D7's `SkillService`),
 *   so a run never fails to start on `MissingSkill`;
 * - **known roles**, when the deployment's role table (`ROLE_MODELS`, B6) has any rows: a role
 *   outside it would silently run on the deployment's model, which is the typo this catches. With no
 *   table every role runs on the deployment's model, and any role is accepted.
 *
 * Pure: the skill library and the role table are passed in by the caller, who holds them
 * (`apps/api`'s `defineBoard` handler reads `SkillService.list` and `SessionService.roles`), so every
 * rule is a case in a test without a database.
 */
import type { DefineBoardInput, DefinitionFault } from "@repo/domain/Task";
import { definitionFaults } from "@repo/domain/Task";
import { KNOWN_REQUIREMENTS } from "./requirements";

/** What an authored version's skills and roles are checked against. */
export type DefinitionLibrary = {
  /** Every skill name the library holds, at any version. */
  readonly skills: ReadonlySet<string>;
  /** The roles the deployment's role table names; empty is a deployment with no table. */
  readonly roles: ReadonlySet<string>;
};

/** The fields of `DefineBoardInput` the rules read: everything but the dry-run flag. */
export type AuthoredDefinition = Omit<DefineBoardInput, "dryRun">;

/** Every fault of `definition`, or `[]` when it may be written as a new version. */
export const authoredDefinitionFaults = (
  definition: AuthoredDefinition,
  library: DefinitionLibrary,
): ReadonlyArray<DefinitionFault> => {
  const faults: Array<DefinitionFault> = [];
  if (definition.name.trim() === "")
    faults.push({
      field: "name",
      message: "the definition has no name",
    });
  faults.push(...definitionFaults(definition));

  const initial = definition.initialColumn;
  if (initial === undefined)
    faults.push({
      field: "initialColumn",
      message:
        "the definition names no initial column: say which column a new card starts in",
    });
  else if (
    // The first column of the name, as every reader resolves one: a second is a duplicate's fault.
    definition.columns.find((column) => column.name === initial)?.kind ===
    "terminal"
  )
    faults.push({
      field: "initialColumn",
      message: `the initial column "${initial}" is terminal: a card would start finished`,
    });

  if (
    definition.columns.length > 0 &&
    !definition.columns.some((column) => column.kind === "terminal")
  )
    faults.push({
      field: "columns",
      message:
        "the definition declares no terminal column: a card on it could never finish",
    });

  definition.columns.forEach((column, index) => {
    const at = `columns[${index}]`;
    if (column.name.trim() === "")
      faults.push({
        field: `${at}.name`,
        message: `column ${index + 1} has no name`,
      });
    const moves = column.transitions ?? [];
    if (column.kind === "terminal" && moves.length > 0)
      faults.push({
        field: `${at}.transitions`,
        message: `column "${column.name}" is terminal and declares moves out: a finished card does not move`,
      });
    if (column.kind !== "terminal" && moves.length === 0)
      faults.push({
        field: `${at}.transitions`,
        message: `column "${column.name}" is not terminal and declares no moves out: a card in it could never leave`,
      });
    const keys = new Set<string>();
    column.requires.forEach((requirement, position) => {
      const field = `${at}.requires[${position}].key`;
      if (!KNOWN_REQUIREMENTS.has(requirement.key))
        faults.push({
          field,
          message: `column "${column.name}" requires "${requirement.key}", which is not a requirement the factory knows (${[...KNOWN_REQUIREMENTS].join(", ")})`,
        });
      if (keys.has(requirement.key))
        faults.push({
          field,
          message: `column "${column.name}" requires "${requirement.key}" more than once`,
        });
      keys.add(requirement.key);
    });
    column.skills.forEach((skill, position) => {
      if (!library.skills.has(skill))
        faults.push({
          field: `${at}.skills[${position}]`,
          message: `column "${column.name}" binds skill "${skill}", which the skill library does not hold: put it first (factory skill put)`,
        });
    });
    if (
      column.role !== undefined &&
      library.roles.size > 0 &&
      !library.roles.has(column.role)
    )
      faults.push({
        field: `${at}.role`,
        message: `column "${column.name}" names role "${column.role}", which is not in the deployment's role table (ROLE_MODELS: ${[...library.roles].sort().join(", ")})`,
      });
  });

  return faults;
};
