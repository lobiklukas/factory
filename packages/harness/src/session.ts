/**
 * Opening and reading one session's log.
 *
 * This is the only place in the control plane that touches Pi Durable's runtime, so its churn
 * (design R1) stops here: callers get a `Harness` to drive, or a projected snapshot to serve.
 *
 * Pi Durable is Promise-based, so every call into it is wrapped at this boundary; everything that
 * leaves this module is an Effect, like the rest of the repo.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationView,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
  Storage,
  Submission,
} from "@earendil-works/pi-durable";
import {
  ConversationBusy,
  defineEntry,
  Harness as HarnessRuntime,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Effect, Queue, Stream } from "effect";
import type {
  SessionError,
  SessionErrorCode,
  SessionEvent,
  SessionId,
  SessionSnapshot,
  Timestamp,
} from "@repo/domain/Session";
import { SessionError as SessionErrorClass } from "@repo/domain/Session";
import type { ModelAccess } from "./models";
import {
  diffView,
  projectEntry,
  projectUsageDoc,
  projectView,
  TITLE_ENTRY_KIND,
  USAGE_DOC,
  type JsonRecord,
} from "./projection";

/**
 * A session's title, committed to the log so a rebuild of the index can recover it (D7). It
 * carries no model content, so the agent never sees it.
 */
export const TitleEntry = defineEntry<{ readonly title: string }>(
  TITLE_ENTRY_KIND,
);

/** Storage is remote here, so partial answers commit less often than the 100 ms default. */
export const SESSION_PROGRESS = {
  partialIntervalMs: 250,
  outputIntervalMs: 250,
} as const;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Pi Durable rejects a submission to a busy conversation with `ConversationBusy`. */
const isBusyCause = (cause: unknown): boolean =>
  cause instanceof ConversationBusy ||
  (typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "ConversationBusy");

const sessionError = (
  what: string,
  cause: unknown,
  code: SessionErrorCode = "harness",
): SessionError =>
  new SessionErrorClass({ code, message: `${what}: ${describe(cause)}` });

/**
 * Cross the Promise boundary. Every Pi Durable failure becomes a `SessionError`.
 *
 * The Chord context is deliberately the never-cancelling one: cancelling a caller's Effect (a
 * client closing a stream, an HTTP request timing out) must not cancel the agent's work, which is
 * durable and belongs to the session, not to the request.
 */
export const attempt = <A>(
  what: string,
  operation: () => Promise<A>,
): Effect.Effect<A, SessionError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => sessionError(what, cause),
  });

export type OpenSessionOptions = {
  readonly storage: Storage;
  readonly model: ModelAccess;
  /** The session's working directory, which must exist. One per session, so sessions share no files. */
  readonly cwd: string;
};

export type OpenSession = {
  readonly harness: Harness;
  readonly root: Conversation;
};

/** Open a harness over one session's log and ensure its root conversation exists. */
export const openSession = (
  options: OpenSessionOptions,
): Effect.Effect<OpenSession, SessionError> =>
  Effect.gen(function* () {
    const registry = createRegistry();
    registry.install(CodingTools);

    const harness = yield* attempt("open harness", () =>
      HarnessRuntime.open(
        options.storage,
        {
          models: options.model.models,
          registry,
          env: (target) =>
            new NodeExecutionEnv({ cwd: target.cwd ?? options.cwd }),
          settings: { progress: SESSION_PROGRESS },
        },
        BACKGROUND_CONTEXT,
      ),
    );

    const root = yield* attempt("open root conversation", () =>
      harness.root(BACKGROUND_CONTEXT, {
        agent: {
          model: {
            provider: options.model.provider,
            modelId: options.model.modelId,
          },
          cwd: options.cwd,
        },
      }),
    );

    return { harness, root };
  });

/** Commit a title. Appends to the log; the `sessions` index is the caller's to update. */
export const writeTitle = (
  conversation: Conversation,
  title: string,
): Effect.Effect<EntryId, SessionError> =>
  attempt("write title", () =>
    conversation
      .commit(
        (tx) =>
          tx.appendEntry(TitleEntry, conversation.id, { data: { title } }),
        BACKGROUND_CONTEXT,
      )
      .then((entry) => entry.id),
  );

