/**
 * `factory fork` / `reset` / `compact`'s wording and the compaction wait (C15).
 *
 * The commands run against a real control plane in `.pi/skills/verify-cli/session.sh`. These cases
 * pin what a pane capture would not localize: which reset entry is "the new marker", that a
 * compaction which wrote nothing is told apart from one still running (and from one whose summary
 * trails the task), and that a wait which never ends is reported rather than answered.
 */
import type { SessionTask, TranscriptEntry } from "@repo/domain/Session";
import { SessionId } from "@repo/domain/Session";
import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  anchorOf,
  awaitCompaction,
  compactionVerdict,
  firstEntryAfter,
  forkLine,
  resetLines,
} from "./sessionControl";

const PARENT = Schema.decodeSync(SessionId)("ses_01m5yvfya2tsyn56ycr5jj3pvs");
const CHILD = Schema.decodeSync(SessionId)("ses_01m5yvfya2tsyn56ycr5jj3pvt");

const entry = (
  id: string,
  kind: TranscriptEntry["kind"],
  text = "",
): TranscriptEntry => ({ id, kind, text, toolCalls: [] });

const task = (id: string): SessionTask => ({
  id,
  kind: "compaction",
  status: "running",
  waitingOn: [],
  conversations: [],
});

describe("forkLine", () => {
  it("names the child first and the parent after it", () => {
    expect(forkLine(CHILD, PARENT, undefined)).toBe(
      `fork ${CHILD} of ${PARENT}`,
    );
  });

  it("says where the fork was taken when --at was given", () => {
    expect(forkLine(CHILD, PARENT, "7")).toBe(
      `fork ${CHILD} of ${PARENT} at entry 7`,
    );
  });
});

const idle = { busy: false } as const;
const busy = { busy: true } as const;

describe("the reset marker", () => {
  const entries = [
    entry("1", "user", "hello"),
    entry("2", "reset", "first handoff"),
    entry("3", "assistant", "hi"),
    entry("4", "reset", "second handoff"),
  ];

  it("is the reset entry written after the transcript's end, not an older one", () => {
    const anchor = anchorOf(entries.slice(0, 3));
    expect(firstEntryAfter(entries, "reset", anchor)?.id).toBe("4");
  });

  it("is the first reset after the anchor, not a later one", () => {
    const more = [...entries, entry("5", "assistant"), entry("6", "reset")];
    expect(
      firstEntryAfter(more, "reset", anchorOf(entries.slice(0, 3)))?.id,
    ).toBe("4");
  });

  it("is absent when nothing new was written", () => {
    expect(
      firstEntryAfter(entries, "reset", anchorOf(entries)),
    ).toBeUndefined();
  });

  it("is only ever of the kind asked for", () => {
    expect(
      firstEntryAfter(entries, "compaction", anchorOf([])),
    ).toBeUndefined();
  });

  it("is not an older entry that a truncated first read did not carry", () => {
    // The first read held only the newest window (entries 3 and 4); the live read holds everything,
    // including the reset at 2 that was always there.
    const window = entries.slice(2);
    expect(firstEntryAfter(entries, "reset", anchorOf(window))).toBeUndefined();
  });

  it("prints its id and the handoff as the transcript shows it", () => {
    expect(resetLines(PARENT, entry("4", "reset", "second handoff"))).toEqual([
      `reset ${PARENT} marker 4`,
      "[reset] second handoff",
    ]);
  });

  it("prints only the id for a reset that opens with nothing", () => {
    expect(resetLines(PARENT, entry("5", "reset", ""))).toEqual([
      `reset ${PARENT} marker 5`,
    ]);
  });

  it("says the marker is still to come when the reset was admitted into a running session", () => {
    const [line] = resetLines(PARENT, undefined);
    expect(line).toContain("admitted");
    expect(line).toContain("next boundary");
  });
});

