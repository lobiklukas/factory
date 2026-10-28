/**
 * What a board definition version does, described for a reader (LOB-270): an operator or a reviewer
 * sees what a board will do before trusting it, rather than reading migrations and constants.
 *
 * A definition row declares columns; more facts decide what a card on it meets, and not all of them
 * are in the row as written. This module joins them onto each column, each from the one place that
 * already decides it, so the description cannot drift from what a move or a run actually does:
 *
 * - **Exits and human gates** are `@repo/domain/Task`'s `columnTransitions`, which `TaskService.move`
 *   refuses by and the card pane offers by: the column's own `transitions` (LOB-267), or the default
 *   pipeline's table for a version that declares none (default versions 1–3). The **initial column**
 *   is `initialColumnOf`, the one `TaskService.create` puts a new card in.
 * - **Whether a requirement is checked** is `./requirements`' `CHECKED_REQUIREMENTS`. A declared key
 *   outside it is `checked: false`: nothing refuses a move over it today, and a reader is told so.
 *   The `human_*` keys are among them — the gate is enforced by the move's actor, which the exit
 *   marks, not by a requirement check.
 * - **Run caps and WIP limits** (B9, LOB-71) are the row's own, copied as declared: what
 *   `SessionService.create` refuses a card's start by (`./boardCaps`).
 * - **The role's model** is the deployment's role table (B6, `ROLE_MODELS`), which only the process
 *   that resolved it knows; the caller passes its resolution in (`SessionService.roleModel`).
 * - **The column's autonomy** (C22) is the deployment's (`APPROVAL_REQUIRED`, D11) narrowed by what
 *   the column declares, its role and skills included — again only the process knows the
 *   deployment's half, so the caller passes it in (`SessionService.columnAutonomy`), which builds it
 *   with the functions a run's policy is built with.
 *
 * Pure, so the whole description is a table in a test.
 */
import type {
  BoardDefinition,
  ColumnConfig,
  DefinitionConfig,
  ResolvedAutonomy,
  ResolvedModel,
} from "@repo/domain/Task";
import { columnTransitions, initialColumnOf } from "@repo/domain/Task";
import { CHECKED_REQUIREMENTS } from "./requirements";

/** The model a run with `role` talks to; `undefined` is a column with no role. */
export type RoleModelOf = (role: string | undefined) => ResolvedModel;

/** What a run in a column may do without asking (C22), the deployment's policy narrowed by it. */
export type AutonomyOf = (
  column: BoardDefinition["columns"][number],
) => ResolvedAutonomy;

/** What the description reads from the deployment: the role table and the autonomy policy. */
export type DeploymentFacts = {
  readonly modelOf: RoleModelOf;
  readonly autonomyOf: AutonomyOf;
};

/** One column of `definition`, described: its exits, its requirements' status, its model and autonomy. */
const describeColumn = (
  definition: BoardDefinition,
  column: BoardDefinition["columns"][number],
  { modelOf, autonomyOf }: DeploymentFacts,
): ColumnConfig => ({
  name: column.name,
  kind: column.kind,
  ...(column.role === undefined ? {} : { role: column.role }),
  model: modelOf(column.role),
  skills: column.skills,
  requires: column.requires.map((requirement) => ({
    key: requirement.key,
    description: requirement.description,
    checked: CHECKED_REQUIREMENTS.has(requirement.key),
  })),
  exits: columnTransitions(definition, column.name).map(({ to, gate }) =>
    gate === undefined ? { to } : { to, humanGate: gate },
  ),
  ...(column.wipLimit === undefined ? {} : { wipLimit: column.wipLimit }),
  autonomy: autonomyOf(column),
});

/** A definition version described, its columns in declaration order. */
export const describeDefinition = (
  definition: BoardDefinition,
  deployment: DeploymentFacts,
): DefinitionConfig => {
  const initialColumn = initialColumnOf(definition);
  return {
    id: definition.id,
    version: definition.version,
    name: definition.name,
    ...(initialColumn === undefined ? {} : { initialColumn }),
    ...(definition.caps === undefined ? {} : { caps: definition.caps }),
    ...(definition.author === undefined ? {} : { author: definition.author }),
    columns: definition.columns.map((column) =>
      describeColumn(definition, column, deployment),
    ),
  };
};
