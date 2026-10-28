/**
 * What `factory board upgrade` (D5) sends and prints. The command itself is proven against a real
 * control plane by `.pi/skills/verify-board/upgrade.sh`; these cases pin the mapping the flags mean —
 * the part a refusal from the server would not localize — and the printed lines.
 */
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { TaskId, UpgradedBoard } from "@repo/domain/Task";
import { upgradedLines, upgradeMapping } from "./boardUpgrade";

const mapping = (flags: Parameters<typeof upgradeMapping>[0]) =>
  Effect.runSyncExit(upgradeMapping(flags));

const TASK = TaskId.make(`tsk_${"0".repeat(26)}`);

describe("upgradeMapping", () => {
  /** Mutation: send an empty mapping when no flag names one — every card would be migrated. */
  it("sends no mapping without --map or --same-columns: only the pin moves", () => {
    expect(
      mapping({ maps: [], sameColumns: false, targetColumns: ["a"] }),
    ).toEqual(Exit.succeed(undefined));
  });

  /** Mutation: apply --same-columns after --map — `doing=review` is overwritten back to `doing`. */
  it("maps every column of the version to itself, with --map overriding one entry", () => {
    expect(
      mapping({
        maps: ["doing=review", " old = todo "],
        sameColumns: true,
        targetColumns: ["todo", "review", "doing"],
      }),
    ).toEqual(
      Exit.succeed({
        todo: "todo",
        review: "review",
        doing: "review",
        old: "todo",
      }),
    );
  });

  it("refuses a --map that is not from=to, or names one source twice, as invalid_input", () => {
    for (const maps of [["doing"], ["=review"], ["doing="], ["a=b", "a=c"]]) {
      const exit = mapping({ maps, sameColumns: false, targetColumns: [] });
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(JSON.stringify(exit.cause)).toContain("invalid_input");
    }
  });
});

describe("upgradedLines", () => {
  const instance = {
    id: `brd_${"1".repeat(26)}`,
    repo: "acme/widgets",
    definitionId: "default",
    definitionVersion: 3,
    createdAt: "2026-10-28T00:00:00.000Z",
  };

  it("prints the move, each card re-pinned, and the cards left on another version", () => {
    const upgraded = Schema.decodeUnknownSync(UpgradedBoard)({
      instance,
      fromVersion: 2,
      repinned: [
        {
          taskId: TASK,
          fromVersion: 2,
          from: "review",
          to: "review",
          revision: 5,
        },
      ],
      unmigrated: 1,
    });
    expect(upgradedLines(upgraded)).toEqual([
      `upgraded    ${instance.id} default v2 → v3`,
      `repinned    ${TASK} v2 review → v3 review (revision 5)`,
      "cards       1 card still pins an older version and moves by it; migrate with --same-columns or --map",
    ]);
  });

  it("says the board stayed when a migration ran at the pin, and when every card is on it", () => {
    const upgraded = Schema.decodeUnknownSync(UpgradedBoard)({
      instance,
      fromVersion: 3,
      repinned: [],
      unmigrated: 0,
    });
    expect(upgradedLines(upgraded)).toEqual([
      `board       ${instance.id} stays on default v3`,
      "cards       every card pins v3",
    ]);
  });
});
