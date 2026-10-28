/**
 * Which branch a card's later run continues (C19, `./cardBranch`): pure, over the runs the index
 * holds. The end-to-end proof — real worktrees, the PR step, the board's move — is
 * `SessionService.cardBranch.test.ts`.
 */
import type { BoardColumn } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import {
  type CardRun,
  cardBranchOf,
  changeColumnsOf,
} from "./cardBranch";

const REPO = "acme/widgets";

const run = (
  sessionId: string,
  column: string,
  overrides: Partial<CardRun> = {},
): CardRun => ({
  sessionId,
  column,
  repo: REPO,
  baseRef: "main",
  branch: null,
  released: false,
  ...overrides,
});

const CHANGE = new Set(["building"]);

describe("changeColumnsOf", () => {
  it("is the columns whose exit asks for a PR or a diff", () => {
    const column = (
      name: string,
      keys: ReadonlyArray<string>,
    ): BoardColumn => ({
      name,
      kind: "working",
      skills: [],
      requires: keys.map((key) => ({ key, description: key })),
    });
    const columns = changeColumnsOf([
      column("specifying", ["spec_doc"]),
      column("building", ["non_empty_diff", "pr_link"]),
      column("shipping", ["pr_link"]),
      column("review", ["verified"]),
    ]);
    expect([...columns]).toEqual(["building", "shipping"]);
  });
});

describe("cardBranchOf", () => {
  it("is none before the card's first change run: a specifier's branch is its own", () => {
    expect(
      cardBranchOf([run("ses_spec", "specifying")], CHANGE, REPO),
    ).toBeUndefined();
  });

  it("is the first change run's branch and base, for every later run", () => {
    const runs = [
      run("ses_spec", "specifying"),
      run("ses_a", "building", { baseRef: "release" }),
      run("ses_b", "building", { branch: "factory/ses_a" }),
      run("ses_c", "review", { branch: "factory/ses_a" }),
    ];
    expect(cardBranchOf(runs, CHANGE, REPO)).toEqual({
      sessionId: "ses_a",
      branch: "factory/ses_a",
      baseRef: "release",
      holders: ["ses_a", "ses_b", "ses_c"],
    });
  });

  it("names the unreleased runs on the branch as its holders, newest last", () => {
    const runs = [
      run("ses_a", "building", { released: true }),
      run("ses_b", "building", { branch: "factory/ses_a" }),
      run("ses_r", "review", { branch: "factory/review-1-abc" }),
      run("ses_c", "review", { branch: "factory/ses_a" }),
    ];
    expect(cardBranchOf(runs, CHANGE, REPO)?.holders).toEqual([
      "ses_b",
      "ses_c",
    ]);
  });

  it("stays the card's while a later run holds it, though the first run was released", () => {
    const runs = [
      run("ses_a", "building", { released: true }),
      run("ses_b", "review", { branch: "factory/ses_a" }),
    ];
    expect(cardBranchOf(runs, CHANGE, REPO)?.branch).toBe("factory/ses_a");
  });

  it("is none once every run on it was released, and the next change run's after that", () => {
    const released = [
      run("ses_a", "building", { released: true }),
      run("ses_b", "review", { branch: "factory/ses_a", released: true }),
    ];
    expect(cardBranchOf(released, CHANGE, REPO)).toBeUndefined();
    expect(
      cardBranchOf([...released, run("ses_c", "building")], CHANGE, REPO)
        ?.branch,
    ).toBe("factory/ses_c");
  });

  it("names a caller-named branch as it was named", () => {
    expect(
      cardBranchOf(
        [run("ses_a", "building", { branch: "feature/widget" })],
        CHANGE,
        REPO,
      )?.branch,
    ).toBe("feature/widget");
  });

  it("is only the repository's: a run in another one is not the card's change there", () => {
    expect(
      cardBranchOf(
        [run("ses_a", "building", { repo: "acme/other" })],
        CHANGE,
        REPO,
      ),
    ).toBeUndefined();
  });
});
