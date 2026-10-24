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
  ConversationId,
  ConversationView,
  Cursor,
  EntryDraft,
  EntryId,
  EntryRecord,
  Harness,
  Page,
  Storage,
  Submission,
  Tx,
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
  SessionTask,
  SessionUsage,
  SessionWorkspace,
  Timestamp,
  TranscriptEntry,
} from "@repo/domain/Session";
import type { ApprovalVerdict } from "@repo/domain/Approval";
import { SessionError as SessionErrorClass } from "@repo/domain/Session";
import { skillsExtension, type RunProfile } from "./loader";
import { compactionPolicyFor, type ModelAccess } from "./models";
// The typed document tokens (`factory.pr` among them) live in one module so the kind strings and
// the shapes they promise have a single writer and a single reader.
import { PrDoc } from "./docs";
import {
  autonomyPolicy,
  DEFAULT_AUTONOMY,
  policyExtension,
  type SessionPolicy,
} from "./policy";
import {
  diffView,
  projectEntry,
  projectPrDoc,
  projectTasks,
  projectUsageDoc,
  projectView,
  sameTasks,
  SESSION_DOC_KIND,
  TASK_DOC_KIND,
  SPEC_DOC_KIND,
  CRITERIA_DOC_KIND,
  PR_DOC_KIND,
  PR_OPENED_ENTRY_KIND,
  TITLE_ENTRY_KIND,
  APPROVAL_DECIDED_KIND,
  APPROVAL_REQUESTED_KIND,
  FORK_DOC_KIND,
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

/**
 * A forked session's lineage, committed to its own log (LOB-180).
 *
 * `parent` is the session it was forked from. `at` is the fork's *own* copy of the last entry it
 * took, which is where the fork point sits in this log; entry ids are minted per log, so the
 * parent's id for that entry would name a different entry here. Nothing reads `at` yet. The
 * `sessions` row carries the same parent as an index, so a summary never folds a log; this document
 * is what a rebuild recovers that parent from (D7).
 */
export const ForkDoc = defineDoc({
  kind: FORK_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ parent: "", at: "" }),
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
  /**
   * What the run's column gives it (B6, `./loader`): the skill bodies its prompt carries, resolved
   * by the control plane from the card's pinned board definition. Absent: no card, or a column that
   * names no skills, so nothing is injected.
   */
  readonly run?: RunProfile;
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
    // The column's skills, as prompt sections beside the tools (B6). Installed before the tools so
    // the whole code extension — tools and sections — renders after the run's own instructions.
    const skills = options.run?.skills ?? [];
    if (skills.length > 0) registry.install(skillsExtension(skills));
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
          settings: {
            progress: SESSION_PROGRESS,
            // Long sessions compact (B4). The thresholds follow the model's context window
            // (`compactionPolicyFor`), so a small-window model compacts where it can instead of
            // never, and a large one keeps pi-durable's pinned defaults.
            compaction: compactionPolicyFor(options.model.contextWindow),
          },
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

/** The PR a session opened, as the log records it. */
export type PullRequestRecord = {
  readonly url: string;
  readonly number: number;
  readonly base: string;
  readonly head: string;
  readonly openedAt: string;
};

/**
 * The PR a session opened, announced in the transcript so an attached client learns the link
 * (LOB-177). It carries no model content, so the agent never sees it.
 */
export const PrOpenedEntry = defineEntry<{
  readonly url: string;
  readonly number: number;
}>(PR_OPENED_ENTRY_KIND);

/**
 * Commit the PR a session opened. The log, not the `sessions` row, is what makes the link survive a
 * dropped index; the caller updates the row as well so a list needs no fold (LOB-177).
 *
 * One commit, two shapes of the same fact, because they answer different questions: the `factory.pr`
 * document is the record a retried step reads before it calls GitHub, and the entry is what an
 * attached client can see — Pi Durable mounts only its own documents in a conversation view, so a
 * document alone would open the PR silently for everyone already watching.
 */
export const writePullRequestDoc = (
  conversation: Conversation,
  pullRequest: PullRequestRecord,
): Effect.Effect<void, SessionError> =>
  attempt("write pull request", () =>
    conversation.commit(
      (tx) =>
        Promise.all([
          tx.doc(PrDoc, conversation.id).then((doc) => {
            doc.url = pullRequest.url;
            doc.number = pullRequest.number;
            doc.base = pullRequest.base;
            doc.head = pullRequest.head;
            doc.openedAt = pullRequest.openedAt;
          }),
          tx.appendEntry(PrOpenedEntry, conversation.id, {
            data: { url: pullRequest.url, number: pullRequest.number },
          }),
        ]),
      BACKGROUND_CONTEXT,
    ),
  );

/**
 * The PR this session already opened, read from the committed document — so a step that runs twice
 * reads the first run's answer instead of asking GitHub again. `undefined` when there is none.
 */
export const readPullRequestDoc = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<PullRequestRecord | undefined, SessionError> =>
  Effect.gen(function* () {
    const doc = yield* attempt("read pull request", () =>
      harness.snapshot(PrDoc, conversation.id, BACKGROUND_CONTEXT),
    );
    if (doc === undefined || doc.url === "") return undefined;
    return {
      url: doc.url,
      number: doc.number,
      base: doc.base,
      head: doc.head,
      openedAt: doc.openedAt,
    };
  });

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

/** Where a fork came from, as the fork's own log records it. */
export type ForkLineage = {
  readonly parent: string;
  /** The entry the fork was taken at, or `""` when the parent had no entries. */
  readonly at: string;
};

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
 * Compact the session on demand (B4): Pi Durable admits a compaction task that summarizes an old
 * prefix of the model context and places the summary as the new head marker, so the transcript
 * keeps every entry and the model's next request starts from the summary.
 *
 * The task id is the wire form of Pi Durable's branded id, like a submission's. Nothing to compact
 * — a context shorter than the policy keeps verbatim — completes the task without a summary, which
 * is the package's rule (range selection finds no cut), not a failure here.
 */
export const compactSession = (
  conversation: Conversation,
  instructions: string | undefined,
): Effect.Effect<string, SessionError> =>
  attempt("compact session", () =>
    conversation.compact(instructions, BACKGROUND_CONTEXT),
  ).pipe(Effect.map(String));

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

/**
 * The *active window*: the newest head marker, then the entries from its head. That is what Pi
 * Durable folds into a request, so it is the right slice for a question about the model's current
 * context — the prompt sections a run has in effect — and the wrong one for the transcript, which
 * is `readAllEntries`, because a `pi.reset` would truncate it.
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
    return yield* scanEntries((cursor) =>
      attempt("scan entries", () =>
        storage.scanEntries(
          marker === undefined
            ? { conversationId: ROOT_CONVERSATION_ID }
            : {
                conversationId: ROOT_CONVERSATION_ID,
                minEntryId: marker.head,
              },
          ENTRY_PAGE,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      ),
    );
  });

/**
 * The entries a fork of this log keeps: its whole transcript, oldest first, through `at`.
 *
 * The transcript is read from the beginning rather than from the newest head marker, because the
 * copy that follows reassigns entry ids and every head marker names an id: reading from the start
 * keeps every marker inside the copy, so a fork of a session that was reset keeps the same active
 * context it had. `at` absent means "the last entry", which is the fork `verify-api` drives; an id
 * that is not an entry of this log is refused as `invalid_input`, not silently rounded to the end.
 */
export const readForkSource = (
  storage: Storage,
  at: string | undefined,
): Effect.Effect<readonly EntryRecord[], SessionError> =>
  Effect.gen(function* () {
    const records: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = yield* attempt("scan entries", () =>
        storage.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID },
          ENTRY_PAGE,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      );
      records.push(...page.items);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    // Storage scans newest first; a transcript reads oldest first.
    records.reverse();
    if (at === undefined) return records;
    const end = records.findIndex((entry) => String(entry.id) === at);
    if (end === -1) {
      return yield* new SessionErrorClass({
        code: "invalid_input",
        message: `entry ${at} is not in this session`,
      });
    }
    return records.slice(0, end + 1);
  });

