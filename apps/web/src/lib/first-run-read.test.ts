/**
 * What the checklist reads and where the reading stops (C9): a run on a card past any fixed probe
 * window still ticks the step, and nothing is read after the first run.
 */
import { Effect, Schema } from "effect";
import { BoardInstanceId, TaskId } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import { readFirstRunFacts, type FirstRunReads } from "./first-run-read";

const board = Schema.decodeSync(BoardInstanceId);
const task = Schema.decodeSync(TaskId);
const boardId = (n: number) => board(`brd_${String(n).padStart(26, "0")}`);
const taskId = (n: number) => task(`tsk_${String(n).padStart(26, "0")}`);

/** A control plane as the four reads see it: cards per board, and the cards that have a run. */
const fake = (world: {
  readonly repos?: number;
  readonly boards: ReadonlyArray<ReadonlyArray<number>>;
  readonly withRun?: ReadonlyArray<number>;
}) => {
  const calls = { listTasks: 0, listTaskRuns: 0 };
  const reads: FirstRunReads<never> = {
    listRepos: () =>
      Effect.succeed({ repos: Array.from({ length: world.repos ?? 0 }) }),
    listBoards: () =>
      Effect.succeed(world.boards.map((_, index) => ({ id: boardId(index) }))),
    listTasks: ({ boardId: id }) =>
      Effect.sync(() => {
        calls.listTasks += 1;
        const index = world.boards.findIndex((_, i) => boardId(i) === id);
        return (world.boards[index] ?? []).map((n) => ({ id: taskId(n) }));
      }),
    listTaskRuns: ({ taskId: id }) =>
      Effect.sync(() => {
        calls.listTaskRuns += 1;
        return (world.withRun ?? []).some((n) => taskId(n) === id) ? [{}] : [];
      }),
  };
  return { reads, calls };
};

const read = (world: Parameters<typeof fake>[0]) => {
  const { reads, calls } = fake(world);
  return { facts: Effect.runSync(readFirstRunFacts(reads)), calls };
};

describe("readFirstRunFacts", () => {
  it("reads no card with no board", () => {
    const { facts, calls } = read({ boards: [] });
    expect(facts).toEqual({
      repos: 0,
      boards: [],
      card: undefined,
      hasRun: false,
    });
    expect(calls).toEqual({ listTasks: 0, listTaskRuns: 0 });
  });

  it("finds a run on a card well past any fixed window of cards", () => {
    // Twelve intake cards on the newest board and a run on the last of them.
    const cards = Array.from({ length: 12 }, (_, i) => i + 1);
    const { facts } = read({ boards: [cards], withRun: [12] });
    expect(facts.hasRun).toBe(true);
  });

  it("finds a run on an older board behind a newer board full of cards", () => {
    const newer = Array.from({ length: 25 }, (_, i) => i + 1);
    const { facts } = read({ boards: [newer, [100]], withRun: [100] });
    expect(facts.hasRun).toBe(true);
    expect(facts.card).toEqual({ boardId: boardId(0), taskId: taskId(1) });
  });

  it("says no run when every card was asked and none has one", () => {
    const cards = Array.from({ length: 12 }, (_, i) => i + 1);
    const { facts, calls } = read({ boards: [cards, []] });
    expect(facts.hasRun).toBe(false);
    expect(calls.listTaskRuns).toBe(12);
  });

  it("stops at the first run: later boards and later cards are not read", () => {
    const { facts, calls } = read({
      boards: [[1, 2, 3, 4], [5], [6]],
      withRun: [1],
    });
    expect(facts.hasRun).toBe(true);
    // One batch of four runs was asked; the two later boards were never listed.
    expect(calls).toEqual({ listTasks: 1, listTaskRuns: 4 });
  });

  it("takes the first card from the first board that has one", () => {
    const { facts } = read({ repos: 2, boards: [[], [7, 8]] });
    expect(facts.repos).toBe(2);
    expect(facts.card).toEqual({ boardId: boardId(1), taskId: taskId(7) });
    expect(facts.hasRun).toBe(false);
  });
});