/** The message a caller sends a session, in the control plane's terms. */
export type MessageDraft = {
  readonly content: string;
  readonly requestId?: string;
  readonly whenBusy?: "steer" | "followUp" | "reject";
};

/**
 * A message Pi Durable has admitted. `submissionId` is the wire form of its id: Pi Durable's ids
 * are branded numbers today, and the API contract keeps them opaque strings.
 */
export type SubmittedMessage = {
  readonly submissionId: string;
  readonly submission: Submission;
  readonly queued: boolean;
};

export const submitMessage = (
  conversation: Conversation,
  draft: MessageDraft,
): Effect.Effect<SubmittedMessage, SessionError> =>
  Effect.gen(function* () {
    const submission = yield* Effect.tryPromise({
      try: () =>
        conversation.submit(
          {
            type: "input",
            content: draft.content,
            ...(draft.requestId === undefined
              ? {}
              : { requestId: draft.requestId }),
            ...(draft.whenBusy === undefined
              ? {}
              : { whenBusy: draft.whenBusy }),
          },
          BACKGROUND_CONTEXT,
        ),
      catch: (cause) =>
        sessionError(
          "submit message",
          cause,
          isBusyCause(cause) ? "busy" : "harness",
        ),
    });
    const record = yield* attempt("read submission", () =>
      submission.status(BACKGROUND_CONTEXT),
    );
    // A queued input waits in the conversation's inbox; a placed one is owned by a run (spec §6).
    return {
      submissionId: String(submission.id),
      submission,
      queued: record.status === "queued",
    };
  });

export const interrupt = (
  conversation: Conversation,
): Effect.Effect<void, SessionError> =>
  attempt("interrupt", () => conversation.abort(BACKGROUND_CONTEXT));

export const closeHarness = (harness: Harness): Effect.Effect<void> =>
  Effect.promise(() => harness.close(BACKGROUND_CONTEXT));

/**
 * Whether a run is in flight. Read from the committed `pi.live` document, so it is what the log
 * says, not what this process remembers.
 */
export const isBusy = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<boolean, SessionError> =>
  attempt("read live state", () =>
    harness
      .snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT)
      .then((live) => live?.run !== undefined),
  );

const readDocument = (
  storage: Storage,
  kind: string,
): Effect.Effect<JsonRecord | undefined, SessionError> =>
  Effect.gen(function* () {
    const address = {
      kind,
      scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
    } as const;
    const record = yield* attempt(`find ${kind}`, () =>
      storage.findDocument(address, "current", BACKGROUND_CONTEXT),
    );
    if (record === undefined) return undefined;
    const stored = yield* attempt(`read ${kind}`, () =>
      storage.document(record.id, "current", BACKGROUND_CONTEXT),
    );
    return stored?.value;
  });

/** Entries per storage round trip while folding a log. */
const ENTRY_PAGE = 500;

/**
 * The active transcript: the newest head marker, then the entries from its head. That is the same
 * slice `viewState()` shows, so a fold and a live attach describe the same session.
 */
const readActiveEntries = (
  storage: Storage,
): Effect.Effect<readonly EntryRecord[], SessionError> =>
  Effect.gen(function* () {
    const marker = yield* attempt("find head marker", () =>
      storage.findLatestHeadMarker(
        ROOT_CONVERSATION_ID,
        undefined,
        BACKGROUND_CONTEXT,
      ),
    );
    const query =
      marker === undefined
        ? { conversationId: ROOT_CONVERSATION_ID }
        : { conversationId: ROOT_CONVERSATION_ID, minEntryId: marker.head };

    const records: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = yield* attempt("scan entries", () =>
        storage.scanEntries(query, ENTRY_PAGE, cursor, BACKGROUND_CONTEXT),
      );
      records.push(...page.items);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    // Storage scans newest first.
    return records.reverse();
  });

