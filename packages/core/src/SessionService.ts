/**
 * Sessions: create, drive, read, and watch one Pi Durable log (docs/design.md D7, D8, D12).
 *
 * The log is truth; everything here is a write to it or a read of it. Three things sit outside it,
 * all deliberately droppable and all rebuildable from it by `rebuildIndexes` (`./rebuild.ts`):
 *
 * - The `sessions` row: an index of what exists, what it is called, which repo it works on, and
 *   when it was created. The title is also committed into the log (`factory.title`) and the repo
 *   binding as a document (`factory.session`), so the index can be rebuilt.
 * - The `session_activity` row: status, spend, and last activity, written as this process observes
 *   the session's committed changes, so `listSessions` never folds a log (R6).
 * - The `repos` row: where a repo is cloned from and which ref sessions start at.
 *
 * The owner registry — *this process* holding the log open — is the one thing that is not durable
 * and cannot be rebuilt. Pi Durable allows one owner per log, so ownership is per process, and a
 * session nobody here owns is served by folding the log (D8's historical read). Locally this
 * process is also the sandbox (D3); when the harness moves into a sandbox, this registry is the
 * seam that changes and `SessionBus` is how streams keep working.
 */
import {
  Clock,
  Context,
  Effect,
  FiberMap,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type {
  CreateSessionInput,
  ListSessionsInput,
  ListSessionsOutput,
  RegisterRepoInput,
  RepoSummary,
  SendMessageInput,
  SendMessageResult,
  SessionError,
  SessionEvent,
  SessionId,
  SessionListEntry,
  SessionMode,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  SessionUsage,
  SessionWorkspace,
} from "@repo/domain/Session";
import {
  RepoSlug,
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
  writeRepoBinding,
  writeTitle,
} from "@repo/harness";
import { PostgresStorage } from "@repo/storage-postgres";
import { mintSessionId } from "./ids";
import { resolveWorkspace } from "./workspace";

/** Longest title we derive from a first message, in characters. */
const TITLE_MAX = 80;

/** Longest message a session accepts, in characters. Beyond this the call is refused, not truncated. */
export const MAX_MESSAGE_CHARS = 100_000;

/** How often idle owners are swept, when sweeping is at all. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Page size for `listSessions` when the caller does not choose one, and the largest we serve. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

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
  /** What exists, newest activity first, from the activity index — never a fold (R6). */
  readonly list: (
    input: ListSessionsInput,
  ) => Effect.Effect<ListSessionsOutput, SessionError>;
  /** Register or update a repo a session can bind to (docs/features.md §3 A1). */
  readonly registerRepo: (
    input: RegisterRepoInput,
  ) => Effect.Effect<RepoSummary, SessionError>;
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
  readonly repo: string | null;
  readonly baseRef: string | null;
  readonly createdAt: string;
};

type RepoRow = {
  readonly slug: string;
  readonly url: string;
  readonly defaultBaseRef: string;
  readonly localPath: string | null;
  readonly registeredAt: string;
};

type ListRow = {
  readonly id: string;
  readonly title: string;
  readonly repo: string | null;
  readonly baseRef: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly costTotal: number;
};

/** A repo binding as `createSession` asked for it, resolved against the registry. */
type Binding = {
  readonly repo?: RepoSlug;
  readonly baseRef?: string;
  readonly localPath?: string;
};

type LiveOwner = {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly storage: PostgresStorage;
  /** Resolved when the owner was opened, so a live read never touches the disk or the registry. */
  readonly workspace: SessionWorkspace;
  readonly lastUsedAt: number;
};

const titleFrom = (content: string): string => {
  const line =
    content.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim().slice(0, TITLE_MAX);
};

