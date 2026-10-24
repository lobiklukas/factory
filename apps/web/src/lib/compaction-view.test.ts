/**
 * The compaction spend helper (LOB-222): what one action cost, from two readings of a session's
 * usage.
 *
 * Pure on purpose. The Compact button and the before/after pair beside the summary are LOB-223's,
 * and `.pi/skills/verify-web` proves them in a browser; the cases here are the ones a screenshot
 * cannot settle — the two buckets adding up, a costless (faux) session getting no dollar figure,
 * and a pair of readings whose totals went the wrong way.
 */
import type { ModelUsage, SessionUsage } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { formatSpendDelta, spendDelta, spendOf } from "./compaction-view";

/** The counters a reading carries. `costTotal` defaults to 0, which is faux's case. */
const usage = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  input: 1_000,
  output: 200,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1_200,
  costTotal: 0,
  ...over,
});

const reading = (over: Partial<SessionUsage> = {}): SessionUsage => ({
  models: [{ key: "faux/faux-1", usage: usage() }],
  tools: [],
  ...over,
});

describe("spendOf", () => {
  it("adds models and tools, not models alone", () => {
    const spent = spendOf(
      reading({
        tools: [{ key: "factory.verify", usage: usage({ totalTokens: 800 }) }],
      }),
    );
    expect(spent.tokens).toBe(2_000);
  });

  it("sums cost over both buckets", () => {
    const spent = spendOf(
      reading({
        models: [
          {
            key: "anthropic/claude-sonnet-5-5",
            usage: usage({ costTotal: 0.25 }),
          },
        ],
        tools: [{ key: "factory.verify", usage: usage({ costTotal: 0.005 }) }],
      }),
    );
    expect(spent.costTotal).toBeCloseTo(0.255, 10);
  });

  it("is zero for a session that has spent nothing", () => {
    expect(spendOf({ models: [], tools: [] })).toEqual({
      tokens: 0,
      costTotal: 0,
    });
  });
});

describe("spendDelta", () => {
  it("gives the delta of tokens and of cost when the readings carry cost", () => {
    const before = reading({
      models: [
        {
          key: "anthropic/claude-sonnet-5-5",
          usage: usage({ totalTokens: 1_200, costTotal: 0.004 }),
        },
      ],
    });
    const after = reading({
      models: [
        {
          key: "anthropic/claude-sonnet-5-5",
          usage: usage({ totalTokens: 4_320, costTotal: 0.0424 }),
        },
      ],
    });

    const delta = spendDelta(before, after);

    expect(delta.tokens).toBe(3_120);
    expect(delta.cost).toBeCloseTo(0.0384, 10);
  });

  it("carries no cost at all when both readings report none (the faux case)", () => {
    const before = reading();
    const after = reading({
      models: [{ key: "faux/faux-1", usage: usage({ totalTokens: 41_320 }) }],
    });

    const delta = spendDelta(before, after);

    // Tokens are real and measured; the dollars were never reported, so there is no number to give.
    expect(delta.tokens).toBe(40_120);
    expect(delta.cost).toBeUndefined();
    expect(formatSpendDelta(delta)).toBe("40,120 tokens");
    expect(formatSpendDelta(delta)).not.toContain("$");
  });

  it("reports cost once the later reading carries it", () => {
    // A reading with no cost at all, then one that has it: the delta is the whole later figure,
    // not `undefined`, because something was measured by the time the action ended.
    const delta = spendDelta(
      reading({ models: [{ key: "m", usage: usage({ costTotal: 0 }) }] }),
      reading({ models: [{ key: "m", usage: usage({ costTotal: 0.0015 }) }] }),
    );
    expect(delta.cost).toBeCloseTo(0.0015, 10);
  });

  it("never reports a negative delta", () => {
    const delta = spendDelta(
      reading({
        models: [
          { key: "m", usage: usage({ totalTokens: 5_000, costTotal: 0.5 }) },
        ],
      }),
      reading({
        models: [
          { key: "m", usage: usage({ totalTokens: 1_200, costTotal: 0.1 }) },
        ],
      }),
    );
    expect(delta.tokens).toBe(0);
    expect(delta.cost).toBe(0);
  });

  it("is a zero delta for the same reading twice", () => {
    const same = reading({
      models: [{ key: "m", usage: usage({ costTotal: 0.02 }) }],
    });
    expect(spendDelta(same, same)).toEqual({ tokens: 0, cost: 0 });
  });
});

describe("formatSpendDelta", () => {
  it("groups the token count and prints a sub-cent cost to four decimals", () => {
    expect(formatSpendDelta({ tokens: 812, cost: 0.0042 })).toBe(
      "812 tokens · $0.0042",
    );
    expect(formatSpendDelta({ tokens: 40_120, cost: 0.0099 })).toBe(
      "40,120 tokens · $0.0099",
    );
  });

  it("prints a cost of a cent or more to two decimals", () => {
    expect(formatSpendDelta({ tokens: 1_000, cost: 1.25 })).toBe(
      "1,000 tokens · $1.25",
    );
    expect(formatSpendDelta({ tokens: 40_120, cost: 0.0384 })).toBe(
      "40,120 tokens · $0.04",
    );
  });

  it("prints a measured zero cost as $0 rather than as an invented amount", () => {
    expect(formatSpendDelta({ tokens: 0, cost: 0 })).toBe("0 tokens · $0");
  });

  it("prints tokens alone when no cost was reported, even at zero tokens", () => {
    expect(formatSpendDelta({ tokens: 0, cost: undefined })).toBe("0 tokens");
  });
});
