/**
 * The card pane's spec lists (LOB-238): the three lists in the stage's order, an empty one kept with
 * what it means. The pane itself is driven in a browser by `.pi/skills/verify-board/spec-pane.mjs`.
 */
import { Schema } from "effect";
import { TaskSpec } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import { specLists } from "./spec-view";

const spec = Schema.decodeSync(TaskSpec)({
  taskId: `tsk_${"0".repeat(26)}`,
  sessionId: `ses_${"1".repeat(26)}`,
  column: "specifying",
  goal: "Pin the Postgres major",
  acceptance: ["compose names one major"],
  gaps: [],
  openQuestions: ["Which major?"],
  revision: 2,
  createdAt: "2026-10-27T00:00:00.000Z",
});

describe("specLists", () => {
  it("lists acceptance, gaps and open questions, in that order, with their items", () => {
    expect(
      specLists(spec).map((list) => [list.key, list.items.length]),
    ).toEqual([
      ["acceptance", 1],
      ["gaps", 0],
      ["openQuestions", 1],
    ]);
  });

  it("keeps an empty gaps list, saying the spec declares none", () => {
    const gaps = specLists(spec).find((list) => list.key === "gaps");
    expect(gaps?.items).toEqual([]);
    expect(gaps?.empty).toBe("None: the spec declares no gaps.");
  });
});
