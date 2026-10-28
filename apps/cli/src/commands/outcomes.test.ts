import { describe, expect, it } from "vitest";
import type { OutcomeReport } from "@repo/domain/Outcomes";
import { RepoSlug } from "@repo/domain/Session";
import { OUTCOMES_HEADER, outcomeLines } from "./outcomes";

const window = {
  since: "2021-03-01T00:00:00.000Z",
  until: "2021-04-01T00:00:00.000Z",
};

const report: OutcomeReport = {
  window,
  repo: RepoSlug.make("acme/widgets"),
  values: [
    {
      metric: "lead_time",
      name: "card.median",
      value: 144000,
      unit: "seconds",
      window,
      denominator: {
        count: 3,
        of: "cards that first reached done in the window",
      },
      source: "task_events",
    },
    {
      metric: "defect_pressure",
      name: "rate",
      value: null,
      unit: "ratio",
      window,
      denominator: {
        count: 0,
        of: "PRs the factory opened that merged in the window",
      },
      source: "sessions.pr_merged_at",
    },
    {
      metric: "cost",
      name: "per_session",
      value: 3 / 17,
      unit: "usd",
      window,
      denominator: { count: 17, of: "sessions created in the window" },
      source: "session_activity.cost_total",
    },
  ],
};

describe("factory outcomes (LOB-44)", () => {
  it("prints the window once, then every value with its unit and denominator", () => {
    expect(outcomeLines(report)).toEqual([
      "window 2021-03-01T00:00:00.000Z 2021-04-01T00:00:00.000Z repo acme/widgets",
      OUTCOMES_HEADER,
      "lead_time  card.median  144000.0  seconds  3  cards that first reached done in the window",
      // A share of nothing is not 0: the empty denominator prints as `-`, with its count beside it.
      "defect_pressure  rate  -  ratio  0  PRs the factory opened that merged in the window",
      "cost  per_session  0.1765  usd  17  sessions created in the window",
    ]);
  });
});
