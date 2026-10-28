/**
 * `factory replay`'s table, its model check and its wait for the comparison (LOB-200).
 *
 * The command itself is proven by `.pi/skills/verify-cli/replay.sh`, which replays a session in a
 * real terminal against a real control plane. These cases are the ones a pane capture would not
 * localize: which side is which column, the sign of the delta, what a typed refusal names, and that
 * a comparison that is slow to land is waited for while one that never lands is reported.
 */
import { SessionId } from "@repo/domain/Session";
import type { ReplayComparison } from "@repo/domain/Session";
import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  awaitComparison,
  comparisonAgainst,
  formatComparison,
  requireServedModel,
} from "./replay";

const SOURCE = Schema.decodeSync(SessionId)("ses_01m5yvfya2tsyn56ycr5jj3pvs");
const REPLAY = Schema.decodeSync(SessionId)("ses_01m5yvfya2tsyn56ycr5jj3pvt");

const comparison = (
  overrides: Partial<ReplayComparison> = {},
): ReplayComparison => ({
  role: "replay",
  at: "2026-10-28T00:00:00.000Z",
  self: {
    session: REPLAY,
    model: "faux/faux-alt",
    outcome: "answered",
    turns: 2,
    cost: 0.02,
  },
  counterpart: {
    session: SOURCE,
    model: "faux/faux-1",
    outcome: "unanswered",
    reason: "aborted",
    turns: 5,
    cost: 0.05,
  },
  delta: { turns: -3, cost: -0.03 },
  ...overrides,
});

describe("formatComparison", () => {
  it("puts the source in the first column, the replay in the second, and the delta last", () => {
    const lines = formatComparison(comparison());
    const cells = (line: string) => line.split(/\s{2,}/);

    expect(cells(lines[0] ?? "")).toEqual(["", "source", "replay", "delta"]);
    expect(cells(lines[1] ?? "")).toEqual(["session", SOURCE, REPLAY]);
    expect(cells(lines[2] ?? "")).toEqual([
      "model",
      "faux/faux-1",
      "faux/faux-alt",
    ]);
    expect(cells(lines[3] ?? "")).toEqual([
      "result",
      "unanswered (aborted)",
      "answered",
    ]);
    expect(cells(lines[4] ?? "")).toEqual(["turns", "5", "2", "-3"]);
    expect(cells(lines[5] ?? "")).toEqual([
      "cost",
      "$0.0500",
      "$0.0200",
      "-$0.0300",
    ]);
  });

  it("prints the stored delta with its sign, positive as well as negative", () => {
    const lines = formatComparison(
      comparison({ delta: { turns: 2, cost: 0.0125 } }),
    );
    expect(lines[4]).toMatch(/\+2$/);
    expect(lines[5]).toMatch(/\+\$0\.0125$/);
  });

  it("prints a zero delta unsigned, so equal runs do not look like a change", () => {
    const lines = formatComparison(
      comparison({ delta: { turns: 0, cost: 0 } }),
    );
    expect(lines[4]).toMatch(/ 0$/);
    expect(lines[5]).toMatch(/ \$0\.0000$/);
  });

  it("prints a cost delta too small to show unsigned, whichever way it points", () => {
    for (const cost of [0.00003, -0.00003]) {
      const lines = formatComparison(comparison({ delta: { turns: 0, cost } }));
      expect(lines[5]).toMatch(/ \$0\.0000$/);
    }
  });

  it("says when the source recorded no model, instead of printing a blank column", () => {
    const base = comparison();
    const lines = formatComparison({
      ...base,
      counterpart: { ...base.counterpart, model: "" },
    });
    expect(lines[2]).toContain("(none recorded)");
  });

  it("shows a fork source's inherited turns beside its own, never inside them", () => {
    const base = comparison();
    const lines = formatComparison({
      ...base,
      counterpart: {
        ...base.counterpart,
        turns: 1,
        inherited: { from: "ses_parent", turns: 4 },
      },
    });
    expect(lines[4]).toContain("1 (+4 inherited)");
  });

  it("starts the replay column at the same offset on every row", () => {
    const lines = formatComparison(comparison());
    const replayAt = (lines[0] ?? "").indexOf("replay");
    expect(lines[1]?.indexOf(REPLAY)).toBe(replayAt);
    expect(lines[2]?.indexOf("faux/faux-alt")).toBe(replayAt);
    expect(lines[3]?.indexOf("answered", replayAt - 1)).toBe(replayAt);
    expect(lines[4]?.slice(replayAt, replayAt + 1)).toBe("2");
    expect(lines[5]?.slice(replayAt, replayAt + 7)).toBe("$0.0200");
  });
});

