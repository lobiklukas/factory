import type { TaskPlan } from "@repo/domain/Task";

/**
 * The card pane's plan (D10): the three lists of what a planning run declared — what the person at
 * the plan approval gate reads — in the order the stage declares them, each with what an empty one
 * means. Only `risks` can be empty (the validator needs a step and a surface), and it is shown, not
 * hidden: "no risks" is a declaration, as "no gaps" is a spec's (`./spec-view`).
 */
export type PlanList = {
  /** The list's key, for the DOM's `data-plan-list`. */
  readonly key: "steps" | "surfaces" | "risks";
  readonly title: string;
  readonly items: ReadonlyArray<string>;
  /** Whether the list is numbered: the steps are an order, the others a set. */
  readonly ordered: boolean;
  /** What the pane says in place of an empty list. */
  readonly empty: string;
};

export const planLists = (plan: TaskPlan): ReadonlyArray<PlanList> => [
  {
    key: "steps",
    title: "Steps",
    items: plan.steps,
    ordered: true,
    empty: "No steps declared.",
  },
  {
    key: "surfaces",
    title: "Surfaces",
    items: plan.surfaces,
    ordered: false,
    empty: "No surfaces declared.",
  },
  {
    key: "risks",
    title: "Risks",
    items: plan.risks,
    ordered: false,
    empty: "None: the plan declares no risks.",
  },
];
