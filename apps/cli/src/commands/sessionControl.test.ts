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
  awaitCompaction,
  compactionVerdict,
  entryIds,
  forkLine,
  newestEntryOf,
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

describe("the reset marker", () => {
  const entries = [
    entry("1", "user", "hello"),
    entry("2", "reset", "first handoff"),
    entry("3", "assistant", "hi"),
    entry("4", "reset", "second handoff"),
  ];

  it("is the reset entry the session did not have before, not an older one", () => {
    const before = entryIds(entries.slice(0, 3), "reset");
    expect(newestEntryOf(entries, "reset", before)?.id).toBe("4");
  });

  it("is absent when nothing new was written", () => {
    expect(
      newestEntryOf(entries, "reset", entryIds(entries, "reset")),
    ).toBeUndefined();
  });

  it("is only ever of the kind asked for", () => {
    expect(
      newestEntryOf(entries, "compaction", new Set<string>()),
    ).toBeUndefined();
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
  const none = new Set<string>();

  it("is the summary the task wrote, even while it is still listed", () => {
    const summary = entry("9", "compaction", "the summary");
    expect(
      compactionVerdict(
        { entries: [entry("1", "user"), summary], tasks: [task("t1")] },
        none,
        "t1",
      ),
    ).toEqual({ state: "compacted", summary });
  });

  it("is not the summary of an earlier compaction", () => {
    expect(
      compactionVerdict(
        { entries: [entry("2", "compaction", "old")], tasks: [] },
        new Set(["2"]),
        "t1",
      ),
    ).toEqual({ state: "nothing" });
  });

  it("is running while the task is live and wrote nothing yet", () => {
    expect(
      compactionVerdict(
        { entries: [entry("1", "user")], tasks: [task("t1")] },
        none,
        "t1",
      ),
    ).toEqual({ state: "running" });
  });

  it("is nothing when the task has left the list and wrote no summary", () => {
    expect(
      compactionVerdict(
        { entries: [entry("1", "user")], tasks: [task("t2")] },
        none,
        "t1",
      ),
    ).toEqual({ state: "nothing" });
  });
});

describe("awaitCompaction", () => {
  const poll = { poll: "1 millis" } as const;
  const input = { sessionId: PARENT, taskId: "t1", before: new Set<string>() };
  type Reading = {
    readonly entries: readonly TranscriptEntry[];
    readonly tasks: readonly SessionTask[];
  };
  const sequence = (readings: readonly Reading[]) => {
    const state = { reads: 0 };
    const read = Effect.sync(() => {
      const reading =
        readings[Math.min(state.reads, readings.length - 1)] ??
        ({ entries: [], tasks: [] } satisfies Reading);
      state.reads += 1;
      return reading;
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
