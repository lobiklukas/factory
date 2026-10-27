import type { TaskSpec } from "@repo/domain/Task";

/**
 * The card pane's spec (LOB-238): the three lists of what a specifying run declared, in the order
 * the stage declares them, each with what an empty one means.
 *
 * An empty list is shown, not hidden: "no gaps" is the declaration the stage exists to make
 * explicit (LOB-72), and a section that vanished when it was empty would read as a spec that said
 * nothing about gaps at all.
 */
export type SpecList = {
  /** The list's key, for the DOM's `data-spec-list`. */
  readonly key: "acceptance" | "gaps" | "openQuestions";
  readonly title: string;
  readonly items: ReadonlyArray<string>;
  /** What the pane says in place of an empty list. */
  readonly empty: string;
};

export const specLists = (spec: TaskSpec): ReadonlyArray<SpecList> => [
  {
    key: "acceptance",
    title: "Acceptance",
    items: spec.acceptance,
    empty: "No acceptance criteria declared.",
  },
  {
    key: "gaps",
    title: "Gaps",
    items: spec.gaps,
    empty: "None: the spec declares no gaps.",
  },
  {
    key: "openQuestions",
    title: "Open questions",
    items: spec.openQuestions,
    empty: "None.",
  },
];
