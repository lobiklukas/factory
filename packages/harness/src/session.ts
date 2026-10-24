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
import type { JsonValue } from "@earendil-works/chord";
import type {
  Conversation,
  ConversationView,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
  Page,
  Storage,
  Submission,
} from "@earendil-works/pi-durable";
import {
  ConversationBusy,
  defineDoc,
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
  SessionUsage,
  SessionWorkspace,
  Timestamp,
  TranscriptEntry,
} from "@repo/domain/Session";
import type { ApprovalVerdict } from "@repo/domain/Approval";
import { SessionError as SessionErrorClass } from "@repo/domain/Session";
import type { ModelAccess } from "./models";
import {
  autonomyPolicy,
  DEFAULT_AUTONOMY,
  policyExtension,
  type SessionPolicy,
} from "./policy";
import {
  diffView,
  projectEntry,
  projectUsageDoc,
  projectView,
  SESSION_DOC_KIND,
  TASK_DOC_KIND,
  SPEC_DOC_KIND,
  CRITERIA_DOC_KIND,
  TITLE_ENTRY_KIND,
  APPROVAL_DECIDED_KIND,
  APPROVAL_REQUESTED_KIND,
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

/**
 * A session's repo binding, committed to the log so the index and the workspace are derivable
 * from it (D7, docs/features.md §3 A1). Empty strings mean "no repo", which is the scratch
 * session tests use, so the document is written once at create and never needs a tombstone.
 *
 * It is a document rather than an entry on purpose: it is session state, not transcript, and the
 * agent should not see it (Group D's `defineDoc`).
 */
export const SessionDoc = defineDoc({
  kind: SESSION_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ repo: "", baseRef: "" }),
});

/** A task's binding, committed to the log so a rebuild can recover it (LOB-60). */
export const TaskDoc = defineDoc({
  kind: TASK_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({}),
});

/** The repo a session is bound to, as the log records it. */
export type RepoBinding = {
  readonly repo: string;
  readonly baseRef: string;
};

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
  /**
   * What may run unattended here (D11, `./policy`). Absent: D11's defaults resolved for `cwd`, so a
   * session opened without a policy is still policed — an unpoliced session is not a default anyone
   * can reach by forgetting an argument.
   */
  readonly policy?: SessionPolicy;
};

export type OpenSession = {
  readonly harness: Harness;
  readonly root: Conversation;
};

/**
 * Credential-shaped variables the control plane holds in its own environment (LOB-51, D14).
 *
 * `NodeExecutionEnv` hands every tool command the whole process environment, so a token the server
 * reads at boot would reach the session's shell. A session never needs one: model calls happen in
 * the control plane, and anything that needs a forge token gets it from `CredentialProvider` per
 * call. Each such variable is set to the empty string for the session's commands, which overrides
 * the inherited value and leaves no token bytes in the environment.
 */
const CREDENTIAL_VARIABLE = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i;

