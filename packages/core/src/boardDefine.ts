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
 * - **terminal by name as well as by kind**: a terminal column is named `done` or `canceled`, and a
 *   column so named is terminal (`TERMINAL_COLUMNS`). Two readers still decide "finished" by the
 *   column's name rather than its `kind` — the workspace release on arrival (`./WorkspaceRelease`)
 *   and the caps' count of runs in flight (`./boardCaps`) — so a terminal `shipped` would never
 *   release its cards' worktrees and its runs would count against caps forever, and a working `done`
 *   would tear a live card's worktrees down on arrival. Lifted when those readers read `kind`;
 * - **known requirement keys** (`KNOWN_REQUIREMENTS`), each declared once per column, and the human
 *   gate keys (`HUMAN_GATE_REQUIREMENTS`) only on a column with a gated move out: nothing reads
 *   `human_move` or `human_merge` — a move is a person's only when its transition names a `gate` — so
 *   one on a column with no gate is a gate the board would show and never hold a card to;
 * - **known skills**: every name a column binds is one the skill library holds (D7's `SkillService`),
 *   so a run never fails to start on `MissingSkill`;
 * - **known roles**, when the deployment's role table (`ROLE_MODELS`, B6) has any rows: a role
 *   outside it, that the harness gives no meaning to (`HARNESS_ROLES`) and that no definition the
 *   factory holds already declares, is the typo this catches — it would silently run on the
 *   deployment's model. `ROLE_MODELS` is a partial override table (any role it does not name runs on
 *   the deployment's model), so a role it does not list is not by itself a fault: the default
 *   pipeline's `specifier` and `planner` are authored under `ROLE_MODELS=reviewer=…`. With no table
 *   every role runs on the deployment's model, and any role is accepted;
 * - **no blank approval gate** in a column's `autonomy` (C22): the run's policy drops one, so it would
 *   be a gate the author believes in and nothing holds.
 *
 * Pure: the skill library, the role table and the known roles are passed in by the caller, who holds
 * them (`apps/api`'s `defineBoard` handler reads `SkillService.list` and `SessionService.roles`;
 * `TaskService.defineBoard` adds the roles the definitions it holds declare), so every rule is a case
 * in a test without a database.
 */
import type { DefineBoardInput, DefinitionFault } from "@repo/domain/Task";
import { definitionFaults, TERMINAL_COLUMNS } from "@repo/domain/Task";
import { READ_ONLY_ROLES, REVIEW_ROLES, SPEC_ROLES } from "@repo/harness";
import { HUMAN_GATE_REQUIREMENTS, KNOWN_REQUIREMENTS } from "./requirements";

/**
 * The roles the harness itself gives meaning to, with or without a `ROLE_MODELS` row: the read-only
 * stages' (`READ_ONLY_ROLES`), the specifying stage's (`SPEC_ROLES`) and the reviewer's
 * (`REVIEW_ROLES`). An authored column may always name one.
 */
export const HARNESS_ROLES: ReadonlySet<string> = new Set([
  ...READ_ONLY_ROLES.keys(),
  ...SPEC_ROLES,
  ...REVIEW_ROLES,
]);

/** What an authored version's skills and roles are checked against. */
export type DefinitionLibrary = {
  /** Every skill name the library holds, at any version. */
  readonly skills: ReadonlySet<string>;
  /** The roles the deployment's role table names; empty is a deployment with no table. */
  readonly roles: ReadonlySet<string>;
  /**
   * Roles accepted whether or not the role table names them: `HARNESS_ROLES`, and the roles the
   * definitions the factory already holds declare (the default pipeline's `planner` and `builder`
   * among them). Absent is `HARNESS_ROLES` alone.
   */
  readonly knownRoles?: ReadonlySet<string>;
};

/** The fields of `DefineBoardInput` the rules read: everything but the dry-run flag. */
export type AuthoredDefinition = Omit<DefineBoardInput, "dryRun">;

/** Every fault of `definition`, or `[]` when it may be written as a new version. */
export const authoredDefinitionFaults = (
  definition: AuthoredDefinition,
  library: DefinitionLibrary,
): ReadonlyArray<DefinitionFault> => {
  const faults: Array<DefinitionFault> = [];
  const knownRoles = library.knownRoles ?? HARNESS_ROLES;
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
    const terminalName = TERMINAL_COLUMNS.includes(column.name);
    if (
      column.kind === "terminal" &&
      !terminalName &&
      column.name.trim() !== ""
    )
      faults.push({
        field: `${at}.name`,
        message: `column "${column.name}" is terminal but not named ${TERMINAL_COLUMNS.join(" or ")}: the factory releases a finished card's worktrees, and stops counting its runs against caps, only in a column of those names (a terminal column of another name is not supported yet)`,
      });
    if (column.kind !== "terminal" && terminalName)
      faults.push({
        field: `${at}.kind`,
        message: `column "${column.name}" is named as a terminal column but is ${column.kind}: a card arriving in a column named ${TERMINAL_COLUMNS.join(" or ")} has its runs' worktrees released, so make it terminal or rename it`,
      });
    const gated = moves.some((move) => move.gate !== undefined);
    const keys = new Set<string>();
    column.requires.forEach((requirement, position) => {
      const field = `${at}.requires[${position}].key`;
      if (!KNOWN_REQUIREMENTS.has(requirement.key))
        faults.push({
          field,
          message: `column "${column.name}" requires "${requirement.key}", which is not a requirement the factory knows (${[...KNOWN_REQUIREMENTS].join(", ")})`,
        });
      if (HUMAN_GATE_REQUIREMENTS.has(requirement.key) && !gated)
        faults.push({
          field,
          message: `column "${column.name}" requires "${requirement.key}" but none of its moves out names a gate: a move is a person's only when its transition declares one ({ "to": …, "gate": … }), and nothing reads "${requirement.key}"`,
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
      !library.roles.has(column.role) &&
      !knownRoles.has(column.role)
    )
      faults.push({
        field: `${at}.role`,
        message: `column "${column.name}" names role "${column.role}", which is not in the deployment's role table (ROLE_MODELS: ${[...library.roles].sort().join(", ")}), not a role the harness knows, and not one any definition declares (${[...knownRoles].sort().join(", ")})`,
      });
    // A blank gate is dropped where the run's policy is built and shown nowhere: a gate the author
    // believes holds and none does (C22).
    (column.autonomy?.approvalRequired ?? []).forEach((gate, position) => {
      if (gate.trim() === "")
        faults.push({
          field: `${at}.autonomy.approvalRequired[${position}]`,
          message: `column "${column.name}" declares a blank approval gate: name the command a run asks a person before running, as APPROVAL_REQUIRED does ("git push")`,
        });
    });
  });

  return faults;
};
