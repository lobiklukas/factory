/**
 * Sessions: create, drive, read, and watch one Pi Durable log (docs/design.md D7, D8, D12).
 *
 * The log is truth; everything here is a write to it or a read of it. Two things sit outside it,
 * both deliberately droppable:
 *
 * - The `sessions` row: an index of what exists, what it is called, and when it was created. The
 *   title is also committed into the log (`factory.title`), so the index can be rebuilt.
 * - The owner registry: *this process* holding the log open. Pi Durable allows one owner per log,
 *   so ownership is per process, and a session nobody here owns is served by folding the log (D8's
 *   historical read). Locally this process is also the sandbox (D3); when the harness moves into a
 *   sandbox, this registry is the seam that changes and `SessionBus` is how streams keep working.
 */
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  Ref,
  Semaphore,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type {
  CreateSessionInput,
  SendMessageInput,
  SendMessageResult,
  SessionError,
  SessionEvent,
  SessionId,
  SessionMode,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
} from "@repo/domain/Session";
import {
  SessionError as SessionErrorClass,
  SessionId as SessionIdSchema,
} from "@repo/domain/Session";
import type {
  Conversation,
  Harness,
  ModelAccess,
  SessionRef,
} from "@repo/harness";
import {
  closeHarness,
  interrupt as interruptConversation,
  isBusy,
  liveSessionEvents,
  openSession,
  readHistoricalSnapshot,
  readLiveSnapshot,
  snapshotEvent,
  submitMessage,
  writeTitle,
} from "@repo/harness";
import { PostgresStorage } from "@repo/storage-postgres";
import { mintSessionId } from "./ids";

/** Longest title we derive from a first message, in characters. */
const TITLE_MAX = 80;

/** How often idle owners are swept, when sweeping is on at all. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export type SessionServiceShape = {
  readonly create: (
    input?: CreateSessionInput,
  ) => Effect.Effect<SessionSummary, SessionError>;
  readonly get: (
    sessionId: SessionId,
  ) => Effect.Effect<SessionSnapshot, SessionError>;
  readonly send: (
    input: SendMessageInput,
  ) => Effect.Effect<SendMessageResult, SessionError>;
  readonly interrupt: (
    sessionId: SessionId,
  ) => Effect.Effect<SessionSummary, SessionError>;
  /** A session's events: live while this process owns it, a single historical snapshot otherwise. */
  readonly events: (
    sessionId: SessionId,
  ) => Stream.Stream<SessionEvent, SessionError>;
  /** Close every harness this process owns. */
  readonly close: Effect.Effect<void>;
};

export class SessionService extends Context.Service<
  SessionService,
  SessionServiceShape
>()("@repo/core/SessionService") {}

export type SessionServiceOptions = {
  readonly model: ModelAccess;
  /** Where a session's working directory is created, one directory per session. */
  readonly sessionRoot: string;
  /**
   * Close an owner that has been idle this long, releasing its fold. `undefined` keeps every owner
   * open, which is what a test wants and what a long-lived server does not.
   */
  readonly idleTimeoutMs?: number;
  readonly sweepIntervalMs?: number;
};

type SessionRow = {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
};

type LiveOwner = {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly storage: PostgresStorage;
  readonly lastUsedAt: number;
};

const titleFrom = (content: string): string => {
  const line =
    content.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim().slice(0, TITLE_MAX);
};

