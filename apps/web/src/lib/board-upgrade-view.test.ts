/** The settings page's Upgrade action (D5): the mapping it offers and sends, and what it says. */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  BoardInstanceId,
  CardMigrationRefused,
  StaleBoardVersion,
  TaskId,
  UpgradedBoard,
} from "@repo/domain/Task";
import {
  defaultMapping,
  mappingChoices,
  mappingSources,
  mappingOf,
  upgradeTargets,
  upgradedSummary,
  upgradeInputOf,
  upgradeRefusal,
} from "./board-upgrade-view";

const BOARD = BoardInstanceId.make(`brd_${"1".repeat(26)}`);
const TASK = TaskId.make(`tsk_${"0".repeat(26)}`);

describe("defaultMapping", () => {
  /** Mutation: map an unmatched column to the target's first — a card would land somewhere unasked. */
  it("offers each pinned column the target's column of its name, and nothing for one it lacks", () => {
    expect(
      defaultMapping(["todo", "doing", "done"], ["todo", "review", "done"]),
    ).toEqual([
      { from: "todo", to: "todo" },
      { from: "doing", to: undefined },
      { from: "done", to: "done" },
    ]);
  });
});

describe("upgradeTargets", () => {
  /**
   * Mutation: offer newer versions only — after a pin-only upgrade to the newest version, the cards
   * left behind can never be re-pinned from the dashboard.
   */
  it("offers the newer versions, and the pin itself while a card still pins an older one", () => {
    expect(upgradeTargets(3, [4, 5], [{ column: "a", definitionVersion: 3 }])).toEqual(
      [4, 5],
    );
    expect(upgradeTargets(3, [], [{ column: "a", definitionVersion: 3 }])).toEqual(
      [],
    );
    expect(
      upgradeTargets(3, [], [
        { column: "a", definitionVersion: 3 },
        { column: "b", definitionVersion: 2 },
      ]),
    ).toEqual([3]);
  });
});

describe("mappingSources", () => {
  const cards = [
    { column: "todo", definitionVersion: 2 },
    { column: "doing", definitionVersion: 1 },
    {
      column: "review",
      definitionVersion: 1,
      blocked: { column: "parked" },
    },
  ];

  /**
   * Mutation: build the rows from the pin's columns only — a v1 card in `doing`, which the v2 pin
   * renamed, has no row, and the batch is always refused as unmapped.
   */
  it("gives a row to each column of the pin, then each column a card left on an older version sits or is blocked in", () => {
    expect(
      mappingSources({
        pin: 2,
        pinnedColumns: ["todo", "review", "done"],
        target: 3,
        cards,
      }),
    ).toEqual(["todo", "review", "done", "doing", "parked"]);
  });

  /** Mutation: keep the pin's columns at the pin — rows for cards that are not migrated at all. */
  it("at the pin, gives rows only to the columns of the cards left behind", () => {
    expect(
      mappingSources({
        pin: 2,
        pinnedColumns: ["todo", "review", "done"],
        target: 2,
        cards,
      }),
    ).toEqual(["doing", "review", "parked"]);
  });
});

describe("mappingChoices", () => {
  /** Mutation: offer every column for every row — `building` could be sent past its exit to `review`. */
  it("keeps a column the target still declares, and offers a renamed or dropped one every column", () => {
    expect(mappingChoices("building", ["building", "review"])).toEqual([
      "building",
    ]);
    expect(mappingChoices("doing", ["building", "review"])).toEqual([
      "building",
      "review",
    ]);
  });
});

describe("upgradeInputOf", () => {
  const rows = [
    { from: "todo", to: "todo" },
    { from: "doing", to: undefined },
  ];

  /** Mutation: send the mapping without the person asking — every card would be migrated. */
  it("sends the pin it read as the expected version, and the mapping only when asked to migrate", () => {
    expect(
      upgradeInputOf({
        boardId: BOARD,
        pinned: 2,
        toVersion: 3,
        migrate: false,
        rows,
        actor: "dashboard",
      }),
    ).toEqual({
      boardId: BOARD,
      toVersion: 3,
      expectedVersion: 2,
      actor: "dashboard",
    });
    expect(
      upgradeInputOf({
        boardId: BOARD,
        pinned: 2,
        toVersion: 3,
        migrate: true,
        rows,
        actor: "dashboard",
      }),
    ).toEqual({
      boardId: BOARD,
      toVersion: 3,
      expectedVersion: 2,
      migrateCards: { todo: "todo" },
      actor: "dashboard",
    });
    expect(mappingOf([{ from: "a", to: "b" }])).toEqual({ a: "b" });
  });
});

describe("upgradedSummary", () => {
  const instance = {
    id: BOARD,
    repo: "acme/widgets",
    definitionId: "default",
    definitionVersion: 3,
    createdAt: "2026-10-28T00:00:00.000Z",
  };
  it("says what moved, what was migrated and what was left behind", () => {
    const decode = Schema.decodeUnknownSync(UpgradedBoard);
    expect(
      upgradedSummary(
        decode({ instance, fromVersion: 2, repinned: [], unmigrated: 2 }),
      ),
    ).toBe(
      "Upgraded from v2 to v3: new cards pin v3. 2 cards still pin an older version and move by it.",
    );
    expect(
      upgradedSummary(
        decode({
          instance,
          fromVersion: 3,
          repinned: [
            {
              taskId: TASK,
              fromVersion: 2,
              from: "review",
              to: "review",
              revision: 4,
            },
          ],
          unmigrated: 0,
        }),
      ),
    ).toBe("The board stays on v3. 1 card was migrated. Every card pins v3.");
  });
});

describe("upgradeRefusal", () => {
  /** Mutation: show the message alone — the cards holding the batch would not be listed. */
  it("lists every card a refused migration names, and gives any other refusal's message", () => {
    expect(
      upgradeRefusal(
        new CardMigrationRefused({
          boardId: BOARD,
          cards: [{ taskId: TASK, column: "doing", reason: "unfinished_run" }],
          message:
            "the board's cards cannot all move to default v3, so none did",
        }),
        "pretty",
      ),
    ).toEqual({
      message: "the board's cards cannot all move to default v3, so none did",
      cards: [`${TASK} (doing) has an unfinished run`],
    });
    expect(
      upgradeRefusal(
        new StaleBoardVersion({
          boardId: BOARD,
          expected: 2,
          actual: 3,
          message: "stale",
        }),
        "pretty",
      ),
    ).toEqual({ message: "stale", cards: [] });
    expect(upgradeRefusal(undefined, "pretty")).toEqual({
      message: "pretty",
      cards: [],
    });
  });
});