/** The draft for one copied entry, its head marker rewritten to the copy of the entry it names. */
const draftOf = (
  entry: EntryRecord,
  copied: ReadonlyMap<EntryId, EntryId>,
): EntryDraft => {
  // `"self"` is how the draft API says "the entry being written", which is what a reset's head
  // marker is in the parent.
  const head =
    entry.head === undefined
      ? undefined
      : entry.head === entry.id
        ? ("self" as const)
        : copied.get(entry.head);
  if (entry.head !== undefined && head === undefined) {
    throw new Error(
      `entry ${entry.id} starts its context at ${entry.head}, which is not an earlier entry`,
    );
  }
  return {
    kind: entry.kind,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.data === undefined ? {} : { data: entry.data }),
    ...(entry.edits === undefined ? {} : { edits: entry.edits }),
    ...(head === undefined ? {} : { head }),
  };
};

/** Where a fork came from, and the repo binding its parent had, in the fork's own commit. */
type ForkPreamble = {
  readonly parent: string;
  readonly binding?: RepoBinding;
};

/**
 * Copy a parent's entries into a fork's own log, oldest first, in the callers' one commit.
 *
 * Entry ids are minted per log, so every copy gets a new id and every head marker has to be
 * rewritten to the copy of the entry it named. Walking oldest first is what makes that possible:
 * a marker's entry has already been copied by the time the marker is written, and a marker that
 * names something later is a parent log whose entries do not precede their marker — a broken log
 * rather than a fork to guess at, so it fails the commit instead of writing a wrong transcript.
 *
 * The lineage and the repo binding are documents in the same commit, so a fork that exists at all
 * exists with both: there is no window in which a fork is readable but `rebuildIndexes` would fold
 * it without its parent. Documents are not entries, so the fork's transcript stays exactly the
 * parent's prefix.
 */
