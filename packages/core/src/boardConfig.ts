/**
 * What a board definition version does, described for a reader (LOB-270): an operator or a reviewer
 * sees what a board will do before trusting it, rather than reading migrations and constants.
 *
 * A definition row declares columns; three more facts decide what a card on it meets, and none of
 * them is in the row. This module joins them onto each column, each from the one place that already
 * decides it, so the description cannot drift from what a move or a run actually does:
 *
 * - **Exits and human gates** are `@repo/domain/Task`'s `declaredTransitions` and `humanGate`, the
 *   tables `TaskService.move` refuses by and the card pane offers by (`BoardColumn` carries no
 *   transitions yet). A column those tables do not name has no exits.
 * - **Whether a requirement is checked** is `./requirements`' `CHECKED_REQUIREMENTS`. A declared key
 *   outside it is `checked: false`: nothing refuses a move over it today, and a reader is told so.
 *   The `human_*` keys are among them — the gate is enforced by the move's actor, which the exit
 *   marks, not by a requirement check.
 * - **The role's model** is the deployment's role table (B6, `ROLE_MODELS`), which only the process
 *   that resolved it knows; the caller passes its resolution in (`SessionService.roleModel`).
 *
 * Pure, so the whole description is a table in a test.
 */
import type {
  BoardDefinition,
  ColumnConfig,
  DefinitionConfig,
  ResolvedModel,
} from "@repo/domain/Task";
import { declaredTransitions, humanGate } from "@repo/domain/Task";
import { CHECKED_REQUIREMENTS } from "./requirements";

/** The model a run with `role` talks to; `undefined` is a column with no role. */
export type RoleModelOf = (role: string | undefined) => ResolvedModel;

/** One column of `definition`, described: its exits, its requirements' status and its model. */
const describeColumn = (
  column: BoardDefinition["columns"][number],
  modelOf: RoleModelOf,
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
  exits: declaredTransitions(column.name).map((to) => {
    const gate = humanGate(column.name, to);
    return gate === undefined ? { to } : { to, humanGate: gate };
  }),
});

/** A definition version described, its columns in declaration order. */
export const describeDefinition = (
  definition: BoardDefinition,
  modelOf: RoleModelOf,
): DefinitionConfig => ({
  id: definition.id,
  version: definition.version,
  name: definition.name,
  columns: definition.columns.map((column) => describeColumn(column, modelOf)),
});
