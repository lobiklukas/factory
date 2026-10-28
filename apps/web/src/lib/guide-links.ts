/**
 * Where the dashboard points an operator who has nothing to look at: the step of the getting-started
 * guide (`docs/getting-started.md`) that gets them past the empty pane (G1).
 *
 * C9 made every empty state name a press in the UI, never a command to type. That still leaves a
 * new operator without the larger picture (what a board is for, what the specifier asks, where the
 * PR comes from), so each empty pane also links the one step of the guide it is about. The link is
 * to the document on the forge, so it opens from any browser on any machine; `guide-links.test.ts`
 * reads the guide itself and fails when an anchor named here is not one of its headings.
 */

/** The guide on the forge. */
export const GUIDE_URL =
  "https://github.com/lobiklukas/factory/blob/main/docs/getting-started.md";

export type GuideStepId =
  | "install"
  | "check"
  | "repo"
  | "board"
  | "card"
  | "run"
  | "plan"
  | "review";

export type GuideStep = {
  /** The heading's GitHub anchor in the guide: its text, lowercased, spaces to hyphens. */
  readonly anchor: string;
  /** What the link says. */
  readonly label: string;
};

export const GUIDE_STEPS: Readonly<Record<GuideStepId, GuideStep>> = {
  install: {
    anchor: "1-install-and-start",
    label: "Getting started, step 1: install and start",
  },
  check: {
    anchor: "2-check-the-machine",
    label: "Getting started, step 2: check the machine",
  },
  repo: {
    anchor: "3-register-a-repository",
    label: "Getting started, step 3: register a repository",
  },
  board: {
    anchor: "4-create-a-board",
    label: "Getting started, step 4: create a board",
  },
  card: {
    anchor: "5-add-a-card",
    label: "Getting started, step 5: add a card",
  },
  run: {
    anchor: "6-start-runs-specify-then-plan",
    label: "Getting started, step 6: start runs",
  },
  plan: {
    anchor: "7-approve-the-plan-build-open-the-pr",
    label: "Getting started, step 7: approve the plan and open the PR",
  },
  review: {
    anchor: "8-review-and-merge",
    label: "Getting started, step 8: review and merge",
  },
};

/** The URL of a step: the guide, at the step's heading. */
export const guideHref = (step: GuideStepId): string =>
  `${GUIDE_URL}#${GUIDE_STEPS[step].anchor}`;