const copyEntries = (
  tx: Tx,
  conversationId: ConversationId,
  source: readonly EntryRecord[],
  preamble: ForkPreamble,
): Promise<ForkLineage> => {
  const copied = new Map<EntryId, EntryId>();
  let at = "";
  return source
    .reduce<Promise<void>>(
      (previous, entry) =>
        previous.then(() =>
          tx
            .appendEntry(conversationId, draftOf(entry, copied))
            .then((record) => {
              copied.set(entry.id, record.id);
              at = String(record.id);
            }),
        ),
      Promise.resolve(),
    )
    .then(() =>
      tx.doc(ForkDoc, conversationId).then((doc) => {
        doc.parent = preamble.parent;
        doc.at = at;
        return doc;
      }),
    )
    .then(() =>
      preamble.binding === undefined
        ? undefined
        : tx.doc(SessionDoc, conversationId).then((doc) => {
            doc.repo = preamble.binding?.repo ?? "";
            doc.baseRef = preamble.binding?.baseRef ?? "";
          }),
    )
    .then(() => ({ parent: preamble.parent, at }));
};

/** What a fork needs: the log to copy from, the log to write, and where to run. */
export type ForkSessionOptions = {
  /** The parent's log, opened in reader mode: a fork never takes ownership of the parent. */
  readonly parent: Storage;
  /** The fork's own log, opened in owner mode. */
  readonly child: Storage;
  /** The entry to fork at, or absent for the parent's last entry. */
  readonly at?: string;
  /** The session the fork is taken from, committed into the fork's log as its lineage. */
  readonly lineage: string;
  /** The parent's repo binding, committed into the fork's log beside the lineage. */
  readonly binding?: RepoBinding;
  readonly model: ModelAccess;
  readonly cwd: string;
  readonly policy?: SessionPolicy;
  /**
   * What the run's column gives the fork's prompt (B6). A fork carries no task binding, so this is
   * `EMPTY_RUN_PROFILE` in practice; it is a parameter so a fork opens exactly as any other session
   * does, rather than through a second, special-cased open path.
   */
  readonly run?: RunProfile;
};

export type ForkedSession = OpenSession & {
  /** The entry the fork was taken at, `""` when the parent had no entries. */
  readonly at: string;
};

/**
 * Open a new session whose transcript is another session's prefix (LOB-180, D7).
 *
 * A session *is* a log (D7), so a fork is another log with the parent's entries copied in: Pi
 * Durable's own `Conversation.fork` forks a conversation *inside* one storage, which would make
 * the fork unreadable as a session of its own. The copy is one commit on the new log, so a fork
 * either has the whole prefix or does not exist.
 */
export const forkSession = (
  options: ForkSessionOptions,
): Effect.Effect<ForkedSession, SessionError> =>
  Effect.gen(function* () {
    const source = yield* readForkSource(options.parent, options.at);
    const opened = yield* openSession({
      storage: options.child,
      model: options.model,
      cwd: options.cwd,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.run === undefined ? {} : { run: options.run }),
    });
    const lineage = yield* attempt(
      "copy the parent's entries",
      () =>
        opened.root.commit(
          (tx) =>
            copyEntries(tx, opened.root.id, source, {
              parent: options.lineage,
              ...(options.binding === undefined
                ? {}
                : { binding: options.binding }),
            }),
          BACKGROUND_CONTEXT,
        ),
      // A copy that fails leaves no fork, and an open harness on a child log nobody can read is a
      // lease the caller never releases: close it here, where the failure is.
    ).pipe(
      Effect.tapError(() => closeHarness(opened.harness).pipe(Effect.ignore)),
    );
    return { ...opened, at: lineage.at };
  });

