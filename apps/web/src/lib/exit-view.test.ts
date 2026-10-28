/**
 * The exit checklist's wording and the move warning (D9): the cases a seeded board cannot reach in
 * one render — a stale read of another column, a move into `canceled`, an unchecked key. The browser
 * drive (`.pi/skills/verify-web/exit-checklist.sh`) proves the rendered list against `getTaskExit`.
 */
import { Schema } from "effect";
import { Task, TaskExit } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import { currentExit, exitStatusLabel, moveWarning } from "./exit-view";

const ID = `tsk_${"0".repeat(26)}`;

const task = (column: string): Task =>
  Schema.decodeSync(Task)({
    id: ID,
    boardId: `brd_${"0".repeat(26)}`,
    title: "a card",
    column,
    priority: "normal",
    revision: 3,
    definitionVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

const exit = (column: string): TaskExit =>
  Schema.decodeSync(TaskExit)({
    taskId: ID,
    column,
    revision: 3,
    requirements: [
      { key: "human_move", description: "a human move", status: "unchecked" },
      {
        key: "spec_doc",
        description: "a spec",
        status: "unmet",
        reason: "the card has no spec",
      },
      { key: "pr_link", description: "a PR", status: "met" },
    ],
  });

describe("exitStatusLabel", () => {
  it("says an unchecked key is not checked, never met", () => {
    expect(exitStatusLabel("met")).toBe("met");
    expect(exitStatusLabel("unmet")).toBe("unmet");
    expect(exitStatusLabel("unchecked")).toBe("not checked");
  });
});

describe("currentExit", () => {
  /** Mutation: ignore the column — a moved card shows the column it left's checklist. */
  it("is the read only while it is of the card's own column", () => {
    expect(currentExit(exit("specifying"), task("specifying"))).not.toBeNull();
    expect(currentExit(exit("specifying"), task("planning"))).toBeNull();
    expect(currentExit(undefined, task("planning"))).toBeNull();
  });
});

describe("moveWarning", () => {
  /** Mutation: warn on unchecked keys too — `human_move` would hold every move out of planning. */
  it("names each unmet key with the server's reason, and passes unchecked and met ones", () => {
    expect(moveWarning(exit("specifying"), "planning")).toEqual([
      { key: "spec_doc", reason: "the card has no spec" },
    ]);
  });

  /** Mutation: drop the canceled exemption — abandoning a card would say it is held. */
  it("says nothing for a move into canceled, or before the checklist is read", () => {
    expect(moveWarning(exit("specifying"), "canceled")).toBeNull();
    expect(moveWarning(null, "planning")).toBeNull();
  });
});