describe("requireServedModel", () => {
  it("accepts a model the control plane serves", async () => {
    await expect(
      Effect.runPromise(requireServedModel("faux/a", ["faux/a", "faux/b"])),
    ).resolves.toBe("faux/a");
  });

  it("refuses an unknown model as a typed error naming every allowed model", async () => {
    const result = await Effect.runPromise(
      Effect.result(requireServedModel("nope/x", ["faux/a", "faux/b"])),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("unreachable");
    expect(result.failure._tag).toBe("UnknownReplayModel");
    expect(result.failure.model).toBe("nope/x");
    expect(result.failure.allowed).toEqual(["faux/a", "faux/b"]);
    expect(result.failure.message).toContain("nope/x");
    expect(result.failure.message).toContain("faux/a, faux/b");
  });

  it("does not take a model id without its provider for the model it ends with", async () => {
    const result = await Effect.runPromise(
      Effect.result(requireServedModel("a", ["faux/a"])),
    );
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("comparisonAgainst", () => {
  it("is the replay's own comparison naming the source it replayed", () => {
    const mine = comparison();
    const other = comparison({
      counterpart: { ...mine.counterpart, session: REPLAY },
    });
    expect(comparisonAgainst([other, mine], SOURCE)).toBe(mine);
  });

  it("is not the source's side of the pairing, which names the replay as its counterpart", () => {
    const mine = comparison();
    const sourceSide = comparison({
      role: "source",
      self: mine.counterpart,
      counterpart: mine.self,
    });
    expect(comparisonAgainst([sourceSide], SOURCE)).toBeUndefined();
    expect(comparisonAgainst([sourceSide], REPLAY)).toBeUndefined();
  });

  it("is undefined for a session that holds none", () => {
    expect(comparisonAgainst(undefined, SOURCE)).toBeUndefined();
    expect(comparisonAgainst([], SOURCE)).toBeUndefined();
  });
});

describe("awaitComparison", () => {
  const poll = { poll: "1 millis" } as const;

  it("polls until the comparison lands, then answers it", async () => {
    let reads = 0;
    const read = Effect.sync(() => {
      reads += 1;
      return reads >= 4 ? comparison() : undefined;
    });
    const found = await Effect.runPromise(
      awaitComparison(read, REPLAY, { ...poll, wait: "5 seconds" }),
    );
    expect(found).toEqual(comparison());
    expect(reads).toBe(4);
  });

  it("answers at once when the comparison is already there", async () => {
    let reads = 0;
    const read = Effect.sync(() => {
      reads += 1;
      return comparison();
    });
    await Effect.runPromise(awaitComparison(read, REPLAY, poll));
    expect(reads).toBe(1);
  });

  it("is a typed pending error naming the replay when none lands in time", async () => {
    let reads = 0;
    const never = Effect.sync((): ReplayComparison | undefined => {
      reads += 1;
      return undefined;
    });
    const result = await Effect.runPromise(
      Effect.result(
        awaitComparison(never, REPLAY, {
          ...poll,
          wait: "30 millis",
        }),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("unreachable");
    expect(result.failure).toMatchObject({
      _tag: "ReplayComparisonPending",
      replay: REPLAY,
    });
    expect(result.failure.message).toContain(`factory watch ${REPLAY}`);
    expect(reads).toBeGreaterThan(1);
  });

  it("does not hide a failed read as a pending comparison", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        awaitComparison(Effect.fail("rpc down" as const), REPLAY, poll),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("unreachable");
    expect(result.failure).toBe("rpc down");
  });
});