const paper = <A, E>(
  what: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, SessionError> =>
  Effect.mapError(
    effect,
    (cause) =>
      new SessionErrorClass({
        code: "storage",
        message: `${what}: ${String(cause)}`,
      }),
  );

export const SessionServiceLive = (options: SessionServiceOptions) =>
  Layer.effect(
    SessionService,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const live = yield* Ref.make(HashMap.empty<SessionId, LiveOwner>());
      /** Serializes owner acquisition so two callers cannot open the same log twice. */
      const gate = yield* Semaphore.make(1);

      const toSessionId = (
        raw: string,
      ): Effect.Effect<SessionId, SessionError> =>
        Effect.try({
          try: () => SessionIdSchema.make(raw),
          catch: () =>
            new SessionErrorClass({
              code: "storage",
              message: `the sessions table holds an invalid id: ${raw}`,
            }),
        });

      const summarize = (
        id: SessionId,
        row: SessionRow,
        mode: SessionMode,
        status: SessionStatus,
      ): SessionSummary => ({
        id,
        title: row.title,
        mode,
        status,
        createdAt: row.createdAt,
      });

      const refOf = (id: SessionId, row: SessionRow): SessionRef => ({
        id,
        title: row.title,
        createdAt: row.createdAt,
      });

      const openStorage = (
        logId: SessionId,
        mode: "owner" | "reader",
      ): Effect.Effect<PostgresStorage, SessionError> =>
        Effect.tryPromise({
          try: () =>
            mode === "owner"
              ? PostgresStorage.owner(sql, logId)
              : PostgresStorage.reader(sql, logId),
          catch: (cause) =>
            new SessionErrorClass({
              code: "storage",
              message: `open log ${logId} in ${mode} mode: ${String(cause)}`,
            }),
        });

      const withReader = <A>(
        logId: SessionId,
        use: (storage: PostgresStorage) => Effect.Effect<A, SessionError>,
      ): Effect.Effect<A, SessionError> =>
        Effect.acquireUseRelease(openStorage(logId, "reader"), use, (storage) =>
          Effect.promise(() => storage.dispose()),
        );

      const requireSession = (
        sessionId: SessionId,
      ): Effect.Effect<SessionRow, SessionError> =>
        Effect.gen(function* () {
          const rows = yield* paper("read session", readSessionById(sessionId));
          const row = rows[0];
          if (row === undefined) {
            return yield* new SessionErrorClass({
              code: "not_found",
              message: `no session ${sessionId}`,
            });
          }
          return row;
        });

      const touch = (sessionId: SessionId): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.update(live, (owners) =>
            Option.match(HashMap.get(owners, sessionId), {
              onNone: () => owners,
              onSome: (owner) =>
                HashMap.set(owners, sessionId, { ...owner, lastUsedAt: now }),
            }),
          );
        });

      const ensureSessionDir = (
        sessionId: SessionId,
      ): Effect.Effect<string, SessionError> =>
        Effect.gen(function* () {
          const directory = path.join(options.sessionRoot, sessionId);
          yield* Effect.mapError(
            fs.makeDirectory(directory, { recursive: true }),
            (cause) =>
              new SessionErrorClass({
                code: "harness",
                message: `create ${directory}: ${String(cause)}`,
              }),
          );
          return directory;
        });

      /** Open this process's owner of one session, or return the one already open. */
      const acquireOwner = (
        sessionId: SessionId,
      ): Effect.Effect<LiveOwner, SessionError> =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const owners = yield* Ref.get(live);
            const existing = HashMap.get(owners, sessionId);
            if (Option.isSome(existing)) {
              const touched = { ...existing.value, lastUsedAt: now };
              yield* Ref.update(live, HashMap.set(sessionId, touched));
              return touched;
            }

            const cwd = yield* ensureSessionDir(sessionId);
            const storage = yield* openStorage(sessionId, "owner");
            const opened = yield* openSession({
              storage,
              model: options.model,
              cwd,
            }).pipe(
              Effect.tapError(() => Effect.promise(() => storage.dispose())),
            );
            const owner: LiveOwner = {
              harness: opened.harness,
              root: opened.root,
              storage,
              lastUsedAt: now,
            };
            yield* Ref.update(live, HashMap.set(sessionId, owner));
            return owner;
          }),
        );

      const describe = (
        id: SessionId,
        row: SessionRow,
      ): Effect.Effect<SessionSummary, SessionError> =>
        Effect.gen(function* () {
          const owners = yield* Ref.get(live);
          const owner = HashMap.get(owners, id);
          if (Option.isNone(owner))
            return summarize(id, row, "historical", "idle");
          const busy = yield* isBusy(owner.value.harness, owner.value.root);
          yield* touch(id);
          return summarize(id, row, "live", busy ? "busy" : "idle");
        });

      const setTitle = (
        sessionId: SessionId,
        title: string,
      ): Effect.Effect<void, SessionError> =>
        paper(
          "write session title",
          sql`UPDATE sessions SET title = ${title} WHERE id = ${sessionId}`,
        );

      const create = (
        input: CreateSessionInput = {},
      ): Effect.Effect<SessionSummary, SessionError> =>
        Effect.gen(function* () {
          const requested =
            input.requestId === undefined
              ? undefined
              : yield* paper(
                  "read session by request",
                  readSessionByRequest(input.requestId),
                );
          const already = requested?.[0];
          if (already !== undefined) {
            return yield* describe(yield* toSessionId(already.id), already);
          }

          const id = yield* mintSessionId;
          const title = (input.title ?? "").trim().slice(0, TITLE_MAX);
          const inserted = yield* paper(
            "create session",
            insertSession(id, title, input.requestId),
          );
          const owner = yield* acquireOwner(id);
          if (title.length > 0) {
            // The log keeps the title too, so rebuilding the index does not lose it.
            yield* writeTitle(owner.root, title);
          }
          const row = inserted[0] ?? { id, title, createdAt: "" };
          return yield* describe(id, row);
        });

      const get = (
        sessionId: SessionId,
      ): Effect.Effect<SessionSnapshot, SessionError> =>
        Effect.gen(function* () {
          const row = yield* requireSession(sessionId);
          const owners = yield* Ref.get(live);
          const owner = HashMap.get(owners, sessionId);
          if (Option.isSome(owner)) {
            yield* touch(sessionId);
            return yield* readLiveSnapshot(
              owner.value.root,
              refOf(sessionId, row),
            );
          }
          return yield* withReader(sessionId, (storage) =>
            readHistoricalSnapshot(storage, refOf(sessionId, row)),
          );
        });

      const send = (
        input: SendMessageInput,
      ): Effect.Effect<SendMessageResult, SessionError> =>
        Effect.gen(function* () {
          const row = yield* requireSession(input.sessionId);
          const owner = yield* acquireOwner(input.sessionId);

          // The first message names the session when nothing else has.
          const title =
            row.title.length > 0 ? row.title : titleFrom(input.content);
          if (row.title.length === 0) {
            yield* writeTitle(owner.root, title);
            yield* setTitle(input.sessionId, title);
          }

          const submitted = yield* submitMessage(owner.root, {
            content: input.content,
            ...(input.requestId === undefined
              ? {}
              : { requestId: input.requestId }),
            ...(input.whenBusy === undefined
              ? {}
              : { whenBusy: input.whenBusy }),
          });
          const session = yield* describe(input.sessionId, { ...row, title });
          return {
            session,
            submissionId: submitted.submissionId,
            // A queued message joined the queue the caller asked for; Pi Durable's default is a
            // follow-up, and `reject` never queues (it fails the call instead). A placed one
            // started the run.
            placement: submitted.queued
              ? input.whenBusy === "steer"
                ? "steer"
                : "followUp"
              : "run",
          };
        });

      const interrupt = (
        sessionId: SessionId,
      ): Effect.Effect<SessionSummary, SessionError> =>
        Effect.gen(function* () {
          const row = yield* requireSession(sessionId);
          // Steering wakes the session first (D8): acquiring the owner is what waking means here.
          const owner = yield* acquireOwner(sessionId);
          yield* interruptConversation(owner.root);
          return yield* describe(sessionId, row);
        });

      const readSessionById = (sessionId: SessionId) =>
        sql<SessionRow>`
          SELECT
            id,
            title,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
          FROM sessions
          WHERE id = ${sessionId}
        `;

      const readSessionByRequest = (requestId: string) =>
        sql<SessionRow>`
          SELECT
            id,
            title,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
          FROM sessions
          WHERE request_id = ${requestId}
        `;

      const insertSession = (
        id: SessionId,
        title: string,
        requestId: string | undefined,
      ) =>
        sql<SessionRow>`
          INSERT INTO sessions (id, title, request_id)
          VALUES (${id}, ${title}, ${requestId ?? null})
          RETURNING
            id,
            title,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
        `;

      const events = (
        sessionId: SessionId,
      ): Stream.Stream<SessionEvent, SessionError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const row = yield* requireSession(sessionId);
            const owners = yield* Ref.get(live);
            const owner = HashMap.get(owners, sessionId);
            if (Option.isSome(owner)) {
              yield* touch(sessionId);
              return liveSessionEvents(owner.value.root, refOf(sessionId, row));
            }
            // Nobody owns it: fold once, send the snapshot, and end the stream, so a client can
            // tell a completed fold from a dropped connection (D8).
            const snapshot = yield* withReader(sessionId, (storage) =>
              readHistoricalSnapshot(storage, refOf(sessionId, row)),
            );
            return Stream.make(snapshotEvent(snapshot));
          }),
        );

      const closeAll = Effect.gen(function* () {
        const owners = yield* Ref.get(live);
        yield* Ref.set(live, HashMap.empty());
        yield* Effect.forEach(
          HashMap.values(owners),
          (owner) =>
            closeHarness(owner.harness).pipe(
              Effect.ignore,
              Effect.andThen(Effect.promise(() => owner.storage.dispose())),
            ),
          { discard: true },
        );
      });

      const sweep = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const owners = yield* Ref.get(live);
        for (const [sessionId, owner] of HashMap.toEntries(owners)) {
          if (now - owner.lastUsedAt < (options.idleTimeoutMs ?? 0)) continue;
          // Only idle owners are closed: a run in flight is durable either way, but closing it
          // would throw away the fold a live client is streaming from.
          const busy = yield* isBusy(owner.harness, owner.root).pipe(
            Effect.orElseSucceed(() => true),
          );
          if (busy) continue;
          yield* closeHarness(owner.harness).pipe(Effect.ignore);
          yield* Effect.promise(() => owner.storage.dispose());
          yield* Ref.update(live, HashMap.remove(sessionId));
        }
      });

      if (options.idleTimeoutMs !== undefined) {
        // Sweep at least twice per timeout window, so the timeout means what it says. Idle here
        // means nobody has touched the session: a read counts as use, so a client watching a
        // session keeps it open, and only a genuinely quiet session is released to its log.
        const sweepIntervalMs =
          options.sweepIntervalMs ??
          Math.max(
            250,
            Math.min(DEFAULT_SWEEP_INTERVAL_MS, options.idleTimeoutMs / 2),
          );
        yield* Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(sweepIntervalMs);
            yield* sweep;
          }
        }).pipe(Effect.forkScoped);
      }

      return SessionService.of({
        create,
        get,
        send,
        interrupt,
        events,
        close: closeAll,
      });
    }),
  );
