/**
 * The compaction spend helper (LOB-222): what one action cost, from two readings of a session's
 * usage.
 *
 * Pure on purpose. The Compact button and the before/after pair beside the summary are LOB-223's,
 * and `.pi/skills/verify-web` proves them in a browser; the cases here are the ones a screenshot
 * cannot settle — the two buckets adding up, a costless (faux) session getting no dollar figure,
 * and a pair of readings whose totals went the wrong way.
 */
import type {
  ModelUsage,
  SessionUsage,
  TranscriptEntry,
} from "@repo/domain/Session";
import { SessionId } from "@repo/domain/Session";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CompactionWindow } from "./compaction-view";
import {
  compactionDelta,
  compactionRow,
  formatSpend,
  formatSpendDelta,
  spendDelta,
  spendHeading,
  spendOf,
} from "./compaction-view";

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

/**
 * The compaction's own spend and the header's running total (LOB-223).
 *
 * The pane passes a delta into the transcript row and prints a reading in its header, and neither
 * is a component test: what a screenshot cannot settle is which row gets the delta, and what the
 * header does when the provider reported no cost.
 */
const SESSION = Schema.decodeSync(SessionId)("ses_00000000000000000000000002");
const OTHER_SESSION = Schema.decodeSync(SessionId)(
  "ses_00000000000000000000000003",
);

const entry = (
  kind: TranscriptEntry["kind"],
  over: Partial<TranscriptEntry> = {},
): TranscriptEntry => ({
  id: `${kind}-1`,
  kind,
  text: "",
  toolCalls: [],
  ...over,
});

describe("formatSpend", () => {
  it("prints a running total's tokens and no dollar figure when nothing was measured", () => {
    // Faux's case: tokens are real, the cost was never reported, so there is no dollar to print.
    expect(formatSpend({ tokens: 46_120, costTotal: 0 })).toBe("46,120 tokens");
    expect(formatSpend({ tokens: 0, costTotal: 0 })).toBe("0 tokens");
  });

  it("prints the cost beside the tokens once a reading carries one", () => {
    expect(formatSpend({ tokens: 46_120, costTotal: 0.0042 })).toBe(
      "46,120 tokens · $0.0042",
    );
  });
});

describe("compactionRow", () => {
  const window = (over: Partial<CompactionWindow> = {}): CompactionWindow => ({
    sessionId: SESSION,
    before: reading(),
    entriesBefore: 0,
    after: null,
    ...over,
  });
  const transcript = [
    entry("user"),
    entry("compaction"),
    entry("assistant"),
    entry("compaction"),
  ];

  it("names the first summary the press could have written", () => {
    // The turn above the summary was sent before the press, so the scan starts after it.
    expect(
      compactionRow(window({ entriesBefore: 1 }), SESSION, transcript),
    ).toBe(1);
    expect(
      compactionRow(window({ entriesBefore: 2 }), SESSION, transcript),
    ).toBe(3);
  });

  it("ignores a compaction that was already on screen", () => {
    // The press happened after the only summary in this transcript, so it has written none yet.
    expect(
      compactionRow(
        window({ entriesBefore: 2 }),
        SESSION,
        transcript.slice(0, 2),
      ),
    ).toBe(undefined);
  });

  it("gives a later compaction to its own press, not to this one", () => {
    // A second summary after the press is a second compaction, not a second answer for this one.
    expect(
      compactionRow(window({ entriesBefore: 2 }), SESSION, transcript),
    ).toBe(3);
  });

  it("closes the window when the operator sends a turn after pressing", () => {
    // A press that wrote no summary (no cut) must not charge the next compaction — the harness's
    // own threshold policy, say — with a spend that also includes the turn sent in between.
    const afterATurn = [entry("user"), entry("assistant"), entry("compaction")];
    expect(compactionRow(window(), SESSION, afterATurn)).toBe(undefined);
  });

  it("has nothing before the operator presses the button", () => {
    expect(compactionRow(null, SESSION, transcript)).toBe(undefined);
  });

  it("does not carry one session's window into another", () => {
    // The pane is one component across routes, so a reading taken in session A must never be
    // subtracted from session B's usage.
    expect(
      compactionRow(window({ sessionId: SESSION }), OTHER_SESSION, transcript),
    ).toBe(undefined);
  });
});

describe("compactionDelta", () => {
  const window = (over: Partial<CompactionWindow> = {}): CompactionWindow => ({
    sessionId: SESSION,
    before: reading({
      models: [{ key: "m", usage: usage({ totalTokens: 1_200 }) }],
    }),
    entriesBefore: 0,
    after: null,
    ...over,
  });
  const after = reading({
    models: [{ key: "m", usage: usage({ totalTokens: 5_200 }) }],
  });

  it("reads live until the summarizer's spend has landed", () => {
    expect(compactionDelta(window(), after)).toEqual({
      tokens: 4_000,
      cost: undefined,
    });
  });

  it("stays put once the end reading is captured", () => {
    // A later turn must not grow the number: what this compaction cost is not what the session has
    // spent since.
    const captured = window({ after });
    const later = reading({
      models: [{ key: "m", usage: usage({ totalTokens: 90_200 }) }],
    });
    expect(compactionDelta(captured, later)).toEqual(
      compactionDelta(captured, after),
    );
    expect(compactionDelta(captured, later).tokens).toBe(4_000);
  });
});

describe("spendHeading", () => {
  it("says the spend is still being measured while nothing has been reported", () => {
    expect(spendHeading({ tokens: 0, cost: undefined })).toBe(
      "Measuring spend…",
    );
  });

  it("prints the measured delta once the usage event lands", () => {
    expect(spendHeading({ tokens: 4_000, cost: undefined })).toBe(
      "4,000 tokens",
    );
  });
});
