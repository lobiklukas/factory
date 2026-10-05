/**
 * The session service, driven through its own interface against a real Postgres log.
 *
 * What this proves that the harness test cannot: a session created and driven here is readable
 * *the same way* after its owner is released, which is D8's live/historical pair — the live view
 * and the fold have to agree, or the dashboard shows two different sessions depending on whether
 * a sandbox happens to be running.
 *
 * Deterministic and offline (faux model), but it needs Postgres:
 * `docker compose up -d --wait postgres`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import type { SessionEvent, SessionId } from "@repo/domain/Session";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Ref,
  Stream,
} from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { createModelAccess } from "@repo/harness";
import { SessionService, SessionServiceLive } from "./SessionService";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-core-"));

const runtime = ManagedRuntime.make(
  SessionServiceLive({ model: createModelAccess("faux"), sessionRoot }).pipe(
    Layer.provide(Layer.mergeAll(DatabaseLive, BunServices.layer)),
  ),
);

const program = <A, E>(effect: Effect.Effect<A, E, SessionService>) =>
  runtime.runPromise(effect);

afterAll(async () => {
  await runtime.dispose();
});

/** Poll until `check`, so a test never depends on a fixed delay. */
const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label: string,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

describe("SessionService", () => {
  it("creates, drives, streams, and folds the same session", async () => {
    const session = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "probing" });
        expect(created.title).toBe("probing");
        expect(created.mode).toBe("live");
        expect(created.status).toBe("idle");
        expect(created.id).toMatch(/^ses_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);

        // Send admits the message durably and returns; the answer arrives later, which is what
        // the stream is for. Wait for the run to settle before reading the transcript.
        const sent = yield* sessions.send({
          sessionId: created.id,
          content: "hello",
        });
        expect(sent.placement).toBe("run");
        expect(sent.submissionId).toEqual(expect.any(String));
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the first turn to settle",
        );

        const live = yield* sessions.get(created.id);
        expect(live.session.mode).toBe("live");
        expect(live.entries.map((entry) => entry.kind)).toEqual([
          "title",
          "user",
          "system",
          "assistant",
          "toolResult",
          "assistant",
        ]);
        expect(
          live.entries.find((entry) => entry.kind === "toolResult")?.toolName,
        ).toBe("bash");
        // The title is in the log, not only in the index, so a rebuild can recover it.
        expect(live.entries[0]?.kind).toBe("title");
        expect(live.entries.at(-1)?.text).toBe("faux-ok (re: hello)");
        // The faux provider reports token usage, so spend survives the projection.
        expect(live.usage.models[0]?.usage.totalTokens).toBeGreaterThan(0);

        return { id: created.id, entries: live.entries };
      }),
    );

    // A client that attaches while the session is live: one snapshot, then the entries of the
    // next turn as they commit.
    const streamed = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const collected = yield* Ref.make<readonly SessionEvent[]>([]);
        const fiber = yield* sessions.events(session.id).pipe(
          Stream.tap((event) =>
            Ref.update(collected, (all) => [...all, event]),
          ),
          Stream.runDrain,
          Effect.forkChild,
        );

        yield* waitUntil(
          Ref.get(collected).pipe(
            Effect.map((all) => all.some((e) => e._tag === "snapshot")),
          ),
          "the attached snapshot",
        );
        const second = yield* sessions.send({
          sessionId: session.id,
          content: "again",
        });
        expect(second.placement).toBe("run");
        yield* waitUntil(
          sessions
            .get(session.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the second turn to settle",
        );
        yield* waitUntil(
          Ref.get(collected).pipe(
            Effect.map(
              (all) =>
                all.some((event) => event._tag === "entry") &&
                all.some((event) => event._tag === "status"),
            ),
          ),
          "entries and status from the second turn",
        );
        yield* Fiber.interrupt(fiber);

        const all = yield* Ref.get(collected);
        const snapshot = all[0];
        expect(snapshot?._tag).toBe("snapshot");
        if (snapshot?._tag !== "snapshot") throw new Error("unreachable");
        expect(snapshot.session.mode).toBe("live");
        expect(snapshot.entries).toEqual(session.entries);
        // A run goes busy and comes back to idle within one turn.
        expect(
          all.flatMap((event) =>
            event._tag === "status" ? [event.status] : [],
          ),
        ).toContain("busy");
        return all;
      }),
    );
    expect(streamed.length).toBeGreaterThan(2);

    // Release the owner. The session is now what D8 calls historical: nobody in this process
    // holds it, so the same read is served by folding the log.
    await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.close;
      }),
    );

    const folded = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const snapshot = yield* sessions.get(session.id);
        expect(snapshot.session.mode).toBe("historical");
        expect(snapshot.session.status).toBe("idle");
        expect(snapshot.live).toEqual({ busy: false, tools: [] });

        // The fold agrees with the live read it replaced, entry for entry.
        const liveEntries = session.entries;
        expect(snapshot.entries.slice(0, liveEntries.length)).toEqual(
          liveEntries,
        );

        // A historical session's stream is one snapshot and then it ends: complete, not dropped.
        const events = Array.from(
          yield* sessions.events(session.id).pipe(Stream.runCollect),
        );
        expect(events.map((event) => event._tag)).toEqual(["snapshot"]);
        const only = events[0];
        if (only?._tag !== "snapshot") throw new Error("unreachable");
        expect(only.session.mode).toBe("historical");

        // Steering wakes it: sending again reopens the owner and continues the same conversation.
        const resumed = yield* sessions.send({
          sessionId: session.id,
          content: "third",
        });
        expect(resumed.placement).toBe("run");
        yield* waitUntil(
          sessions
            .get(session.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the third turn to settle",
        );
        const after = yield* sessions.get(session.id);
        expect(after.session.mode).toBe("live");
        expect(after.entries.length).toBeGreaterThan(snapshot.entries.length);
        return after;
      }),
    );

    expect(folded.entries.at(-1)?.text).toBe("faux-ok (re: third)");
  }, 120_000);

  it("reports an unknown session as not_found", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* Effect.exit(
          sessions.get("ses_00000000000000000000000000" as SessionId),
        );
      }),
    );
    expect(Exit.isFailure(outcome)).toBe(true);
    if (Exit.isSuccess(outcome)) throw new Error("unreachable");
    const failure = Exit.findErrorOption(outcome);
    expect(failure._tag).toBe("Some");
    if (failure._tag !== "Some") throw new Error("unreachable");
    expect(failure.value.code).toBe("not_found");
  });

  it("defaults the title from the first message", async () => {
    const titled = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create();
        expect(created.title).toBe("");
        const sent = yield* sessions.send({
          sessionId: created.id,
          content: "fix the flaky login test\nand then run the suite",
        });
        return sent.session.title;
      }),
    );
    expect(titled).toBe("fix the flaky login test");
  });
});
