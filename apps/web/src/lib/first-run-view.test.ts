/**
 * The dashboard's front door and its getting-started checklist (C9). The browser drive proves the
 * pages; these are the cases it does not reach cheaply: several boards, a card on a later board, a
 * run with nothing before it.
 */
import { Schema } from "effect";
import { BoardInstanceId, TaskId } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import {
  firstRunComplete,
  firstRunSteps,
  nextStep,
  soleBoard,
  type FirstRunFacts,
} from "./first-run-view";

const board = Schema.decodeSync(BoardInstanceId);
const task = Schema.decodeSync(TaskId);

const A = board("brd_00000000000000000000000001");
const B = board("brd_00000000000000000000000002");
const T = task("tsk_00000000000000000000000001");

const EMPTY: FirstRunFacts = {
  repos: 0,
  boards: [],
  card: undefined,
  hasRun: false,
};

const done = (facts: FirstRunFacts) =>
  firstRunSteps(facts).map((step) => step.done);

describe("soleBoard", () => {
  it("is nothing with no board: /boards is where one is made", () => {
    expect(soleBoard([])).toBeUndefined();
  });

  it("is the board when exactly one exists", () => {
    expect(soleBoard([{ id: A }])).toBe(A);
  });

  it("is nothing with several: the choice is the operator's", () => {
    expect(soleBoard([{ id: A }, { id: B }])).toBeUndefined();
  });
});

describe("firstRunSteps", () => {
  it("lists repository, board, card, run in that order", () => {
    expect(firstRunSteps(EMPTY).map((step) => step.id)).toEqual([
      "repo",
      "board",
      "card",
      "run",
    ]);
  });

  it("ticks nothing on an empty control plane and points at the repository form", () => {
    expect(done(EMPTY)).toEqual([false, false, false, false]);
    expect(nextStep(EMPTY)?.id).toBe("repo");
    expect(firstRunComplete(EMPTY)).toBe(false);
  });

  it("ticks each step as the thing it makes appears, and only that step", () => {
    const repo = { ...EMPTY, repos: 1 };
    const withBoard = { ...repo, boards: [A] };
    const withCard = { ...withBoard, card: { boardId: A, taskId: T } };
    const withRun = { ...withCard, hasRun: true };
    expect(done(repo)).toEqual([true, false, false, false]);
    expect(done(withBoard)).toEqual([true, true, false, false]);
    expect(done(withCard)).toEqual([true, true, true, false]);
    expect(done(withRun)).toEqual([true, true, true, true]);
    expect(nextStep(withBoard)?.id).toBe("card");
    expect(firstRunComplete(withRun)).toBe(true);
    expect(nextStep(withRun)).toBeUndefined();
  });

  it("ticks the board step on a board made over a slug nobody registered", () => {
    // createBoard does not register the repository, so the first step honestly stays unticked.
    expect(done({ ...EMPTY, boards: [A] })).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it("opens the card form on the first board, and names the wait while there is none", () => {
    expect(firstRunSteps(EMPTY)[2]?.action).toEqual({
      kind: "blocked",
      until: "a board exists",
    });
    expect(firstRunSteps({ ...EMPTY, boards: [B, A] })[2]?.action).toEqual({
      kind: "new-card",
      boardId: B,
    });
  });

  it("opens the card a run starts from, on the board that card is on", () => {
    expect(firstRunSteps({ ...EMPTY, boards: [A] })[3]?.action).toEqual({
      kind: "blocked",
      until: "a card exists",
    });
    expect(
      firstRunSteps({
        ...EMPTY,
        boards: [A, B],
        card: { boardId: B, taskId: T },
      })[3]?.action,
    ).toEqual({ kind: "open-card", boardId: B, taskId: T });
  });

  it("sends the first two steps to forms that need nothing before them", () => {
    const steps = firstRunSteps(EMPTY);
    expect(steps[0]?.action).toEqual({ kind: "repos" });
    expect(steps[1]?.action).toEqual({ kind: "new-board" });
  });
});
