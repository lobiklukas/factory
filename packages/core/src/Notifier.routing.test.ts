/**
 * Who is told, and when the settings change (F21): over the real attention view and a real ledger, an
 * approval, a question, a gate or a failure for a card reaches its owner's own sinks only, once — and
 * the shared sinks only when the card has no owner with one — and a toggle or a new sink is live on
 * the next pass of the same notifier, with no restart.
 *
 * The sinks are recording fakes with fresh ids, so the ledger rows are this file's own on a shared
 * development database; every actor is random per case, so another file's cards are nobody's here.
 * The one stored thing the cases touch is `notification_kinds.approval` — no other file's assertions
 * read it, and it is put back after.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  makeNotifier,
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationSink,
  type NotifyStorageError,
  type PeopleSinks,
} from "./Notifier";
import {
  actor,
  BASE,
  cleanup,
  fakeSink,
  kindsSent,
  seed,
} from "./notifier.test-fake";
import { storedKinds } from "./NotifySettings";
import { TaskServiceLive } from "./TaskService";

const runtime = ManagedRuntime.make(
  TaskServiceLive.pipe(Layer.provideMerge(DatabaseLive)),
);

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM notification_kinds WHERE kind = 'approval'`;
      yield* cleanup;
    }),
  );
  await runtime.dispose();
});

const ALL = ["approval", "failed", "gate", "question"];

const people = (
  ...entries: ReadonlyArray<readonly [string, ReadonlyArray<NotificationSink>]>
): Effect.Effect<PeopleSinks> => Effect.succeed(new Map(entries));

const notifierOver = (options: {
  readonly shared?: ReadonlyArray<NotificationSink>;
  readonly people?: Effect.Effect<PeopleSinks>;
  readonly kinds?:
    | ReadonlySet<NotificationKind>
    | Effect.Effect<ReadonlySet<NotificationKind>, NotifyStorageError>;
}) =>
  makeNotifier({
    sinks: options.shared ?? [],
    kinds: options.kinds ?? new Set(NOTIFICATION_KINDS),
    ...(options.people === undefined ? {} : { people: options.people }),
    linkBase: BASE,
  });

describe("who an event goes to", () => {
  it("reaches the owner's own sinks only — not another person's, not the shared channel — and once", async () => {
    const alice = actor("alice");
    const bob = actor("bob");
    const aliceMail = fakeSink();
    const alicePush = fakeSink();
    const bobMail = fakeSink();
    const shared = fakeSink();
    const seeded = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(alice);
        const roster = people(
          [alice, [aliceMail.sink, alicePush.sink]],
          [bob, [bobMail.sink]],
        );
        const first = yield* notifierOver({
          shared: [shared.sink],
          people: roster,
        });
        yield* first.pass;
        yield* first.pass;
        // A restart: a new notifier over the same ledger and the same people.
        const restarted = yield* notifierOver({
          shared: [shared.sink],
          people: roster,
        });
        yield* restarted.pass;
        return seeded;
      }),
    );
    expect(kindsSent(seeded, aliceMail.sent)).toEqual(ALL);
    expect(kindsSent(seeded, alicePush.sent)).toEqual(ALL);
    expect(kindsSent(seeded, bobMail.sent)).toEqual([]);
    expect(kindsSent(seeded, shared.sent)).toEqual([]);
  }, 60_000);

  it("falls back to the shared sinks when the card's owner has none of their own", async () => {
    const carol = actor("carol");
    const alice = actor("alice");
    const aliceMail = fakeSink();
    const shared = fakeSink();
    const seeded = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(carol);
        const notifier = yield* notifierOver({
          shared: [shared.sink],
          people: people([alice, [aliceMail.sink]]),
        });
        yield* notifier.pass;
        yield* notifier.pass;
        return seeded;
      }),
    );
    expect(kindsSent(seeded, shared.sent)).toEqual(ALL);
    expect(kindsSent(seeded, aliceMail.sent)).toEqual([]);
  }, 60_000);

  it("tells the person who started the run when the card's creator is nobody with a sink", async () => {
    const trigger = "trigger:linear";
    const dave = actor("dave");
    const daveMail = fakeSink();
    const shared = fakeSink();
    const seeded = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(trigger, dave);
        const notifier = yield* notifierOver({
          shared: [shared.sink],
          people: people([dave, [daveMail.sink]]),
        });
        yield* notifier.pass;
        return seeded;
      }),
    );
    // The run's approval, gate and failure are about a run Dave started; the question is about the card alone.
    expect(kindsSent(seeded, daveMail.sent)).toEqual([
      "approval",
      "failed",
      "gate",
    ]);
    expect(kindsSent(seeded, shared.sent)).toEqual(["question"]);
  }, 60_000);

  it("prefers the card's creator over the run's starter", async () => {
    const alice = actor("alice");
    const erin = actor("erin");
    const aliceMail = fakeSink();
    const erinMail = fakeSink();
    const seeded = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(alice, erin);
        const notifier = yield* notifierOver({
          people: people([alice, [aliceMail.sink]], [erin, [erinMail.sink]]),
        });
        yield* notifier.pass;
        return seeded;
      }),
    );
    expect(kindsSent(seeded, aliceMail.sent)).toEqual(ALL);
    expect(kindsSent(seeded, erinMail.sent)).toEqual([]);
  }, 60_000);

  it("a sink added later is sent the owner's open events once, and the shared sink is not sent them again", async () => {
    const frank = actor("frank");
    const frankMail = fakeSink();
    const shared = fakeSink();
    const roster = {
      current: new Map<string, ReadonlyArray<NotificationSink>>(),
    };
    const seeded = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(frank);
        const notifier = yield* notifierOver({
          shared: [shared.sink],
          people: Effect.sync(() => roster.current),
        });
        yield* notifier.pass;
        roster.current = new Map([[frank, [frankMail.sink]]]);
        yield* notifier.pass;
        yield* notifier.pass;
        return seeded;
      }),
    );
    expect(kindsSent(seeded, shared.sent)).toEqual(ALL);
    expect(kindsSent(seeded, frankMail.sent)).toEqual(ALL);
  }, 60_000);

  it("one mailbox two people share is one sink, sent each event once", async () => {
    const gina = actor("gina");
    const hank = actor("hank");
    const mailbox = fakeSink();
    const seeded = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(gina);
        const notifier = yield* notifierOver({
          people: people([gina, [mailbox.sink]], [hank, [mailbox.sink]]),
        });
        yield* notifier.pass;
        yield* notifier.pass;
        return seeded;
      }),
    );
    expect(kindsSent(seeded, mailbox.sent)).toEqual(ALL);
  }, 60_000);
});

describe("settings that change while the notifier runs", () => {
  it("a kind toggled off stops its events and toggled on sends them, on the same notifier", async () => {
    const ivy = actor("ivy");
    const mail = fakeSink();
    const wanted = {
      current: new Set<NotificationKind>(["question", "gate", "failed"]),
    };
    const seeded = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed(ivy);
        const notifier = yield* notifierOver({
          people: people([ivy, [mail.sink]]),
          kinds: Effect.sync(() => wanted.current),
        });
        yield* notifier.pass;
        const before = kindsSent(seeded, mail.sent);
        wanted.current = new Set(NOTIFICATION_KINDS);
        yield* notifier.pass;
        return { seeded, before };
      }),
    );
    expect(seeded.before).toEqual(["failed", "gate", "question"]);
    expect(kindsSent(seeded.seeded, mail.sent)).toEqual(ALL);
  }, 60_000);

  it("the stored toggle lies over NOTIFY_TYPES and is read on every pass", async () => {
    const jan = actor("jan");
    const mail = fakeSink();
    const defaults = new Set<NotificationKind>(NOTIFICATION_KINDS);
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const seeded = yield* seed(jan);
        const notifier = yield* notifierOver({
          people: people([jan, [mail.sink]]),
          kinds: storedKinds(defaults).pipe(
            Effect.provideService(SqlClient, sql),
          ),
        });
        yield* sql`
          INSERT INTO notification_kinds (kind, enabled) VALUES ('approval', FALSE)
          ON CONFLICT (kind) DO UPDATE SET enabled = FALSE
        `;
        yield* notifier.pass;
        const whileOff = kindsSent(seeded, mail.sent);
        yield* sql`UPDATE notification_kinds SET enabled = TRUE WHERE kind = 'approval'`;
        yield* notifier.pass;
        const whileOn = kindsSent(seeded, mail.sent);
        yield* sql`DELETE FROM notification_kinds WHERE kind = 'approval'`;
        return { whileOff, whileOn };
      }),
    );
    expect(result.whileOff).toEqual(["failed", "gate", "question"]);
    expect(result.whileOn).toEqual(ALL);
  }, 60_000);

  it("a stored kind off wins over a NOTIFY_TYPES that wants it, and one on over one that does not", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`
          INSERT INTO notification_kinds (kind, enabled) VALUES ('approval', FALSE)
          ON CONFLICT (kind) DO UPDATE SET enabled = FALSE
        `;
        const off = yield* storedKinds(new Set(["approval", "question"]));
        yield* sql`UPDATE notification_kinds SET enabled = TRUE WHERE kind = 'approval'`;
        const on = yield* storedKinds(new Set(["question"]));
        yield* sql`DELETE FROM notification_kinds WHERE kind = 'approval'`;
        const followsEnv = yield* storedKinds(new Set(["approval"]));
        return {
          off: [...off].sort(),
          on: [...on].sort(),
          followsEnv: [...followsEnv].sort(),
        };
      }),
    );
    expect(result.off).toEqual(["question"]);
    expect(result.on).toEqual(["approval", "question"]);
    expect(result.followsEnv).toEqual(["approval"]);
  }, 60_000);
});