export const sessionShellEnv = (
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> =>
  Object.fromEntries(
    Object.keys(env)
      .filter((name) => CREDENTIAL_VARIABLE.test(name))
      .map((name) => [name, ""]),
  );

/** Open a harness over one session's log and ensure its root conversation exists. */
export const openSession = (
  options: OpenSessionOptions,
): Effect.Effect<OpenSession, SessionError> =>
  Effect.gen(function* () {
    const registry = createRegistry();
    registry.install(CodingTools);
    // The policy is an extension beside the tools, not a wrapper around them (D15): Pi Durable
    // resolves the hooks of every selected extension before the tool task runs, so a refusal is a
    // task result the model reads, not an exception somewhere in the call path.
    registry.install(
      policyExtension(
        options.policy ?? autonomyPolicy(DEFAULT_AUTONOMY, options.cwd),
      ),
    );

    const harness = yield* attempt("open harness", () =>
      HarnessRuntime.open(
        options.storage,
        {
          models: options.model.models,
          registry,
          env: (target) =>
            new NodeExecutionEnv({
              cwd: target.cwd ?? options.cwd,
              shellEnv: sessionShellEnv(),
            }),
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

/**
 * An approval request, committed to the log the moment the session asks (D11). Like the title it
 * carries no model content, so the agent never sees it.
 */
export const ApprovalRequestedEntry = defineEntry<{
  readonly requestId: string;
  readonly action: string;
  readonly detail: string;
  readonly requestedAt: string;
}>(APPROVAL_REQUESTED_KIND);

/** The answer to one approval request, committed beside it. */
export const ApprovalDecidedEntry = defineEntry<{
  readonly requestId: string;
  readonly decision: ApprovalVerdict;
  readonly actor: string;
  readonly decidedAt: string;
}>(APPROVAL_DECIDED_KIND);

/** Commit an approval request. Appends to the log; the pending set is the caller's to update. */
export const writeApprovalRequested = (
  conversation: Conversation,
  data: {
    readonly requestId: string;
    readonly action: string;
    readonly detail: string;
    readonly requestedAt: string;
  },
): Effect.Effect<EntryId, SessionError> =>
  attempt("write approval request", () =>
    conversation
      .commit(
        (tx) =>
          tx.appendEntry(ApprovalRequestedEntry, conversation.id, { data }),
        BACKGROUND_CONTEXT,
      )
      .then((entry) => entry.id),
  );

/** Commit an approval decision. Appends to the log; the pending set is the caller's to update. */
export const writeApprovalDecided = (
  conversation: Conversation,
  data: {
    readonly requestId: string;
    readonly decision: ApprovalVerdict;
    readonly actor: string;
    readonly decidedAt: string;
  },
): Effect.Effect<EntryId, SessionError> =>
  attempt("write approval decision", () =>
    conversation
      .commit(
        (tx) => tx.appendEntry(ApprovalDecidedEntry, conversation.id, { data }),
        BACKGROUND_CONTEXT,
      )
      .then((entry) => entry.id),
  );

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

/**
 * Commit the repo binding. The log, not the `sessions` row, is what makes the binding survive a
 * dropped index; the caller updates the row as well so summaries need no fold (docs/features.md §3
 * A1).
 */
export const writeRepoBinding = (
  conversation: Conversation,
  binding: RepoBinding,
): Effect.Effect<void, SessionError> =>
  attempt("write repo binding", () =>
    conversation.commit(
      (tx) =>
        tx.doc(SessionDoc, conversation.id).then((doc) => {
          doc.repo = binding.repo;
          doc.baseRef = binding.baseRef;
        }),
      BACKGROUND_CONTEXT,
    ),
  );

export type TaskBinding = {
  readonly taskId: string;
  readonly column: string;
};

/** Commit the task binding. */
export const writeTaskBinding = (
  conversation: Conversation,
  binding: TaskBinding,
): Effect.Effect<void, SessionError> =>
  attempt("write task binding", () =>
    conversation.commit(
      (tx) =>
        tx.doc(TaskDoc, conversation.id).then((doc) => {
          (doc as { taskId?: string; column?: string }).taskId = binding.taskId;
          (doc as { taskId?: string; column?: string }).column = binding.column;
        }),
      BACKGROUND_CONTEXT,
    ),
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

/**
 * Start a new model context (LOB-181). Pi Durable appends a `pi.reset` entry that heads the next
 * context, carrying `handoff` as its user message when given; the entries before it stay in the
 * log, so the transcript keeps the past and marks where the reset happened.
 */
export const resetSession = (
  conversation: Conversation,
  handoff: string | undefined,
): Effect.Effect<void, SessionError> =>
  attempt("reset session", () =>
    conversation.reset(handoff, BACKGROUND_CONTEXT),
  );

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
 * The transcript: every entry the conversation ever committed, oldest first.
 *
 * It is read from the start of the log rather than from the newest head marker, because a head
 * marker (`pi.reset`, `pi.compaction`) says where the *model's* context begins, not where the
 * transcript does. A reset keeps the past and marks where it happened (LOB-181), and a fold that
 * started at the head would also drop the `factory.title` entry a rebuild reads the title from.
 * Both read paths use this, so a fold and a live attach still describe the same session.
 */
const scanEntries = (
  scan: (
    cursor: Cursor | undefined,
  ) => Effect.Effect<Page<EntryRecord, Cursor>, SessionError>,
): Effect.Effect<readonly EntryRecord[], SessionError> =>
  Effect.gen(function* () {
    const records: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = yield* scan(cursor);
      records.push(...page.items);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    // Storage scans newest first.
    return records.reverse();
  });

const readAllEntries = (
  storage: Storage,
): Effect.Effect<readonly EntryRecord[], SessionError> =>
  scanEntries((cursor) =>
    attempt("scan entries", () =>
      storage.scanEntries(
        { conversationId: ROOT_CONVERSATION_ID },
        ENTRY_PAGE,
        cursor,
        BACKGROUND_CONTEXT,
      ),
    ),
  );

/** The same transcript for a session this process owns, read through its conversation. */
const readConversationEntries = (
  conversation: Conversation,
): Effect.Effect<readonly EntryRecord[], SessionError> =>
  scanEntries((cursor) =>
    attempt("scan entries", () =>
      conversation.entries({}, ENTRY_PAGE, cursor, BACKGROUND_CONTEXT),
    ),
  );

export type SessionLog = {
  readonly entries: readonly TranscriptEntry[];
  readonly usage: SessionUsage;
  /** The repo binding the log records, empty when the session is a scratch one. */
  readonly binding: RepoBinding;
  /** The task binding the log records, when the session runs against a task. */
  readonly task?: { readonly taskId: string; readonly column: string };
  /** The job spec committed to the log, when present. */
  readonly spec?: string;
  /** The acceptance criteria committed to the log, when present. */
  readonly criteria?: string;
};

/** Read a string field from a document defensively: an unknown shape yields "". */
const bindingString = (value: JsonValue | undefined, key: string): string =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (() => {
        const field = (value as JsonRecord)[key];
        return typeof field === "string" ? field : "";
      })()
    : "";

/**
 * Read a session nobody owns by folding its log through a reader-mode `Storage`. No `Harness` is
 * opened: Pi Durable allows exactly one owner, and this is the read-only path D7 asks for — the
 * control plane must be able to read a session without owning it.
 */
export const readSessionLog = (
  storage: Storage,
): Effect.Effect<SessionLog, SessionError> =>
  Effect.gen(function* () {
    const records = yield* readAllEntries(storage);
    const usage = yield* readDocument(storage, USAGE_DOC);
    const binding = yield* readDocument(storage, SESSION_DOC_KIND);
    const taskDoc = yield* readDocument(storage, TASK_DOC_KIND);
    const specDoc = yield* readDocument(storage, SPEC_DOC_KIND);
    const criteriaDoc = yield* readDocument(storage, CRITERIA_DOC_KIND);
    const taskId = bindingString(taskDoc, "taskId");
    const spec = bindingString(specDoc, "spec");
    const criteria = bindingString(criteriaDoc, "criteria");
    return {
      entries: records.map(projectEntry),
      usage: projectUsageDoc(usage),
      binding: {
        repo: bindingString(binding, "repo"),
        baseRef: bindingString(binding, "baseRef"),
      },
      ...(spec === "" ? {} : { spec }),
      ...(criteria === "" ? {} : { criteria }),
      ...(taskId === ""
        ? {}
        : {
            task: {
              taskId,
              column: bindingString(taskDoc, "column") || "building",
            },
          }),
    };
  });

export type { Conversation, ConversationView, Harness, Storage };

/** What the control plane knows about a session outside its log. */
export type SessionRef = {
  readonly id: SessionId;
  readonly title: string;
  readonly createdAt: Timestamp;
  /** Where the session works, already resolved by the control plane (`@repo/domain/Session`). */
  readonly workspace: SessionWorkspace;
};

const snapshotOf = (
  view: ConversationView,
  ref: SessionRef,
  entries: readonly EntryRecord[],
): SessionSnapshot => {
  const projection = projectView(view, entries);
  return {
    session: {
      id: ref.id,
      title: ref.title,
      createdAt: ref.createdAt,
      mode: "live",
      status: projection.status,
      ...(ref.workspace.repo === undefined ? {} : { repo: ref.workspace.repo }),
      ...(ref.workspace.baseRef === undefined
        ? {}
        : { baseRef: ref.workspace.baseRef }),
    },
    workspace: ref.workspace,
    entries: projection.entries,
    live: projection.live,
    usage: projection.usage,
    queued: projection.queued,
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
    // The view holds the active window only; the transcript is the whole log. The scan is fallible,
    // so the handle is released whether it answers or not — a leaked mount keeps this session's
    // projections alive in the process for as long as the API runs.
    return yield* Effect.gen(function* () {
      const entries = yield* readConversationEntries(conversation);
      return snapshotOf(state.value, ref, entries);
    }).pipe(Effect.ensuring(Effect.sync(() => state.dispose())));
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

      // Registered before the fallible scan below, so a failed read releases the mount instead of
      // leaving this session's projections running in the process.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe?.();
          state.dispose();
        }),
      );

      // The transcript the snapshot below carries is the whole log, while the view the diffs come
      // from holds the active window: a `pi.reset` truncates the view. Entry ids already sent are
      // tracked here so an entry committed between the view read and the scan reaches the client
      // exactly once, whether it arrives in the snapshot or as an event.
      const entries = yield* readConversationEntries(conversation);
      const sent = new Set(entries.map((entry) => String(entry.id)));

      unsubscribe = state.subscribe((next) => {
        const events = diffView(previous, next, sent);
        previous = next;
        for (const event of events) Queue.offerUnsafe(queue, event);
      });

      // Offer the snapshot before subscribing has a chance to enqueue anything, so a client never
      // sees an event for a session it has not been told about.
      yield* Queue.offer(
        queue,
        snapshotEvent(snapshotOf(state.value, ref, entries)),
      );
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
        ...(ref.workspace.repo === undefined
          ? {}
          : { repo: ref.workspace.repo }),
        ...(ref.workspace.baseRef === undefined
          ? {}
          : { baseRef: ref.workspace.baseRef }),
      },
      workspace: ref.workspace,
      entries: log.entries,
      live: { busy: false, tools: [] },
      usage: log.usage,
      queued: [],
    };
  });

export { snapshotEvent };
