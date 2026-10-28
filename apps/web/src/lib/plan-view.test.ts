/**
 * The card pane's plan lists (D10): steps, surfaces and risks in the stage's order, the steps
 * numbered, an empty risks list kept with what it means. The pane itself is driven in a browser by
 * `.pi/skills/verify-board/plan-pane.mjs`.
 */
import { Schema } from "effect";
import { TaskPlan } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import { planLists } from "./plan-view";

const plan = Schema.decodeSync(TaskPlan)({
  taskId: `tsk_${"0".repeat(26)}`,
  sessionId: `ses_${"1".repeat(26)}`,
  column: "planning",
  summary: "Export the card count",
  steps: ["add apps/web/src/card.ts", "verify web"],
  surfaces: ["web"],
  risks: [],
  revision: 5,
  createdAt: "2026-10-28T00:00:00.000Z",
});

describe("planLists", () => {
  /** Mutation: list the risks first, or number the surfaces — the order the person reads changes. */
  it("lists steps, surfaces and risks, in that order, only the steps numbered", () => {
    expect(
      planLists(plan).map((list) => [
        list.key,
        list.items.length,
        list.ordered,
      ]),
    ).toEqual([
      ["steps", 2, true],
      ["surfaces", 1, false],
      ["risks", 0, false],
    ]);
  });

  it("keeps an empty risks list, saying the plan declares none", () => {
    const risks = planLists(plan).find((list) => list.key === "risks");
    expect(risks?.items).toEqual([]);
    expect(risks?.empty).toBe("None: the plan declares no risks.");
  });
});