/** Total spend, which is what the list shows; per-model detail stays in the snapshot. */
const costOf = (usage: SessionUsage): number =>
  usage.models.reduce((total, model) => total + model.usage.costTotal, 0);

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
      /** One activity projection per owned session; releasing an owner interrupts its fiber. */
      const projectors = yield* FiberMap.make<SessionId, void, never>();

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

      const toRepoSlug = (raw: string): Effect.Effect<RepoSlug, SessionError> =>
        Effect.try({
          try: () => RepoSlug.make(raw),
          catch: () =>
            new SessionErrorClass({
              code: "storage",
              message: `the repositories table holds an invalid slug: ${raw}`,
            }),
        });

      const summarize = (
        id: SessionId,
        row: SessionRow,
        mode: SessionMode,
        status: SessionStatus,
      ): Effect.Effect<SessionSummary, SessionError> =>
        Effect.gen(function* () {
          const repo =
            row.repo === null ? undefined : yield* toRepoSlug(row.repo);
          return {
            id,
            title: row.title,
            mode,
            status,
            createdAt: row.createdAt,
            ...(repo === undefined ? {} : { repo }),
            ...(repo === undefined || row.baseRef === null
              ? {}
              : { baseRef: row.baseRef }),
          };
        });

      const refOf = (
        id: SessionId,
        row: SessionRow,
        workspace: SessionWorkspace,
      ): SessionRef => ({
        id,
        title: row.title,
        createdAt: row.createdAt,
        workspace,
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

      const workspaceFor = (
        row: SessionRow,
      ): Effect.Effect<SessionWorkspace, SessionError> =>
        Effect.gen(function* () {
          const repo =
            row.repo === null ? undefined : yield* toRepoSlug(row.repo);
          const localPath = yield* localPathFor(repo);
          return yield* resolveWorkspace(
            {
              sessionRoot: options.sessionRoot,
              sessionId: row.id,
              repo,
              baseRef: row.baseRef ?? undefined,
              localPath,
            },
            { fs, path },
          );
        });

      const localPathFor = (
        repo: RepoSlug | undefined,
      ): Effect.Effect<string | undefined, SessionError> =>
        Effect.gen(function* () {
          if (repo === undefined) return undefined;
          const rows = yield* paper("read repo", readRepo(repo));
          return rows[0]?.localPath ?? undefined;
        });

      /** Resolve the repo binding a create asked for, registering the repo on first use. */
      const resolveBinding = (
        input: CreateSessionInput,
      ): Effect.Effect<Binding, SessionError> =>
        Effect.gen(function* () {
          const repo = input.repo;
          if (repo === undefined) return {};
          const existing = (yield* paper("read repo", readRepo(repo)))[0];
          const registered =
            existing ??
            (yield* paper(
              "register repo",
              upsertRepo({
                slug: repo,
                url: "",
                defaultBaseRef: input.baseRef ?? "main",
                localPath: null,
              }),
            ))[0];
          return {
            repo,
            baseRef: input.baseRef ?? registered?.defaultBaseRef ?? "main",
            ...(registered?.localPath == null
              ? {}
              : { localPath: registered.localPath }),
          };
        });

      const registerRepo = (
        input: RegisterRepoInput,
      ): Effect.Effect<RepoSummary, SessionError> =>
        Effect.gen(function* () {
          const existing = (yield* paper("read repo", readRepo(input.repo)))[0];
          const rows = yield* paper(
            "register repo",
            upsertRepo({
              slug: input.repo,
              url: input.url ?? existing?.url ?? "",
              defaultBaseRef:
                input.defaultBaseRef ?? existing?.defaultBaseRef ?? "main",
              localPath:
                input.localPath === undefined
                  ? (existing?.localPath ?? null)
                  : input.localPath,
            }),
          );
          const row = rows[0];
          if (row === undefined) {
            return yield* new SessionErrorClass({
              code: "storage",
              message: `repo ${input.repo} did not register`,
            });
          }
          return {
            repo: yield* toRepoSlug(row.slug),
            url: row.url,
            defaultBaseRef: row.defaultBaseRef,
            ...(row.localPath === null ? {} : { localPath: row.localPath }),
            registeredAt: row.registeredAt,
          };
        });

      /**
       * Open this process's owner of one session, or return the one already open.
       *
       * Opening means: resolve the workspace, create its directory, take the single-writer log, and
       * start the activity projection that keeps the list index current from the log.
       */
      const acquireOwner = (
        id: SessionId,
        row: SessionRow,
      ): Effect.Effect<LiveOwner, SessionError> =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const owners = yield* Ref.get(live);
            const existing = HashMap.get(owners, id);
            if (Option.isSome(existing)) {
              const touched = { ...existing.value, lastUsedAt: now };
              yield* Ref.update(live, HashMap.set(id, touched));
              return touched;
            }

            const workspace = yield* workspaceFor(row);
            yield* Effect.mapError(
              fs.makeDirectory(workspace.path, { recursive: true }),
              (cause) =>
                new SessionErrorClass({
                  code: "harness",
                  message: `create ${workspace.path}: ${String(cause)}`,
                }),
            );
            const storage = yield* openStorage(id, "owner");
            const opened = yield* openSession({
              storage,
              model: options.model,
              cwd: workspace.path,
            }).pipe(
              Effect.tapError(() => Effect.promise(() => storage.dispose())),
            );
            yield* FiberMap.run(
              projectors,
              id,
              liveSessionEvents(opened.root, refOf(id, row, workspace)).pipe(
                Stream.runForEach((event) => recordActivity(id, event)),
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `session ${id} activity projection stopped: ${String(cause)}`,
                  ),
                ),
              ),
            );
            const owner: LiveOwner = {
              harness: opened.harness,
              root: opened.root,
              storage,
              workspace,
              lastUsedAt: now,
            };
            yield* Ref.update(live, HashMap.set(id, owner));
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
            return yield* summarize(id, row, "historical", "idle");
          const busy = yield* isBusy(owner.value.harness, owner.value.root);
          yield* touch(id);
          return yield* summarize(id, row, "live", busy ? "busy" : "idle");
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

          const binding = yield* resolveBinding(input);
          const id = yield* mintSessionId;
          const title = (input.title ?? "").trim().slice(0, TITLE_MAX);
          const inserted = yield* paper(
            "create session",
            insertSession(id, title, input.requestId, binding),
          );
          const row = inserted[0] ?? {
            id,
            title,
            repo: binding.repo ?? null,
            baseRef: binding.baseRef ?? null,
            createdAt: "",
          };
          // The index row is written before the log because it carries the request-id dedupe key.
          // A failure between the two leaves a row whose log has no binding; `rebuildIndexes`
          // re-derives the truth from the log rather than trusting the row.
          const owner = yield* acquireOwner(id, row);
          if (title.length > 0) {
            // The log keeps the title too, so rebuilding the index does not lose it.
            yield* writeTitle(owner.root, title);
          }
          if (binding.repo !== undefined && binding.baseRef !== undefined) {
            // The log keeps the binding too, so the index and the workspace are derivable from it.
            yield* writeRepoBinding(owner.root, {
              repo: binding.repo,
              baseRef: binding.baseRef,
            });
          }
          // The session exists and its directory is open: the list can show it without a fold.
          yield* touchActivity(id);
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
              refOf(sessionId, row, owner.value.workspace),
            );
          }
          const workspace = yield* workspaceFor(row);
          return yield* withReader(sessionId, (storage) =>
            readHistoricalSnapshot(storage, refOf(sessionId, row, workspace)),
          );
        });

      const send = (
        input: SendMessageInput,
      ): Effect.Effect<SendMessageResult, SessionError> =>
        Effect.gen(function* () {
          if (input.content.length > MAX_MESSAGE_CHARS) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: `message is ${input.content.length} characters; the limit is ${MAX_MESSAGE_CHARS}`,
            });
          }

          const row = yield* requireSession(input.sessionId);
          const owner = yield* acquireOwner(input.sessionId, row);

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
          yield* touchActivity(input.sessionId);
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
          const owner = yield* acquireOwner(sessionId, row);
          yield* interruptConversation(owner.root);
          yield* touchActivity(sessionId);
          return yield* describe(sessionId, row);
        });

      const recordActivity = (
        sessionId: SessionId,
        event: SessionEvent,
      ): Effect.Effect<void> => {
        switch (event._tag) {
          case "status":
            return setActivityStatus(sessionId, event.status);
          case "usage":
            return setActivityCost(sessionId, costOf(event.usage));
          case "snapshot":
            return setActivityStatus(sessionId, event.session.status).pipe(
              Effect.andThen(touchActivity(sessionId)),
            );
          default:
            return touchActivity(sessionId);
        }
      };

      const touchActivity = (sessionId: SessionId): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* paper(
            "touch session activity",
            sql`
              INSERT INTO session_activity (session_id, last_activity_at)
              VALUES (${sessionId}, to_timestamp(${now / 1000}))
              ON CONFLICT (session_id) DO UPDATE
              SET last_activity_at = EXCLUDED.last_activity_at
            `,
          );
        }).pipe(Effect.ignore);

      const setActivityStatus = (
        sessionId: SessionId,
        status: SessionStatus,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* paper(
            "write session status",
            sql`
              INSERT INTO session_activity (session_id, status, last_activity_at)
              VALUES (${sessionId}, ${status}, to_timestamp(${now / 1000}))
              ON CONFLICT (session_id) DO UPDATE
              SET status = EXCLUDED.status, last_activity_at = EXCLUDED.last_activity_at
            `,
          );
        }).pipe(Effect.ignore);

      const setActivityCost = (
        sessionId: SessionId,
        costTotal: number,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* paper(
            "write session spend",
            sql`
              INSERT INTO session_activity (session_id, cost_total, last_activity_at)
              VALUES (${sessionId}, ${costTotal}, to_timestamp(${now / 1000}))
              ON CONFLICT (session_id) DO UPDATE
              SET cost_total = EXCLUDED.cost_total, last_activity_at = EXCLUDED.last_activity_at
            `,
          );
        }).pipe(Effect.ignore);

      const list = (
        input: ListSessionsInput,
      ): Effect.Effect<ListSessionsOutput, SessionError> =>
        Effect.gen(function* () {
          const limit = Math.min(
            Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1),
            MAX_PAGE_SIZE,
          );
          const cursor =
            input.cursor === undefined
              ? undefined
              : yield* parseCursor(input.cursor);
          // One statement, whatever the number of sessions: the keyset comparison is against a
          // parameter, not against a fold of anything (R6).
          const rows = yield* paper(
            "list sessions",
            sql<ListRow>`
              SELECT
                s.id,
                s.title,
                s.repo,
                s.base_ref,
                a.status,
                a.cost_total,
                to_char(a.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_activity_at,
                to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
              FROM session_activity a
              JOIN sessions s ON s.id = a.session_id
              WHERE (
                ${cursor?.at ?? null}::timestamptz IS NULL
                OR (a.last_activity_at, s.id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::text)
              )
              ORDER BY a.last_activity_at DESC, s.id DESC
              LIMIT ${limit + 1}
            `,
          );
          const page = rows.slice(0, limit);
          const last = page.at(-1);
          const nextCursor =
            rows.length > limit && last !== undefined
              ? `${last.lastActivityAt}|${last.id}`
              : undefined;
          const sessions: SessionListEntry[] = [];
          for (const row of page) {
            const repo =
              row.repo === null ? undefined : yield* toRepoSlug(row.repo);
            sessions.push({
              id: yield* toSessionId(row.id),
              title: row.title,
              status: row.status === "busy" ? "busy" : "idle",
              createdAt: row.createdAt,
              lastActivityAt: row.lastActivityAt,
              costTotal: row.costTotal,
              ...(repo === undefined ? {} : { repo }),
              ...(repo === undefined || row.baseRef === null
                ? {}
                : { baseRef: row.baseRef }),
            });
          }
          return {
            sessions,
            ...(nextCursor === undefined ? {} : { nextCursor }),
          };
        });

      const parseCursor = (
        raw: string,
      ): Effect.Effect<
        { readonly at: string; readonly id: SessionId },
        SessionError
      > =>
        Effect.gen(function* () {
          const separator = raw.indexOf("|");
          const at = separator === -1 ? "" : raw.slice(0, separator);
          const id = separator === -1 ? "" : raw.slice(separator + 1);
          if (at === "" || !Schema.is(SessionIdSchema)(id)) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: `"${raw}" is not a list cursor`,
            });
          }
          return { at, id };
        });

      const readSessionById = (sessionId: SessionId) =>
        sql<SessionRow>`
          SELECT
            id,
            title,
            repo,
            base_ref,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
          FROM sessions
          WHERE id = ${sessionId}
        `;

      const readSessionByRequest = (requestId: string) =>
        sql<SessionRow>`
          SELECT
            id,
            title,
            repo,
            base_ref,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
          FROM sessions
          WHERE request_id = ${requestId}
        `;

      const insertSession = (
        id: SessionId,
        title: string,
        requestId: string | undefined,
        binding: Binding,
      ) =>
        sql<SessionRow>`
          INSERT INTO sessions (id, title, request_id, repo, base_ref)
          VALUES (
            ${id},
            ${title},
            ${requestId ?? null},
            ${binding.repo ?? null},
            ${binding.baseRef ?? null}
          )
          RETURNING
            id,
            title,
            repo,
            base_ref,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
        `;

      const readRepo = (slug: string) =>
        sql<RepoRow>`
          SELECT
            slug,
            url,
            default_base_ref,
            local_path,
            to_char(registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at
          FROM repos
          WHERE slug = ${slug}
        `;

      const upsertRepo = (input: {
        readonly slug: string;
        readonly url: string;
        readonly defaultBaseRef: string;
        readonly localPath: string | null;
      }) =>
        sql<RepoRow>`
          INSERT INTO repos (slug, url, default_base_ref, local_path)
          VALUES (${input.slug}, ${input.url}, ${input.defaultBaseRef}, ${input.localPath})
          ON CONFLICT (slug) DO UPDATE SET
            url = EXCLUDED.url,
            default_base_ref = EXCLUDED.default_base_ref,
            local_path = EXCLUDED.local_path
          RETURNING
            slug,
            url,
            default_base_ref,
            local_path,
            to_char(registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at
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
              return liveSessionEvents(
                owner.value.root,
                refOf(sessionId, row, owner.value.workspace),
              );
            }
            // Nobody owns it: fold once, send the snapshot, and end the stream, so a client can
            // tell a completed fold from a dropped connection (D8).
            const workspace = yield* workspaceFor(row);
            const snapshot = yield* withReader(sessionId, (storage) =>
              readHistoricalSnapshot(storage, refOf(sessionId, row, workspace)),
            );
            return Stream.make(snapshotEvent(snapshot));
          }),
        );

      const releaseOwner = (
        sessionId: SessionId,
        owner: LiveOwner,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          // Interrupting the projection first: a released owner has no status to report.
          yield* FiberMap.remove(projectors, sessionId);
          yield* closeHarness(owner.harness).pipe(Effect.ignore);
          yield* Effect.promise(() => owner.storage.dispose());
          // Nobody owns the session now, so the list's honest status is idle (D8).
          yield* setActivityStatus(sessionId, "idle");
        });

      const closeAll = Effect.gen(function* () {
        const owners = yield* Ref.get(live);
        yield* Ref.set(live, HashMap.empty());
        yield* Effect.forEach(
          HashMap.toEntries(owners),
          ([sessionId, owner]) => releaseOwner(sessionId, owner),
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
          yield* Ref.update(live, HashMap.remove(sessionId));
          yield* releaseOwner(sessionId, owner);
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
        list,
        registerRepo,
        events,
        close: closeAll,
      });
    }),
  );