export type SessionLog = {
  readonly entries: readonly TranscriptEntry[];
  readonly usage: SessionUsage;
  /** The repo binding the log records, empty when the session is a scratch one. */
  readonly binding: RepoBinding;
  /** The PR the log records, when the session opened one. */
  readonly pr?: PullRequestRecord;
  /** The task binding the log records, when the session runs against a task. */
  readonly task?: { readonly taskId: string; readonly column: string };
  /** The job spec committed to the log, when present. */
  readonly spec?: string;
  /** The acceptance criteria committed to the log, when present. */
  readonly criteria?: string;
  /** The session this log was forked from, when it was forked (LOB-180). */
  readonly forkedFrom?: string;
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
    const prDoc = projectPrDoc(yield* readDocument(storage, PR_DOC_KIND));
    const forkDoc = yield* readDocument(storage, FORK_DOC_KIND);
    const taskId = bindingString(taskDoc, "taskId");
    const spec = bindingString(specDoc, "spec");
    const criteria = bindingString(criteriaDoc, "criteria");
    const forkedFrom = bindingString(forkDoc, "parent");
    return {
      entries: records.map(projectEntry),
      usage: projectUsageDoc(usage),
      binding: {
        repo: bindingString(binding, "repo"),
        baseRef: bindingString(binding, "baseRef"),
      },
      ...(prDoc.url === ""
        ? {}
        : {
            pr: {
              url: prDoc.url,
              number: prDoc.number,
              base: prDoc.base,
              head: prDoc.head,
              openedAt: prDoc.openedAt,
            },
          }),
      ...(spec === "" ? {} : { spec }),
      ...(criteria === "" ? {} : { criteria }),
      ...(forkedFrom === "" ? {} : { forkedFrom }),
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

/** The Pi Durable entry kind that carries system prompt sections. */
const PROMPT_ENTRY_KIND = "pi.system";

export type PromptSections = Readonly<Record<string, string>>;

/**
 * The prompt sections a session's log leaves in effect, folded the way Pi Durable folds them: a
 * later `pi.system` entry replaces a section by name, and a `null` removes it.
 *
 * This is what the run was actually told, read from the log rather than from the extension that
 * built it, so a caller can show or measure the injected text (B6's "its size measurable") and a
 * test can assert on the prompt without intercepting a model request.
 */
export const readPromptSections = (
  storage: Storage,
): Effect.Effect<PromptSections, SessionError> =>
  Effect.gen(function* () {
    const records = yield* readActiveEntries(storage);
    const shown: Record<string, string> = {};
    for (const record of records) {
      if (record.kind !== PROMPT_ENTRY_KIND) continue;
      for (const message of record.model ?? []) {
        if (message.role !== "system") continue;
        for (const [key, value] of Object.entries(message.sections ?? {})) {
          if (value === null) delete shown[key];
          else shown[key] = value;
        }
      }
    }
    return shown;
  });

export type { Conversation, ConversationView, Harness, Storage };

/**
 * A session this process owns: the conversation its transcript lives in, and the harness whose
 * task graph says what is running there (LOB-183).
 *
 * Both are needed to answer "what is this session doing": entries and documents come from the
 * conversation view, and tasks are session-wide, so only the harness sees them.
 */
export type LiveSession = {
  readonly harness: Harness;
  readonly root: Conversation;
};

/** What the control plane knows about a session outside its log. */
export type SessionRef = {
  readonly id: SessionId;
  readonly title: string;
  readonly createdAt: Timestamp;
  /** Where the session works, already resolved by the control plane (`@repo/domain/Session`). */
  readonly workspace: SessionWorkspace;
  /** The PR the index remembers, so a read needs no fold to report it (LOB-177). */
  readonly prUrl?: string;
  /** The session this one was forked from, when the index row says so (LOB-180). */
  readonly forkedFrom?: SessionId;
};

const snapshotOf = (
  view: ConversationView,
  tasks: readonly SessionTask[],
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
      ...(ref.prUrl === undefined ? {} : { prUrl: ref.prUrl }),
      ...(ref.forkedFrom === undefined ? {} : { forkedFrom: ref.forkedFrom }),
    },
    workspace: ref.workspace,
    entries: projection.entries,
    live: projection.live,
    usage: projection.usage,
    queued: projection.queued,
    tasks,
  };
};

