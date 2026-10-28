/**
 * Two `SessionService`s over one database (LOB-18, D12): one owning a session, one not, and both
 * streaming it live.
 *
 * Each runtime is a process as far as presence is concerned — its own holder, its own session root —
 * so the second sees the first's lease and follows the log rather than folding it once. The owner's
 * model naps before each step, so a run is busy long enough for the follower to see it start and
 * stop.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SessionError,
  SessionEvent,
  SessionId,
  SessionSnapshot,
} from "@repo/domain/Session";
import { createFauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import {
  SessionService,
  SessionServiceLive,
  type SessionServiceShape,
} from "./SessionService";

const DatabaseLayer = Layer.mergeAll(DatabaseLive, BunServices.layer);

/** One process: its own root, its own presence, and how often it polls what it follows. */
const processWith = (
  label: string,
  presence: { readonly ttlMs?: number; readonly followPollMs?: number },
) =>
  ManagedRuntime.make(
    SessionServiceLive({
      model: createFauxModelAccess({ fauxSleepMs: 300 }).access,
      sessionRoot: mkdtempSync(join(tmpdir(), `factory-follow-${label}-`)),
      presence,
    }).pipe(Layer.provideMerge(DatabaseLayer)),
  );

/** The owner the streams follow: the default TTL, so a late heartbeat under load ends nothing. */
const owner = processWith("owner", {});
/** An owner whose heartbeat comes every 300ms, for the case that waits for it to notice a loss. */
const shortLived = processWith("short-lived", { ttlMs: 900 });
const follower = processWith("follower", { followPollMs: 100 });
/** A follower whose poll is a minute away: anything it hears sooner, it heard from the bus. */
const deaf = processWith("deaf", { followPollMs: 60_000 });

afterAll(async () => {
  await owner.dispose();
  await shortLived.dispose();
  await follower.dispose();
  await deaf.dispose();
});

const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label: string,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const settled = (sessions: SessionServiceShape, sessionId: SessionId) =>
  waitUntil(
    sessions
      .get(sessionId)
      .pipe(
        Effect.map(
          (snapshot) =>
            !snapshot.live.busy &&
            snapshot.entries.at(-1)?.kind === "assistant",
        ),
      ),
    "the owner's run to settle",
  );

/** The transcript a stream told its client: the snapshot's entries, then every entry event. */
const transcriptOf = (events: readonly SessionEvent[]) =>
  events.flatMap((event) =>
    event._tag === "snapshot"
      ? event.entries.map((entry) => entry.id)
      : event._tag === "entry"
        ? [event.entry.id]
        : [],
  );

