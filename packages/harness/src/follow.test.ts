/**
 * A followed stream's order (LOB-18, LOB-166): nothing that says the run settled goes out before the
 * entries committed with or before it, whatever the owner commits between the follower's reads.
 *
 * No database and no harness: the log is a fake `Storage` holding a root transcript and a `pi.live`
 * document, which the test changes at the one moment that matters — after the follower has scanned
 * for new entries and before anything else it reads — as an owner elsewhere committing its final
 * answer and its idle in one commit would.
 */
import type { EntryId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { SessionId as SessionIdSchema } from "@repo/domain/Session";
import type { SessionEvent } from "@repo/domain/Session";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { followSessionEvents } from "./follow";
import { LIVE_DOC } from "./projection";
import type { SessionRef } from "./session";

const ref: SessionRef = {
  id: SessionIdSchema.make(`ses_${"0".repeat(26)}`),
  title: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  model: "faux/faux",
  workspace: { path: "/nowhere", commands: {}, commandsSource: "none" },
};

const entry = (
  id: number,
  role: "user" | "assistant",
  text: string,
): EntryRecord => ({
  id: id as EntryId,
  conversationId: ROOT_CONVERSATION_ID,
  kind: role === "user" ? "pi.user" : "pi.assistant",
  model: [
    role === "user"
      ? { role: "user", content: text, timestamp: 0 }
      : {
          role: "assistant",
          content: [{ type: "text", text }],
          api: "faux",
          provider: "faux",
          model: "faux",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        },
  ],
});

/**
 * A log another process owns, read the way a reader-mode storage reads it: every call sees what
 * is committed at that moment. `afterNewEntriesScan` runs once, right after the first scan for
 * entries newer than the snapshot's — the gap a commit can land in.
 */
const fakeLog = (afterNewEntriesScan: (log: FakeLog) => void) => {
  const log: FakeLog = {
    entries: [entry(1, "user", "go")],
    live: { run: { id: "r" }, tools: [] },
  };
  let hooked = false;
  const empty = { items: [], next: undefined };
  const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {
    scanEntries: (filter: { readonly minEntryId?: EntryId }) => {
      const min = Number(filter.minEntryId ?? 0);
      const items = log.entries.filter((record) => record.id >= min).reverse();
      const page = { items, next: undefined };
      if (min > 1 && !hooked) {
        hooked = true;
        afterNewEntriesScan(log);
      }
      return Promise.resolve(page);
    },
    findDocument: (address: { readonly kind: string }) =>
      Promise.resolve(
        address.kind === LIVE_DOC && log.live !== undefined
          ? { id: 1 }
          : undefined,
      ),
    document: () => Promise.resolve({ value: log.live }),
    findLatestHeadMarker: () => Promise.resolve(undefined),
  };
  const storage = new Proxy(
    {},
    {
      get: (_target, property) =>
        typeof property === "string" && property in handlers
          ? handlers[property]
          : typeof property === "string" && property.startsWith("scan")
            ? () => Promise.resolve(empty)
            : () => Promise.resolve(undefined),
    },
  ) as Storage;
  return { log, storage };
};

type FakeLog = {
  entries: EntryRecord[];
  live: Record<string, unknown> | undefined;
};

describe("following a log", () => {
  /**
   * Mutation: read the entries before the state in a step (the order this replaced) — the final
   * answer is scanned for before it is committed, the state after, so `status: idle` goes out one
   * step ahead of the answer, and a client that stops at idle never prints it.
   */
  it("sends every entry committed with an idle before the idle", async () => {
    const { storage } = fakeLog((log) => {
      // The owner's last commit: its answer and the run's end, together.
      log.entries.push(entry(2, "assistant", "done"));
      log.live = { tools: [] };
    });
    const events: readonly SessionEvent[] = await Effect.runPromise(
      followSessionEvents(storage, ref, Stream.make(undefined)).pipe(
        Stream.runCollect,
        Effect.map((collected) => [...collected]),
      ),
    );
    const answer = events.findIndex(
      (event) => event._tag === "entry" && event.entry.text === "done",
    );
    const idle = events.findIndex(
      (event) => event._tag === "status" && event.status === "idle",
    );
    expect(events[0]?._tag).toBe("snapshot");
    expect(answer).toBeGreaterThan(0);
    expect(idle).toBeGreaterThan(0);
    expect(answer).toBeLessThan(idle);
  });
});
