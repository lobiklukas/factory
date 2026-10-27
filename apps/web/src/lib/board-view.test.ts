/**
 * The board's lane arithmetic (LOB-75): lanes from the definition, cards from the server's list.
 *
 * The browser drive in `.pi/skills/verify-web` proves the rendered lanes against a real board; the
 * cases here are the ones a single seeded card cannot reach — an empty lane, two cards in one lane,
 * a reordered definition, and a card in a column the definition does not declare.
 */
import type { BoardColumn, BoardDefinition, Task } from "@repo/domain/Task";
import { BoardInstanceId, DefinitionId, TaskId } from "@repo/domain/Task";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  awaitingMove,
  blockedLabel,
  boardLanes,
  moveRefusal,
  refusalIsCurrent,
  runSelection,
  offeredMoves,
  runStart,
} from "./board-view";

const column = (name: string): BoardColumn => ({
  name,
  kind: name === "intake" ? "resting" : "working",
  skills: [],
  requires: [],
});

const definition = (...names: string[]): BoardDefinition => ({
  id: Schema.decodeSync(DefinitionId)("default"),
  version: 1,
  name: "Default",
  columns: names.map(column),
});

const AT = "2026-10-27T00:00:00.000Z";
const BOARD = Schema.decodeSync(BoardInstanceId)(
  "brd_0000000000000000000000000a",
);

