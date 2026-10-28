/**
 * Which run cap a start hits (B9, LOB-71): pure, no database. The counting itself — which runs are
 * in flight, under the card's pinned version, under the repository's lock — is proven against
 * Postgres by `SessionService.test.ts`'s "board caps and WIP limits"; these cases pin the order the
 * caps are checked in and what each refusal names.
 */
import { describe, expect, it } from "vitest";
import { runCapReached } from "./admission";
import { firstRunCapHit, type InFlightRun, type RunStart } from "./boardCaps";

const start: RunStart = {
  taskId: "tsk_new",
  boardId: "brd_one",
  repo: "acme/widgets",
  column: "building",
  definitionId: "default",
  definitionVersion: 5,
  caps: { board: 2, task: 1, repo: 2 },
  wipLimit: undefined,
};

const run = (
  sessionId: string,
  over: Partial<Omit<InFlightRun, "sessionId">> = {},
): InFlightRun => ({
  sessionId,
  taskId: "tsk_other",
  boardId: "brd_one",
  column: "building",
  ...over,
});

describe("firstRunCapHit", () => {
  it("lets a start through under every cap, and caps nothing a version does not declare", () => {
    expect(firstRunCapHit(start, [run("ses_a")])).toBeUndefined();
    expect(
      firstRunCapHit({ ...start, caps: undefined }, [
        run("ses_a", { taskId: "tsk_new" }),
        run("ses_b"),
        run("ses_c"),
      ]),
    ).toBeUndefined();
  });

  /** Mutation: count `>` instead of `>=` — the start that fills the task's one slot again passes. */
  it("names the task cap for a second run on one card, though the board has room", () => {
    const hit = firstRunCapHit(start, [run("ses_a", { taskId: "tsk_new" })]);
    expect(hit).toMatchObject({
      kind: "task",
      limit: 1,
      scope: "tsk_new",
      source: "definition default v5 caps.task",
      holders: ["ses_a"],
    });
  });

  /** Mutation: check the repo before the board — a full board on a full repo names the repo. */
  it("names the board cap for a third run on one board, though the repository is full too", () => {
    const hit = firstRunCapHit(start, [run("ses_a"), run("ses_b")]);
    expect(hit?.kind).toBe("board");
    expect(hit?.scope).toBe("brd_one");
    expect(hit?.holders).toEqual(["ses_a", "ses_b"]);
  });

  /** Mutation: count the repo cap over the start's board only — runs on another board are missed. */
  it("names the repo cap for a third run in one repository across two boards", () => {
    const hit = firstRunCapHit(start, [
      run("ses_a"),
      run("ses_b", { boardId: "brd_two" }),
    ]);
    expect(hit?.kind).toBe("repo");
    expect(hit?.scope).toBe("acme/widgets");
    expect(hit?.source).toBe("definition default v5 caps.repo");
  });

  /** Mutation: count the column's runs across boards — another board's `building` run fills it. */
  it("names the column for the WIP limit + 1th run in it on one board, and counts only that column", () => {
    const loose = { ...start, caps: undefined, wipLimit: 2 };
    const runs = [
      run("ses_a"),
      run("ses_b", { column: "review" }),
      run("ses_c", { boardId: "brd_two" }),
    ];
    expect(firstRunCapHit(loose, runs)).toBeUndefined();
    const hit = firstRunCapHit(loose, [...runs, run("ses_d")]);
    expect(hit).toMatchObject({
      kind: "column",
      limit: 2,
      scope: "building",
      source: "definition default v5 columns.building.wipLimit",
      holders: ["ses_a", "ses_d"],
    });
  });
});

describe("the run-cap refusal", () => {
  it("is at_capacity, typed with its cap, and names the limit, its source, the scope and the runs holding it", () => {
    const refused = runCapReached({
      kind: "column",
      limit: 1,
      source: "definition default v5 columns.building.wipLimit",
      scope: "building",
      board: "brd_one",
      holders: ["ses_a"],
    });
    expect(refused.code).toBe("at_capacity");
    expect(refused.cap).toEqual({
      kind: "column",
      limit: 1,
      source: "definition default v5 columns.building.wipLimit",
      scope: "building",
    });
    expect(refused.message).toContain(
      "at most 1 run may be in flight in column building of board brd_one",
    );
    expect(refused.message).toContain(
      "(definition default v5 columns.building.wipLimit=1)",
    );
    expect(refused.message).toContain("1 is: ses_a");
  });
});
