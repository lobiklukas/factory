import { Console, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { SessionError } from "@repo/domain/Session";
import {
  BoardInstanceId,
  type ColumnMapping,
  type UpgradedBoard,
} from "@repo/domain/Task";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { BoardClient } from "../rpc";

/**
 * `factory board upgrade` (D5): move a board to a newer version of its definition, and — when asked —
 * migrate its cards to it.
 *
 * Without a mapping only the board's pin moves: a card made afterwards pins the new version, and every
 * card already on the board keeps the one it pinned, its moves and exits unchanged (B2). With one
 * (`--map from=to`, repeated, and/or `--same-columns`), every card not already on the version is
 * re-pinned in the column the mapping names for its own, each with a `repinned` event on its history.
 * The batch is all or nothing: a card with an unfinished run, or in a column the mapping does not
 * name, refuses the whole upgrade — the server's `card_migration_refused`, naming every such card —
 * and nothing is written. `--expect-version` is the version the caller read the board at, as a move's
 * `--expect-revision` is: a board someone upgraded first is `stale_board_version`.
 */

const apiFlag = Flag.String("api").pipe(
  Flag.withDescription("Control plane base URL"),
  Flag.optional,
);

const invalidInput = (message: string) =>
  new SessionError({ code: "invalid_input", message });

/**
 * The column mapping the flags mean, or `invalid_input` and no request: `--same-columns` maps each of
 * `targetColumns` (the version's own) to itself, and each `--map from=to` sets one entry over it —
 * so `--same-columns --map doing=review` is "keep every name, but `doing` is now `review`". A `--map`
 * with no `=`, an empty side, or one source named twice is refused. `undefined` when neither flag was
 * given: the upgrade moves the pin only.
 */
export const upgradeMapping = (flags: {
  readonly maps: ReadonlyArray<string>;
  readonly sameColumns: boolean;
  readonly targetColumns: ReadonlyArray<string>;
}): Effect.Effect<ColumnMapping | undefined, SessionError> =>
  Effect.gen(function* () {
    if (!flags.sameColumns && flags.maps.length === 0) return undefined;
    const mapping: Record<string, string> = {};
    if (flags.sameColumns)
      for (const column of flags.targetColumns) mapping[column] = column;
    const named = new Set<string>();
    for (const entry of flags.maps) {
      const at = entry.indexOf("=");
      const from = at < 0 ? "" : entry.slice(0, at).trim();
      const to = at < 0 ? "" : entry.slice(at + 1).trim();
      if (from === "" || to === "") {
        return yield* invalidInput(
          `--map "${entry}" is not a column mapping: write it from=to, a column the cards are in and the new version's column they go to`,
        );
      }
      if (named.has(from)) {
        return yield* invalidInput(
          `--map names ${from} twice: a column's cards go to one column`,
        );
      }
      named.add(from);
      mapping[from] = to;
    }
    return mapping;
  });

/**
 * What `board upgrade` prints: the board and the versions it moved between, one line per card it
 * re-pinned — the card, the version and column it left, the column it is in and its new revision —
 * and how many cards still pin another version, which `--same-columns` (or `--map`) at the pin moves.
 */
export const upgradedLines = (
  upgraded: UpgradedBoard,
): ReadonlyArray<string> => {
  const { instance } = upgraded;
  const to = instance.definitionVersion;
  return [
    upgraded.fromVersion === to
      ? `board       ${instance.id} stays on ${instance.definitionId} v${to}`
      : `upgraded    ${instance.id} ${instance.definitionId} v${upgraded.fromVersion} → v${to}`,
    ...upgraded.repinned.map(
      (card) =>
        `repinned    ${card.taskId} v${card.fromVersion} ${card.from} → v${to} ${card.to} (revision ${card.revision})`,
    ),
    upgraded.unmigrated === 0
      ? `cards       every card pins v${to}`
      : `cards       ${upgraded.unmigrated} ${upgraded.unmigrated === 1 ? "card still pins" : "cards still pin"} an older version and moves by it; migrate with --same-columns or --map`,
  ];
};

const upgradeCommand = Command.make(
  "upgrade",
  {
    board: Flag.String("board").pipe(
      Flag.withDescription("Board instance id (brd_…)"),
    ),
    to: Flag.Int("to").pipe(
      Flag.withDescription("The definition version the board moves to"),
    ),
    expectVersion: Flag.Int("expect-version").pipe(
      Flag.withDescription(
        "The version the board is pinned to now, as you read it (board config)",
      ),
    ),
    maps: Flag.String("map").pipe(
      Flag.withDescription(
        "Migrate the cards: a column they are in = the new version's column they go to (repeatable)",
      ),
      Flag.atLeast(0),
    ),
    sameColumns: Flag.Boolean("same-columns").pipe(
      Flag.withDescription(
        "Migrate the cards, each to the column of the same name in the new version",
      ),
      Flag.withDefault(false),
    ),
    actor: Flag.String("actor").pipe(
      Flag.withDescription(
        "Who migrates the cards, as their repinned events record it. Ignored by a control plane that authenticates (FACTORY_API_TOKEN)",
      ),
      Flag.withDefault("cli"),
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({
    board,
    to,
    expectVersion,
    maps,
    sameColumns,
    actor,
    api,
  }) {
    const apiUrl = yield* resolveApiUrl(api);
    const boardId = Option.getOrUndefined(
      Schema.decodeOption(BoardInstanceId)(board),
    );
    if (boardId === undefined) {
      return yield* reportFailure(
        "invalid_input",
        `--board "${board}" is not a board id (brd_…)`,
      );
    }
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      // The target version's columns, read only for `--same-columns`: what "the same name" means.
      const targetColumns = sameColumns
        ? (yield* client.getDefinition({
            definitionId: (yield* client.getBoard({ boardId })).instance
              .definitionId,
            version: to,
          })).columns.map((column) => column.name)
        : [];
      const mapping = yield* upgradeMapping({
        maps,
        sameColumns,
        targetColumns,
      });
      const upgraded = yield* client.upgradeBoard({
        boardId,
        toVersion: to,
        expectedVersion: expectVersion,
        ...(mapping === undefined ? {} : { migrateCards: mapping }),
        actor,
      });
      for (const line of upgradedLines(upgraded)) yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Move a board to a newer definition version; with --same-columns or --map, migrate its cards too",
  ),
  Command.withExamples([
    {
      command: "factory board upgrade --board brd_… --to 3 --expect-version 2",
      description: "New cards pin v3; existing cards keep v2",
    },
    {
      command:
        "factory board upgrade --board brd_… --to 3 --expect-version 2 --same-columns",
      description: "Move the board and every card to v3, column for column",
    },
    {
      command:
        "factory board upgrade --board brd_… --to 4 --expect-version 3 --same-columns --map doing=review",
      description: "Migrate cards, sending the old doing column's cards to review",
    },
  ]),
);

/** The upgrade verb, mounted under `factory board` beside the configuration verbs. */
export const boardUpgradeCommands = [upgradeCommand] as const;