const errorOf = <A>(exit: Exit.Exit<A, SessionError>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error
    : undefined;

describe("following a session another process owns", () => {
  /**
   * Mutation: drop `events`' third branch — the follower gets one `historical` snapshot and the
   * stream ends before the run starts.
   * Mutation: no presence lease on acquisition — the same, since nothing says the owner is elsewhere.
   * Mutation: send entries from the snapshot's window again (cursor not advanced) — the follower's
   * transcript holds duplicates and is not the owner's.
   * Mutation: drop the poll's ownership check — the stream never ends once the owner closes.
   * Mutation: refuse nothing in `acquireUnderGate` — the follower's `send` opens a second owner.
   */
  it("streams the same session live, entry for entry, and ends when the owner lets go", async () => {
    const created = await owner.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* sessions.create({ title: "followed from elsewhere" });
      }),
    );
    const events: SessionEvent[] = [];
    const attached = await Effect.runPromise(Deferred.make<void>());
    const following = follower.runFork(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.events(created.id).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event._tag === "snapshot")
                yield* Deferred.succeed(attached, undefined);
            }),
          ),
        );
      }),
    );
    await Effect.runPromise(Deferred.await(attached));

    const followedGet = await follower.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* sessions.get(created.id);
      }),
    );
    const refusedSend = await follower.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* Effect.exit(
          sessions.send({ sessionId: created.id, content: "not here" }),
        );
      }),
    );

    const ownerFinal = await owner.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.send({ sessionId: created.id, content: "hello" });
        yield* settled(sessions, created.id);
        return yield* sessions.get(created.id);
      }),
    );
    // Caught up: the follower has told its client everything the owner's transcript holds.
    await Effect.runPromise(
      waitUntil(
        Effect.sync(
          () =>
            transcriptOf(events).length === ownerFinal.entries.length &&
            events.some(
              (event) => event._tag === "status" && event.status === "idle",
            ),
        ),
        "the follower to catch up",
      ),
    );
    const streamedWhileOwned = [...events];

    // The owner lets go; the follower's stream ends on its next poll, and a read is a fold again.
    await owner.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.close;
      }),
    );
    const ended = await Effect.runPromise(
      Fiber.await(following).pipe(Effect.timeout("10 seconds")),
    );
    const afterwards: SessionSnapshot = await follower.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* sessions.get(created.id);
      }),
    );

    const snapshot = streamedWhileOwned[0];
    expect(snapshot?._tag).toBe("snapshot");
    if (snapshot?._tag === "snapshot") {
      expect(snapshot.session.mode).toBe("live");
    }
    expect(followedGet.session.mode).toBe("live");
    // Entry for entry, each once: the follower's transcript is the owner's.
    expect(transcriptOf(streamedWhileOwned)).toEqual(
      ownerFinal.entries.map((entry) => entry.id),
    );
    const streamed = streamedWhileOwned.flatMap((event) =>
      event._tag === "entry" ? [event.entry] : [],
    );
    expect(streamed.map((entry) => entry.kind)).toContain("user");
    expect(streamed.find((entry) => entry.kind === "user")?.text).toBe("hello");
    expect(streamed.at(-1)?.kind).toBe("assistant");
    // It saw the run start and stop, in that order.
    const statuses = streamedWhileOwned.flatMap((event) =>
      event._tag === "status" ? [event.status] : [],
    );
    expect(statuses).toEqual(["busy", "idle"]);
    // Work goes where the session is owned: the follower refuses rather than opening a second owner.
    expect(errorOf(refusedSend)?.code).toBe("owned_elsewhere");
    expect(Exit.isSuccess(ended)).toBe(true);
    expect(afterwards.session.mode).toBe("historical");
    expect(afterwards.entries.map((entry) => entry.id)).toEqual(
      ownerFinal.entries.map((entry) => entry.id),
    );
  }, 60_000);

  /**
   * Mutation: drop migration 0034's trigger, or never subscribe to the bus — nothing reaches the
   * follower before its minute-long poll, and the case times out.
   */
  it("hears a commit from the bus, not only from its poll", async () => {
    const created = await owner.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* sessions.create({ title: "hinted" });
      }),
    );
    const attached = await Effect.runPromise(Deferred.make<void>());
    const heard = deaf.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* sessions.events(created.id).pipe(
          Stream.tap((event) =>
            event._tag === "snapshot"
              ? Deferred.succeed(attached, undefined)
              : Effect.void,
          ),
          Stream.filter((event) => event._tag === "entry"),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("20 seconds"),
        );
      }),
    );
    await Effect.runPromise(Deferred.await(attached));
    await owner.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.send({ sessionId: created.id, content: "a hint" });
        yield* settled(sessions, created.id);
      }),
    );
    const first = [...(await heard)][0];
    expect(first?._tag).toBe("entry");
    if (first?._tag === "entry") {
      expect(first.entry.kind).toBe("user");
      expect(first.entry.text).toBe("a hint");
    }
  }, 60_000);

  /**
   * Mutation: the heartbeat ignores a renewal that came back short — the owner stays registered and
   * its `send` succeeds against a log another holder claims.
   * Mutation: release a lost owner as a closed one — its idle overwrites the usurper's busy.
   */
  it("releases an owner whose lease another process took", async () => {
    const outcome = await shortLived.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const created = yield* sessions.create({ title: "usurped" });
        const before = yield* sessions.get(created.id);
        // Another process takes the claim (a takeover, as a boot sweep of the same home makes one).
        yield* sql`
          UPDATE leases SET holder = 'usurper', home = 'another-host:/elsewhere',
            fence = fence + 1, expires_at = now() + interval '1 minute'
          WHERE kind = 'session' AND key = ${created.id}
        `;
        // ...and reports the session busy, as its projection would once its run starts.
        yield* sql`
          INSERT INTO session_activity (session_id, status, last_activity_at)
          VALUES (${created.id}, 'busy', now())
          ON CONFLICT (session_id) DO UPDATE SET status = 'busy'
        `;
        // The owner's heartbeat (a third of its 900ms TTL) finds the claim gone and lets go.
        yield* waitUntil(
          Effect.exit(
            sessions.send({ sessionId: created.id, content: "still mine?" }),
          ).pipe(
            Effect.map((exit) => errorOf(exit)?.code === "owned_elsewhere"),
          ),
          "the owner to be released",
        );
        const followed = yield* sessions.get(created.id);
        const activity = yield* sql<{ readonly status: string }>`
          SELECT status FROM session_activity WHERE session_id = ${created.id}
        `;
        yield* sql`DELETE FROM leases WHERE kind = 'session' AND key = ${created.id}`;
        return { before, followed, status: activity[0]?.status };
      }),
    );
    expect(outcome.before.session.mode).toBe("live");
    // Still live — the usurper owns it — and read here from the log.
    expect(outcome.followed.session.mode).toBe("live");
    // The released owner wrote no idle over the status the usurper reports.
    expect(outcome.status).toBe("busy");
  }, 60_000);

  /**
   * Mutation: acquire over a live lease — the send is accepted while the dead process still holds.
   * Mutation: keep the dead holder's fence — the claim reads fence 1, not 2.
   * Mutation: no `takeWhile` on the poll — the stream outlives the lapsed lease.
   */
  it("hands a dead owner's session on once its lease lapses, ending the streams that followed it", async () => {
    const created = await follower.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const made = yield* sessions.create({ title: "orphaned" });
        yield* sessions.close;
        return made;
      }),
    );
    // A process that held it and died: its lease stands until its TTL, and nothing renews it.
    await follower.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`
          INSERT INTO leases (kind, key, holder, home, expires_at)
          VALUES ('session', ${created.id}, 'dead', '/nowhere', now() + interval '1 minute')
        `;
      }),
    );
    const outcome = await follower.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const stream = yield* sessions
          .events(created.id)
          .pipe(Stream.runCollect, Effect.forkChild);
        const refused = yield* Effect.exit(
          sessions.send({ sessionId: created.id, content: "too soon" }),
        );
        yield* sql`
          UPDATE leases SET expires_at = now() - interval '1 second'
          WHERE kind = 'session' AND key = ${created.id}
        `;
        const streamed = yield* Fiber.join(stream).pipe(
          Effect.timeout("10 seconds"),
        );
        const accepted = yield* Effect.exit(
          sessions.send({ sessionId: created.id, content: "now" }),
        );
        const claim = yield* sql<{
          readonly fence: string | number;
          readonly home: string;
        }>`SELECT fence, home FROM leases WHERE kind = 'session' AND key = ${created.id}`;
        yield* settled(sessions, created.id);
        return { refused, streamed: [...streamed], accepted, claim: claim[0] };
      }),
    );
    expect(errorOf(outcome.refused)?.code).toBe("owned_elsewhere");
    expect(errorOf(outcome.refused)?.message).toContain("dead");
    const first = outcome.streamed[0];
    expect(first?._tag === "snapshot" && first.session.mode).toBe("live");
    expect(Exit.isSuccess(outcome.accepted)).toBe(true);
    expect(Number(outcome.claim?.fence)).toBe(2);
    expect(outcome.claim?.home).not.toBe("/nowhere");
  }, 60_000);
});
