/**
 * The bus (docs/design.md D12, LOB-18): how a process hears that a log it does not own has moved.
 *
 * Every insert into `commits` notifies `factory_commits` with a cursor — `{log_id, seq}`, never the
 * commit (migration 0035) — and this listens on that channel once per process and fans the cursors
 * out to whoever follows a log. A cursor is a hint: a follower reads the log from where it is, so a
 * hint that is dropped (a sliding buffer that overflowed, a connection that was lost and listened
 * again) costs the follower a delay until its next read, never an event.
 *
 * The listener starts on the first subscription rather than with the layer, so a process that never
 * follows a log never holds the connection a `LISTEN` pins, and one that lost it listens again on
 * the next subscription.
 */
import { PgClient } from "@effect/sql-pg";
import {
  Context,
  Effect,
  Exit,
  Layer,
  PubSub,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";

/** The channel migration 0035's trigger notifies on. */
export const COMMITS_CHANNEL = "factory_commits";

/** Where one log has got to: the commit a notification announced. */
export type CommitCursor = { readonly logId: string; readonly seq: number };

export type SessionBusShape = {
  /**
   * Hear about one log's commits from now on: subscribed when this answers, so a commit made after
   * it is heard, and unsubscribed when the scope closes. Hints only — see the module comment.
   */
  readonly subscribe: (
    logId: string,
  ) => Effect.Effect<Stream.Stream<CommitCursor>, never, Scope.Scope>;
};

export class SessionBus extends Context.Service<SessionBus, SessionBusShape>()(
  "@repo/core/SessionBus",
) {}

/** Cursors a slow follower may fall behind by before the oldest are dropped. Hints drop safely. */
const HINT_BUFFER = 1_024;

const CursorPayload = Schema.fromJsonString(
  Schema.Struct({ log_id: Schema.String, seq: Schema.Finite }),
);
const decodeCursor = Schema.decodeUnknownOption(CursorPayload);

/** A notification's payload as a cursor; anything else on the channel is ignored. */
export const parseCursor = (payload: string): CommitCursor | undefined => {
  const decoded = decodeCursor(payload);
  return decoded._tag === "Some"
    ? { logId: decoded.value.log_id, seq: decoded.value.seq }
    : undefined;
};

/** The bus over Postgres `LISTEN`/`NOTIFY`, one listening connection per process at most. */
export const SessionBusPostgres = Layer.effect(
  SessionBus,
  Effect.gen(function* () {
    const pg = yield* PgClient.PgClient;
    const layerScope = yield* Effect.scope;
    const hints = yield* PubSub.sliding<CommitCursor>(HINT_BUFFER);
    const listening = yield* Ref.make(false);
    const lock = yield* Semaphore.make(1);

    /**
     * Listen, if nothing is: the `LISTEN` is confirmed before this answers, so a subscriber that
     * waited on it hears every commit made afterwards. The connection lives in a scope of its own,
     * closed when the reader stops — a lost connection ends the reader, which marks the bus as not
     * listening, so the next subscription listens again.
     */
    const ensureListening = lock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(listening)) return;
        const connection = yield* Scope.fork(layerScope);
        const queue = yield* pg.listen(COMMITS_CHANNEL).pipe(
          Scope.provide(connection),
          Effect.tapError(() => Scope.close(connection, Exit.void)),
        );
        yield* Ref.set(listening, true);
        yield* Stream.fromQueue(queue).pipe(
          Stream.runForEach((notification) => {
            const cursor = parseCursor(notification.payload);
            return cursor === undefined
              ? Effect.void
              : PubSub.publish(hints, cursor);
          }),
          Effect.catch((error) =>
            Effect.logWarning(
              `the commit listener stopped; followers fall back to polling until the next subscription listens again: ${String(error)}`,
            ),
          ),
          Effect.ensuring(
            Effect.andThen(
              Ref.set(listening, false),
              Scope.close(connection, Exit.void),
            ),
          ),
          Effect.forkIn(layerScope),
        );
      }),
    );

    const subscribe = (
      logId: string,
    ): Effect.Effect<Stream.Stream<CommitCursor>, never, Scope.Scope> =>
      Effect.gen(function* () {
        // Subscribed before listening, so nothing published between the two is missed by this
        // subscriber; a failure to listen leaves it a subscription that hears nothing, which a
        // follower's poll covers.
        const subscription = yield* PubSub.subscribe(hints);
        yield* ensureListening.pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `could not listen for commits; following log ${logId} by polling: ${String(error)}`,
            ),
          ),
        );
        return Stream.fromSubscription(subscription).pipe(
          Stream.filter((cursor) => cursor.logId === logId),
        );
      });

    return SessionBus.of({ subscribe });
  }),
);
