/**
 * `pi.usage` → `SessionUsage` (LOB-153).
 *
 * The ledger Pi Durable keeps has two buckets — `models`, keyed `provider/modelId`, and `tools`,
 * keyed by tool name — and the projection has to read both, because a session's spend is the two
 * added and the list surface shows that sum. `session.test.ts` proves the writer end of it (a real
 * tool result carrying usage lands in the log); this file pins the reader, which is the half a
 * rebuild of the index depends on and the half that used to drop `tools` on the floor.
 *
 * Offline and database-free on purpose: these are pure functions over a JSON document.
 */
import {
  type ConversationView,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  diffView,
  projectInbox,
  projectUsageDoc,
  usageCostTotal,
} from "./projection";

/** One `pi.usage` entry: Pi Durable stores pi-ai's `Usage`, cost and all. */
type UsageEntry = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

const entry = (input: number, output: number, total: number): UsageEntry => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

describe("projectUsageDoc", () => {
  it("reads both buckets, with each key and its counters", () => {
    const usage = projectUsageDoc({
      models: { "faux/faux-1": entry(10, 5, 0.5) },
      tools: { bash: entry(2, 1, 0.25), read: entry(4, 2, 0.125) },
    });

    expect(usage.models).toEqual([
      {
        key: "faux/faux-1",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          costTotal: 0.5,
        },
      },
    ]);
    // Sorted by tool name, not by the document's key order: two projections of one bucket compare
    // equal, and a client's list does not reshuffle between reads.
    expect(usage.tools.map((bucket) => bucket.key)).toEqual(["bash", "read"]);
    expect(usage.tools[0]?.usage.costTotal).toBe(0.25);
    expect(usage.tools[1]?.usage.totalTokens).toBe(6);
  });

  it("reads a document that has no tools bucket as no tool spend", () => {
    // A conversation from before the tools bucket existed, or one whose tools report nothing. The
    // distinction between "absent" and "empty" is not one a caller can act on.
    const usage = projectUsageDoc({
      models: { "faux/faux-1": entry(1, 1, 0) },
    });
    expect(usage.tools).toEqual([]);
    expect(projectUsageDoc(undefined)).toEqual({ models: [], tools: [] });
  });

  it("keeps a tool whose usage has no counters rather than dropping it", () => {
    // Providers may leave optional counters out. A bucket that exists is attributed, with zeros for
    // what it did not report — dropping it would make the spend look like it came from nowhere.
    const usage = projectUsageDoc({ tools: { search: {} } });
    expect(usage.tools).toEqual([
      {
        key: "search",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          costTotal: 0,
        },
      },
    ]);
  });
});

describe("usageCostTotal", () => {
  it("adds both buckets, so a tool's spend reaches the list", () => {
    // 0.5 of model spend and 0.375 of tool spend. Model-only would answer 0.5, which is the number
    // the list would then show both live and (wrongly, consistently) after a rebuild.
    const usage = projectUsageDoc({
      models: { "faux/faux-1": entry(10, 5, 0.5) },
      tools: { bash: entry(2, 1, 0.25), read: entry(4, 2, 0.125) },
    });
    expect(usageCostTotal(usage)).toBeCloseTo(0.875);
  });

  it("is zero for a ledger with nothing in it", () => {
    expect(usageCostTotal({ models: [], tools: [] })).toBe(0);
  });
});

describe("projectInbox", () => {
  it("names a queued message by the submission id Pi Durable stores as a number", () => {
    // The shape `pi.inbox` commits: the id is the submission's branded number (LOB-166).
    const queued = projectInbox({
      "pi.inbox": {
        items: [
          { id: 7, mode: "steer", content: "steer me" },
          { id: 9, mode: "followUp", content: "follow me" },
        ],
      },
    });
    expect(queued).toEqual([
      { id: "7", mode: "steer", content: "steer me" },
      { id: "9", mode: "followUp", content: "follow me" },
    ]);
  });

  it("drops an item with no usable id rather than inventing one", () => {
    expect(
      projectInbox({
        "pi.inbox": { items: [{ mode: "steer", content: "nameless" }] },
      }),
    ).toEqual([]);
  });
});

describe("diffView", () => {
  const view = (docs: ConversationView["docs"]): ConversationView => ({
    conversation: { id: ROOT_CONVERSATION_ID },
    entries: [],
    docs,
  });

  it("reports a queue that drains beside the settle before the settle itself", () => {
    // `factory run` stops at the first event saying the run settled, so a drain committed in the
    // same revision must come first or `[queued] (empty)` is never printed (LOB-166).
    const busy = view({
      "pi.live": { run: { id: 1 }, tools: [] },
      "pi.inbox": { items: [{ id: 4, mode: "followUp", content: "late" }] },
    });
    const idle = view({ "pi.live": { tools: [] }, "pi.inbox": { items: [] } });
    expect(diffView(busy, idle).map((event) => event._tag)).toEqual([
      "queued",
      "live",
      "status",
    ]);
  });
});
