import type {
  BoardCaps,
  DefinitionSummary,
  RequirementConfig,
  ResolvedModel,
} from "@repo/domain/Task";

/**
 * The board settings view (LOB-245): what `/boards/$boardId/settings` and a lane header's disclosure say
 * about a definition version, worded from `getDefinition`'s description of it and nothing else.
 *
 * Read-only on purpose. A version is never edited in place (docs/board.md B2), so the page explains
 * what the board's pinned version does; authoring a new version is another change. Pure, so the
 * wording a reader depends on — "not yet checked", the gate on a move, "a newer version exists" — is
 * a unit case rather than something only a screenshot shows.
 */

/** What a field with nothing in it shows: one glyph, so "none" never reads as a value (as the CLI). */
export const NONE = "—";

/** How a requirement's state reads: `checked` is refused over on a move today; the rest only declared. */
export type RequirementState = "checked" | "not yet checked";

/**
 * A requirement as the board checks it today (LOB-270): `checked` when a move out of the column is
 * refused while it is unmet, `not yet checked` when the definition declares it and nothing enforces
 * it yet — a reader must not take a declared key for a gate.
 */
export const requirementState = (
  requirement: Pick<RequirementConfig, "checked">,
): RequirementState => (requirement.checked ? "checked" : "not yet checked");

/**
 * Where a column's model came from (B6): the role's row in the deployment's `ROLE_MODELS`, or the
 * deployment's own model for a role with no row and a column with no role.
 */
export const modelSource = (model: ResolvedModel): string =>
  model.source === "role" ? "role model" : "deployment default";

/**
 * The versions of `definitionId` newer than `version`, oldest first, from `listDefinitions`. Empty when
 * the board pins the newest — or when the list does not name the definition at all, which says nothing
 * about newer versions and so claims none.
 */
export const newerVersions = (
  definitions: ReadonlyArray<DefinitionSummary>,
  definitionId: string,
  version: number,
): ReadonlyArray<number> =>
  (
    definitions.find((definition) => definition.id === definitionId)
      ?.versions ?? []
  )
    .map((summary) => summary.version)
    .filter((candidate) => candidate > version)
    .toSorted((a, b) => a - b);

const versionList = (versions: ReadonlyArray<number>): string => {
  const named = versions.map((version) => `v${version}`);
  return named.length <= 1
    ? named.join("")
    : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
};

/**
 * What the page says about the versions after the one the board pins, or `null` when it pins the
 * newest. The board stays on its version (B2): a new version reaches the next board, never this one,
 * so the sentence says both, and which version a board made today would pin.
 */
export const newerVersionsNotice = (
  definitionId: string,
  pinned: number,
  newer: ReadonlyArray<number>,
): string | null => {
  const newest = newer.at(-1);
  if (newest === undefined) return null;
  const which =
    newer.length === 1
      ? `A newer version of ${definitionId} exists: ${versionList(newer)}.`
      : `Newer versions of ${definitionId} exist: ${versionList(newer)}.`;
  return `${which} This board stays pinned to v${pinned}; a board created now pins v${newest}.`;
};

/** A version's run caps (B9, LOB-71) in one line, or `null` when it declares none: as the CLI prints them. */
export const capsLabel = (caps: BoardCaps | undefined): string | null => {
  if (caps === undefined) return null;
  const declared = (["board", "task", "repo"] as const).flatMap((kind) =>
    caps[kind] === undefined ? [] : [`${kind} ${caps[kind]}`],
  );
  return declared.length === 0
    ? null
    : `${declared.join(" · ")} runs in flight`;
};

/** A column's WIP limit (LOB-71) as a reader is told it, or `null` for a column that declares none. */
export const wipLabel = (wipLimit: number | undefined): string | null =>
  wipLimit === undefined
    ? null
    : `at most ${wipLimit} run${wipLimit === 1 ? "" : "s"} in flight`;