describe("compactionVerdict", () => {
  const none = anchorOf([]);

  it("is the summary the task wrote, even while it is still listed", () => {
    const summary = entry("9", "compaction", "the summary");
    expect(
      compactionVerdict(
        {
          entries: [entry("1", "user"), summary],
          tasks: [task("t1")],
          live: idle,
        },
        none,
        "t1",
      ),
    ).toEqual({ state: "compacted", summary });
  });

  it("is not the summary of an earlier compaction", () => {
    expect(
      compactionVerdict(
        { entries: [entry("2", "compaction", "old")], tasks: [], live: idle },
        anchorOf([entry("2", "compaction", "old")]),
        "t1",
      ),
    ).toEqual({ state: "nothing" });
  });

  it("is running while the task is live and wrote nothing yet", () => {
    expect(
      compactionVerdict(
        { entries: [entry("1", "user")], tasks: [task("t1")], live: idle },
        none,
        "t1",
      ),
    ).toEqual({ state: "running" });
  });

  it("is not the summary of an older compaction that a truncated first read did not carry", () => {
    // The first read was the newest window (2, 3); the live read has the compaction at 0 as well.
    const live = [
      entry("0", "compaction", "old"),
      entry("1", "user"),
      entry("2", "assistant"),
      entry("3", "user"),
    ];
    expect(
      compactionVerdict(
        { entries: live, tasks: [task("t1")], live: idle },
        anchorOf(live.slice(2)),
        "t1",
      ),
    ).toEqual({ state: "running" });
  });

  it("is the first summary after the anchor, not a later automatic one", () => {
    const first = entry("5", "compaction", "this press");
    expect(
      compactionVerdict(
        {
          entries: [
            entry("1", "user"),
            first,
            entry("6", "compaction", "later"),
          ],
          tasks: [],
          live: idle,
        },
        anchorOf([entry("1", "user")]),
        "t1",
      ),
    ).toEqual({ state: "compacted", summary: first });
  });

  it("is still running when the task left the list but the session is busy", () => {
    expect(
      compactionVerdict(
        { entries: [entry("1", "user")], tasks: [], live: busy },
        none,
        "t1",
      ),
    ).toEqual({ state: "running" });
  });

  it("is nothing when the task has left the list and wrote no summary", () => {
    expect(
      compactionVerdict(
        { entries: [entry("1", "user")], tasks: [task("t2")], live: idle },
        none,
        "t1",
      ),
    ).toEqual({ state: "nothing" });
  });
});

describe("awaitCompaction", () => {
  const poll = { poll: "1 millis" } as const;
  const input = { sessionId: PARENT, taskId: "t1", anchor: anchorOf([]) };
  type Reading = {
    readonly entries: readonly TranscriptEntry[];
    readonly tasks: readonly SessionTask[];
    readonly live?: { readonly busy: boolean };
  };
  const sequence = (readings: readonly Reading[]) => {
    const state = { reads: 0 };
    const read = Effect.sync(() => {
      const reading =
        readings[Math.min(state.reads, readings.length - 1)] ??
        ({ entries: [], tasks: [] } satisfies Reading);
      state.reads += 1;
      return { ...reading, live: reading.live ?? idle };
    });
    return { read, state };
  };
  const summary = entry("9", "compaction", "the summary");

  it("waits for a running task and answers its summary", async () => {
    const { read, state } = sequence([
      { entries: [], tasks: [task("t1")] },
      { entries: [], tasks: [task("t1")] },
      { entries: [summary], tasks: [] },
    ]);
    const found = await Effect.runPromise(
      awaitCompaction(read, input, { ...poll, wait: "5 seconds" }),
    );
    expect(found).toEqual(summary);
    expect(state.reads).toBe(3);
  });

  it("answers undefined once a task that wrote nothing has stayed gone for two reads", async () => {
    const { read, state } = sequence([{ entries: [], tasks: [] }]);
    const found = await Effect.runPromise(
      awaitCompaction(read, input, { ...poll, wait: "5 seconds" }),
    );
    expect(found).toBeUndefined();
    expect(state.reads).toBe(2);
  });

  it("does not call it nothing when the summary lands just after the task left the list", async () => {
    const { read } = sequence([
      { entries: [], tasks: [] },
      { entries: [summary], tasks: [] },
    ]);
    const found = await Effect.runPromise(
      awaitCompaction(read, input, { ...poll, wait: "5 seconds" }),
    );
    expect(found).toEqual(summary);
  });

  it("does not answer nothing while the session is busy, and answers the summary that lands at the boundary", async () => {
    const { read, state } = sequence([
      { entries: [], tasks: [], live: busy },
      { entries: [], tasks: [], live: busy },
      { entries: [], tasks: [], live: busy },
      { entries: [], tasks: [], live: busy },
      { entries: [summary], tasks: [] },
    ]);
    const found = await Effect.runPromise(
      awaitCompaction(read, input, { ...poll, wait: "5 seconds" }),
    );
    expect(found).toEqual(summary);
    expect(state.reads).toBe(5);
  });

  it("needs the two nothing reads to be consecutive, a busy read in between starts over", async () => {
    const { read, state } = sequence([
      { entries: [], tasks: [] },
      { entries: [], tasks: [], live: busy },
      { entries: [], tasks: [] },
      { entries: [], tasks: [] },
    ]);
    const found = await Effect.runPromise(
      awaitCompaction(read, input, { ...poll, wait: "5 seconds" }),
    );
    expect(found).toBeUndefined();
    expect(state.reads).toBe(4);
  });

  it("is a typed pending error naming the session and the task when the task never settles", async () => {
    const { read } = sequence([{ entries: [], tasks: [task("t1")] }]);
    const result = await Effect.runPromise(
      Effect.result(
        awaitCompaction(read, input, { ...poll, wait: "30 millis" }),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "CompactionPending",
        session: PARENT,
        task: "t1",
      });
      expect(String(result.failure.message)).toContain(
        `factory watch ${PARENT}`,
      );
    }
  });
});