let minted = 0;
/** A card titled `title`; ids are minted in order, and the assertions read titles. */
const card = (
  title: string,
  columnName: string,
  extra: Partial<Task> = {},
): Task => ({
  id: Schema.decodeSync(TaskId)(
    `tsk_${String((minted += 1)).padStart(26, "0")}`,
  ),
  boardId: BOARD,
  title,
  column: columnName,
  definitionVersion: 1,
  revision: 1,
  priority: "normal",
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

describe("boardLanes", () => {
  it("makes one lane per column, in definition order, empty lanes included", () => {
    const { lanes } = boardLanes(
      definition("intake", "specifying", "done"),
      [],
    );
    expect(lanes.map((lane) => lane.column.name)).toEqual([
      "intake",
      "specifying",
      "done",
    ]);
    expect(lanes.every((lane) => lane.cards.length === 0)).toBe(true);
  });

  it("follows the definition's order, not the order cards arrive in", () => {
    const { lanes } = boardLanes(definition("review", "intake"), [
      card("a", "intake"),
      card("b", "review"),
    ]);
    expect(lanes.map((lane) => lane.column.name)).toEqual(["review", "intake"]);
    expect(lanes[0]?.cards.map((task) => task.title)).toEqual(["b"]);
    expect(lanes[1]?.cards.map((task) => task.title)).toEqual(["a"]);
  });

  it("puts each card in its own column's lane and keeps the server's order within it", () => {
    const { lanes, strays } = boardLanes(definition("intake", "specifying"), [
      card("urgent", "intake", { priority: "urgent" }),
      card("moved", "specifying"),
      card("older", "intake"),
    ]);
    expect(lanes[0]?.cards.map((task) => task.title)).toEqual([
      "urgent",
      "older",
    ]);
    expect(lanes[1]?.cards.map((task) => task.title)).toEqual(["moved"]);
    expect(strays).toEqual([]);
  });

  it("returns a card in an undeclared column as a stray instead of dropping it", () => {
    const { lanes, strays } = boardLanes(definition("intake"), [
      card("a", "intake"),
      card("lost", "triage"),
    ]);
    expect(lanes[0]?.cards.map((task) => task.title)).toEqual(["a"]);
    expect(strays.map((task) => task.title)).toEqual(["lost"]);
  });
});

describe("blockedLabel", () => {
  it("is null for a card that is not blocked", () => {
    expect(blockedLabel(card("a", "intake"))).toBeNull();
  });

  it("names the reason of a blocked card", () => {
    expect(
      blockedLabel(
        card("a", "specifying", {
          blocked: { reason: "needs_input", column: "specifying", since: AT },
        }),
      ),
    ).toBe("blocked · needs input");
  });
});

/** The default pipeline's columns and kinds (B4), as the seeded definition declares them. */
const PIPELINE: ReadonlyArray<readonly [string, BoardColumn["kind"]]> = [
  ["intake", "resting"],
  ["specifying", "working"],
  ["planning", "working"],
  ["building", "working"],
  ["review", "working"],
  ["done", "terminal"],
  ["canceled", "terminal"],
];
const pipeline = (): BoardDefinition => ({
  ...definition(),
  columns: PIPELINE.map(([name, kind]) => ({ ...column(name), kind })),
});

describe("offeredMoves", () => {
  it("offers a card in intake exactly its declared moves, and never done", () => {
    const moves = offeredMoves(card("a", "intake"), pipeline());
    expect(moves.map((move) => move.to)).toEqual(["specifying", "canceled"]);
    expect(moves.map((move) => move.to)).not.toContain("done");
    expect(moves.every((move) => move.gate === undefined)).toBe(true);
  });

  it("marks the two human gates and only them", () => {
    const planning = offeredMoves(card("p", "planning"), pipeline());
    expect(planning.map((move) => [move.to, move.gate])).toEqual([
      ["building", "plan approval"],
      ["canceled", undefined],
    ]);
    const review = offeredMoves(card("r", "review"), pipeline());
    expect(review.map((move) => [move.to, move.gate])).toEqual([
      ["done", "merge"],
      ["canceled", undefined],
    ]);
    const building = offeredMoves(card("b", "building"), pipeline());
    expect(building.find((move) => move.to === "review")?.gate).toBeUndefined();
  });

  it("offers nothing out of a terminal column", () => {
    expect(offeredMoves(card("d", "done"), pipeline())).toEqual([]);
    expect(offeredMoves(card("c", "canceled"), pipeline())).toEqual([]);
  });

  it("carries the target's kind, and keeps a target the definition lacks with none", () => {
    const moves = offeredMoves(card("a", "intake"), definition("intake"));
    expect(moves.map((move) => [move.to, move.kind])).toEqual([
      ["specifying", undefined],
      ["canceled", undefined],
    ]);
    expect(
      offeredMoves(card("a", "intake"), pipeline()).map((move) => move.kind),
    ).toEqual(["working", "terminal"]);
  });
});

describe("runStart", () => {
  it("allows a run in a working column, from that column", () => {
    expect(runStart(card("s", "specifying"), pipeline())).toEqual({
      allowed: true,
      column: "specifying",
    });
  });

  it("refuses intake, a terminal column, and an undeclared column, saying why", () => {
    const intake = runStart(card("i", "intake"), pipeline());
    expect(intake.allowed).toBe(false);
    if (intake.allowed) throw new Error("unreachable");
    expect(intake.reason).toContain("resting");
    const done = runStart(card("d", "done"), pipeline());
    expect(done.allowed).toBe(false);
    if (done.allowed) throw new Error("unreachable");
    expect(done.reason).toContain("terminal");
    const stray = runStart(card("x", "triage"), pipeline());
    expect(stray.allowed).toBe(false);
    if (stray.allowed) throw new Error("unreachable");
    expect(stray.reason).toContain("triage");
  });
});

describe("moveRefusal", () => {
  it("keeps the service's message verbatim under a heading per refusal", () => {
    const message =
      "task tsk_x is at revision 3, not 1: someone moved it first";
    expect(
      moveRefusal({ _tag: "StaleRevision", message, actual: 3 }, "fallback", 1),
    ).toEqual({
      tag: "StaleRevision",
      title: "Someone changed this card first",
      message,
      atRevision: 3,
    });
    expect(
      moveRefusal(
        { _tag: "HumanGateRequired", message: "crosses the merge gate" },
        "",
        2,
      ),
    ).toMatchObject({
      title: "Only a person can make this move",
      atRevision: 2,
    });
    // LOB-80: an unmet exit requirement keeps the service's words, which name the requirement.
    const unmet =
      'the move review → done needs "verified" (a passing verification of every surface the card\'s change touched), which is not met: the card has no runs, so nothing verified its change';
    expect(
      moveRefusal({ _tag: "RequirementUnmet", message: unmet }, "", 5),
    ).toEqual({
      tag: "RequirementUnmet",
      title: "This column's exit requirement is not met",
      message: unmet,
      atRevision: 5,
    });
  });

  it("does not dress a failure that is not a typed refusal up as one", () => {
    expect(moveRefusal(undefined, "connection refused", 4)).toEqual({
      tag: "Unknown",
      title: "The move did not go through",
      message: "connection refused",
      atRevision: 4,
    });
    expect(
      moveRefusal({ _tag: "RpcClientError", message: "" }, "timed out", 4),
    ).toEqual({
      tag: "RpcClientError",
      title: "The move did not go through",
      message: "timed out",
      atRevision: 4,
    });
  });
});

describe("refusalIsCurrent", () => {
  const stale = moveRefusal(
    { _tag: "StaleRevision", message: "at 3, not 1", actual: 3 },
    "",
    1,
  );

  it("keeps a stale refusal through the refetch that shows the revision it named", () => {
    expect(refusalIsCurrent(stale, { revision: 1 })).toBe(true);
    expect(refusalIsCurrent(stale, { revision: 3 })).toBe(true);
  });

  it("drops the refusal once the card moves past it", () => {
    expect(refusalIsCurrent(stale, { revision: 4 })).toBe(false);
    expect(refusalIsCurrent(null, { revision: 1 })).toBe(false);
  });
});

describe("awaitingMove", () => {
  it("holds the moves until the board shows the revision the move landed at", () => {
    expect(awaitingMove(null, { revision: 1 })).toBe(false);
    expect(awaitingMove(2, { revision: 1 })).toBe(true);
    expect(awaitingMove(2, { revision: 2 })).toBe(false);
    expect(awaitingMove(2, { revision: 5 })).toBe(false);
  });
});

describe("runSelection", () => {
  const runs = [{ sessionId: "ses_a" }, { sessionId: "ses_b" }];

  it("opens a run only when the card lists it", () => {
    expect(runSelection(undefined, runs, false)).toBe("none");
    expect(runSelection("ses_a", runs, false)).toBe("member");
    expect(runSelection("ses_other", runs, false)).toBe("foreign");
  });

  it("waits rather than refusing while the card's runs are still being read", () => {
    expect(runSelection("ses_a", undefined, false)).toBe("loading");
    expect(runSelection("ses_new", runs, true)).toBe("loading");
  });
});
