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
import { blockedLabel, boardLanes } from "./board-view";

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