const snapshotEvent = (snapshot: SessionSnapshot): SessionEvent => ({
  _tag: "snapshot",
  ...snapshot,
});

/** A live session's current state, read without subscribing to anything. */
export const readLiveSnapshot = (
  session: LiveSession,
  ref: SessionRef,
): Effect.Effect<SessionSnapshot, SessionError> =>
  Effect.gen(function* () {
    const state = yield* attempt("read conversation view", () =>
      session.root.viewState(BACKGROUND_CONTEXT),
    );
    // The view holds the active window only; the transcript is the whole log. The scan is fallible,
    // so the handle is released whether it answers or not — a leaked mount keeps this session's
    // projections alive in the process for as long as the API runs. The task graph is a third mount
    // and is released the same way: it is session-wide, so only the harness can answer "what is
    // running here".
    return yield* Effect.gen(function* () {
      const graph = yield* attempt("read task graph", () =>
        session.harness.taskGraph(BACKGROUND_CONTEXT),
      );
      const tasks = yield* Effect.ensuring(
        Effect.succeed(projectTasks(graph.value)),
        Effect.sync(() => graph.dispose()),
      );
      const entries = yield* readConversationEntries(session.root);
      return snapshotOf(state.value, tasks, ref, entries);
    }).pipe(Effect.ensuring(Effect.sync(() => state.dispose())));
  });

/**
 * A live session's events: a snapshot of the committed view and the live-task list, then one event
 * per change for as long as the stream runs.
 *
 * Views are diffed rather than op streams are forwarded, so a subscriber that falls behind still
 * receives a correct picture: entries are appended, and a document compared by reference tells us
 * it changed. The task graph is diffed the same way, through its projection: a task that appears,
 * changes phase or settles publishes a graph revision, and a revision that projects the same list
 * is dropped so the panel is not woken for nothing.
 */
export const liveSessionEvents = (
  session: LiveSession,
  ref: SessionRef,
): Stream.Stream<SessionEvent, SessionError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const state = yield* attempt("read conversation view", () =>
        session.root.viewState(BACKGROUND_CONTEXT),
      );
      const graph = yield* attempt("read task graph", () =>
        session.harness.taskGraph(BACKGROUND_CONTEXT),
      );
      const queue = yield* Queue.unbounded<SessionEvent>();
      let previous = state.value;
      let previousTasks = projectTasks(graph.value);
      let unsubscribe: (() => void) | undefined;
      let unsubscribeTasks: (() => void) | undefined;

      // Registered before the fallible scan below, so a failed read releases the mount instead of
      // leaving this session's projections running in the process.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe?.();
          unsubscribeTasks?.();
          state.dispose();
          graph.dispose();
        }),
      );

      // The transcript the snapshot below carries is the whole log, while the view the diffs come
      // from holds the active window: a `pi.reset` truncates the view. Entry ids already sent are
      // tracked here so an entry committed between the view read and the scan reaches the client
      // exactly once, whether it arrives in the snapshot or as an event.
      const entries = yield* readConversationEntries(session.root);
      const sent = new Set(entries.map((entry) => String(entry.id)));

      unsubscribe = state.subscribe((next) => {
        const events = diffView(previous, next, sent);
        previous = next;
        for (const event of events) Queue.offerUnsafe(queue, event);
      });

      unsubscribeTasks = graph.subscribe((next) => {
        const tasks = projectTasks(next);
        if (sameTasks(previousTasks, tasks)) return;
        previousTasks = tasks;
        Queue.offerUnsafe(queue, { _tag: "tasks", tasks });
      });

      // Offer the snapshot before subscribing has a chance to enqueue anything, so a client never
      // sees an event for a session it has not been told about.
      yield* Queue.offer(
        queue,
        snapshotEvent(snapshotOf(state.value, previousTasks, ref, entries)),
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
        ...(ref.prUrl === undefined ? {} : { prUrl: ref.prUrl }),
        ...(ref.forkedFrom === undefined ? {} : { forkedFrom: ref.forkedFrom }),
      },
      workspace: ref.workspace,
      entries: log.entries,
      live: { busy: false, tools: [] },
      usage: log.usage,
      queued: [],
      // Nobody owns this log, so nothing runs in it: a sandbox that ran it is paused or gone (D8).
      tasks: [],
    };
  });

export { snapshotEvent };
