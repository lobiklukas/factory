import { Schema } from "effect";
import {
  type BoardInstanceId,
  CardMigrationRefused,
  type ColumnMapping,
  type UpgradeBoardInput,
  type UpgradedBoard,
} from "@repo/domain/Task";

/**
 * The settings page's Upgrade action (D5): what it offers, what it sends to `upgradeBoard` and what it
 * says about the answer. Pure, so the mapping a person is shown first — and what an unmapped column
 * means — is a unit case, not something only a screenshot shows.
 *
 * The migration is explicit: the page sends one only when the person asks for it, and the mapping is
 * the one on screen, row by row. A column of the pinned version is offered the target's column of
 * the same name when there is one, and nothing otherwise — never a guess — so a card in it refuses
 * the batch, named by the server, until the person picks where its cards go.
 */

/** One row of the mapping form: a column of the pinned version and where its cards go, if anywhere. */
export type MappingRow = {
  readonly from: string;
  readonly to: string | undefined;
};

/** The mapping the page offers first: each pinned column to the target's column of its name. */
export const defaultMapping = (
  pinned: ReadonlyArray<string>,
  target: ReadonlyArray<string>,
): ReadonlyArray<MappingRow> =>
  pinned.map((from) => ({
    from,
    to: target.includes(from) ? from : undefined,
  }));

/** The rows a person mapped, as `upgradeBoard` takes them: an unmapped row is left out, not guessed. */
export const mappingOf = (rows: ReadonlyArray<MappingRow>): ColumnMapping =>
  Object.fromEntries(
    rows.flatMap((row) => (row.to === undefined ? [] : [[row.from, row.to]])),
  );

/**
 * The `upgradeBoard` payload the form means: at the version the page read the board at, so a board
 * someone upgraded meanwhile is refused (`StaleBoardVersion`) rather than moved twice; with the
 * mapping only when the person chose to migrate the cards.
 */
export const upgradeInputOf = (form: {
  readonly boardId: BoardInstanceId;
  readonly pinned: number;
  readonly toVersion: number;
  readonly migrate: boolean;
  readonly rows: ReadonlyArray<MappingRow>;
  readonly actor: string;
}): UpgradeBoardInput => ({
  boardId: form.boardId,
  toVersion: form.toVersion,
  expectedVersion: form.pinned,
  ...(form.migrate ? { migrateCards: mappingOf(form.rows) } : {}),
  actor: form.actor,
});

/** What the page says once the upgrade landed: the move, the cards re-pinned, the cards left behind. */
export const upgradedSummary = (upgraded: UpgradedBoard): string => {
  const to = upgraded.instance.definitionVersion;
  const moved =
    upgraded.fromVersion === to
      ? `The board stays on v${to}.`
      : `Upgraded from v${upgraded.fromVersion} to v${to}: new cards pin v${to}.`;
  const repinned =
    upgraded.repinned.length === 0
      ? ""
      : ` ${upgraded.repinned.length} ${upgraded.repinned.length === 1 ? "card was" : "cards were"} migrated.`;
  const behind =
    upgraded.unmigrated === 0
      ? ` Every card pins v${to}.`
      : upgraded.unmigrated === 1
        ? " 1 card still pins an older version and moves by it."
        : ` ${upgraded.unmigrated} cards still pin an older version and move by it.`;
  return `${moved}${repinned}${behind}`;
};

const REASON_WORDS = {
  unfinished_run: "has an unfinished run",
  unmapped_column: "is in a column the mapping does not name",
  kind_changed: "would land in a column of another kind",
} as const;

/**
 * What a refused upgrade shows: the server's message, and — for a refused migration — one line per
 * card it named, so a person sees which cards hold the batch and why. `error` is the call's typed
 * failure when it had one; `pretty` is the cause, for anything else.
 */
export const upgradeRefusal = (
  error: unknown,
  pretty: string,
): { readonly message: string; readonly cards: ReadonlyArray<string> } =>
  Schema.is(CardMigrationRefused)(error)
    ? {
        message: error.message,
        cards: error.cards.map(
          (card) =>
            `${card.taskId} (${card.column}) ${REASON_WORDS[card.reason]}`,
        ),
      }
    : {
        message:
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
            ? error.message
            : pretty,
        cards: [],
      };