export type SessionLog = {
  readonly entries: ReturnType<typeof projectEntry>[];
  readonly usage: ReturnType<typeof projectUsageDoc>;
};

/**
 * Read a session nobody owns by folding its log through a reader-mode `Storage`. No `Harness` is
 * opened: Pi Durable allows exactly one owner, and this is the read-only path D7 asks for — the
 * control plane must be able to read a session without owning it.
 */
export const readSessionLog = (
  storage: Storage,
): Effect.Effect<SessionLog, SessionError> =>
  Effect.gen(function* () {
    const records = yield* readActiveEntries(storage);
    const usage = yield* readDocument(storage, USAGE_DOC);
    return {
      entries: records.map(projectEntry),
      usage: projectUsageDoc(usage),
    };
  });

export type { Conversation, ConversationView, Harness, Storage };

/** What the control plane knows about a session outside its log. */
export type SessionRef = {
  readonly id: SessionId;
  readonly title: string;
  readonly createdAt: Timestamp;
};

const snapshotOf = (
  view: ConversationView,
  ref: SessionRef,
): SessionSnapshot => {
  const projection = projectView(view);
  return {
    session: {
      id: ref.id,
      title: ref.title,
      createdAt: ref.createdAt,
      mode: "live",
      status: projection.status,
    },
    entries: projection.entries,
    live: projection.live,
    usage: projection.usage,
  };
};

const snapshotEvent = (snapshot: SessionSnapshot): SessionEvent => ({
  _tag: "snapshot",
  ...snapshot,
});

/** A live session's current state, read without subscribing to anything. */
export const readLiveSnapshot = (
  conversation: Conversation,
  ref: SessionRef,
): Effect.Effect<SessionSnapshot, SessionError> =>
  Effect.gen(function* () {
    const state = yield* attempt("read conversation view", () =>
      conversation.viewState(BACKGROUND_CONTEXT),
    );
    const snapshot = snapshotOf(state.value, ref);
    state.dispose();
    return snapshot;
  });

/**
 * A live session's events: a snapshot of the committed view, then one event per change for as long
 * as the stream runs.
 *
 * Views are diffed rather than op streams are forwarded, so a subscriber that falls behind still
 * receives a correct picture: entries are appended, and a document compared by reference tells us
 * it changed.
 */
export const liveSessionEvents = (
  conversation: Conversation,
  ref: SessionRef,
): Stream.Stream<SessionEvent, SessionError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const state = yield* attempt("read conversation view", () =>
        conversation.viewState(BACKGROUND_CONTEXT),
      );
      const queue = yield* Queue.unbounded<SessionEvent>();
      let previous = state.value;
      let unsubscribe: (() => void) | undefined;

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe?.();
          state.dispose();
        }),
      );

      unsubscribe = state.subscribe((next) => {
        const events = diffView(previous, next);
        previous = next;
        for (const event of events) Queue.offerUnsafe(queue, event);
      });

      // Offer the snapshot before subscribing has a chance to enqueue anything, so a client never
      // sees an event for a session it has not been told about.
      yield* Queue.offer(queue, snapshotEvent(snapshotOf(state.value, ref)));
      return Stream.fromQueue(queue);
    }),
  );

/**
 * A session nobody owns: fold the log once through a reader-mode `Storage`.
 *
 * No `Harness` is opened, because Pi Durable allows exactly one owner, and this is the read-only
 * path D7 asks for — the control plane must be able to read a session without owning it.
 */
export const readHistoricalSnapshot = (
  storage: Storage,
  ref: SessionRef,
): Effect.Effect<SessionSnapshot, SessionError> =>
  Effect.gen(function* () {
    const log = yield* readSessionLog(storage);
    return {
      session: {
        id: ref.id,
        title: ref.title,
        createdAt: ref.createdAt,
        mode: "historical",
        // Nothing is running here by definition; the sandbox that ran it is paused or gone (D8).
        status: "idle",
      },
      entries: log.entries,
      live: { busy: false, tools: [] },
      usage: log.usage,
    };
  });

export { snapshotEvent };
