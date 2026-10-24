/**
 * Session contracts shared by the control plane, the CLI, and the dashboard.
 *
 * A session is one Pi Durable log (docs/design.md D7): `SessionId` *is* the `log_id`. The id is
 * minted by the server, never recycled, and safe in a URL or a git branch
 * (`factory/<session-id>`, D10). `title` is the human label and may change.
 *
 * Nothing here knows about Pi Durable. The projection from its records into these shapes lives
 * in `packages/harness`, so a change in that dependency (R1) stops at that boundary instead of
 * reaching the wire contract and the dashboard.
 */
import { Schema } from "effect";
import { ApprovalRequest } from "@repo/domain/Approval";
import { SessionId, Timestamp } from "@repo/domain/Ids";

// The two scalars every contract names. They are defined in `Ids` so `Approval` can name a session
// without importing this module, which imports it back for the snapshot's pending approvals; the
// re-export keeps `@repo/domain/Session` the place a caller imports them from.
export { SessionId, Timestamp } from "@repo/domain/Ids";

/** Whether these reads come from a harness running here, or from folding the log (D8). */
export const SessionMode = Schema.Literals(["live", "historical"]);
export type SessionMode = typeof SessionMode.Type;

export const SessionStatus = Schema.Literals(["idle", "busy"]);
export type SessionStatus = typeof SessionStatus.Type;

/**
 * A repository the factory knows about, as `owner/name` (D10's branch, D14's credential, and a
 * trigger all need a repo to name). Lowercase, because a git remote is case-insensitive on GitHub
 * and two spellings of one repo would be two registrations.
 */
export const RepoSlug = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/)),
  Schema.brand("RepoSlug"),
);
export type RepoSlug = typeof RepoSlug.Type;

/**
 * The commands a repo declares for itself, from `.factory/config` in the checkout
 * (docs/features.md §3 A1). Every field is optional: a repo with no config still opens a session,
 * it just cannot say how to build or test itself.
 */
export const RepoCommands = Schema.Struct({
  install: Schema.optional(Schema.String),
  build: Schema.optional(Schema.String),
  test: Schema.optional(Schema.String),
  verify: Schema.optional(Schema.String),
});
export type RepoCommands = typeof RepoCommands.Type;

/** One row of the repo registry: where a repo is cloned from and which ref sessions start at. */
export const RepoSummary = Schema.Struct({
  repo: RepoSlug,
  url: Schema.String,
  defaultBaseRef: Schema.String,
  /** A checkout on this machine to read `.factory/config` and the default ref from, if any. */
  localPath: Schema.optional(Schema.String),
  registeredAt: Timestamp,
});
export type RepoSummary = typeof RepoSummary.Type;

export const SessionSummary = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  status: SessionStatus,
  mode: SessionMode,
  createdAt: Timestamp,
  /** The repo this session works on, absent for a scratch session. */
  repo: Schema.optional(RepoSlug),
  baseRef: Schema.optional(Schema.String),
  /** The URL of the PR opened for this session, once one exists. */
  prUrl: Schema.optional(Schema.String),
  /** The session this one was forked from, once one was (LOB-180). */
  forkedFrom: Schema.optional(SessionId),
});
export type SessionSummary = typeof SessionSummary.Type;

/** One tool call on an assistant entry, as the transcript shows it. */
export const ToolCallRef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type ToolCallRef = typeof ToolCallRef.Type;

/**
 * One transcript entry, projected from a Pi Durable `EntryRecord` (`packages/harness` maps the
 * kinds). `text` is the model-facing text, flattened; `toolName` is set on tool results.
 */
export const TranscriptEntryKind = Schema.Literals([
  "user",
  "assistant",
  "toolResult",
  "system",
  "reset",
  "compaction",
  "title",
  "other",
]);
export type TranscriptEntryKind = typeof TranscriptEntryKind.Type;

export const TranscriptEntry = Schema.Struct({
  id: Schema.String,
  kind: TranscriptEntryKind,
  text: Schema.String,
  toolCalls: Schema.Array(ToolCallRef),
  toolName: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
});
export type TranscriptEntry = typeof TranscriptEntry.Type;

/** A queued submission waiting in `pi.inbox` for a boundary. */
export const QueuedMessage = Schema.Struct({
  id: Schema.String,
  mode: Schema.Literals(["steer", "followUp", "write"]),
  content: Schema.optional(Schema.Unknown),
});
export type QueuedMessage = typeof QueuedMessage.Type;

/** A tool of the round the current generation is running. */
export const ToolSlotView = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["pending", "running", "done"]),
  output: Schema.optional(Schema.String),
});
export type ToolSlotView = typeof ToolSlotView.Type;

/**
 * What is happening right now. `busy` is the same signal as `SessionStatus`, and `partial` is the
 * in-flight answer as Pi Durable last committed it — the whole reason the UI attaches instead of
 * polling the fold (D8).
 */
export const SessionLive = Schema.Struct({
  busy: Schema.Boolean,
  partial: Schema.optional(Schema.String),
  tools: Schema.Array(ToolSlotView),
});
export type SessionLive = typeof SessionLive.Type;

export const ModelUsage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  totalTokens: Schema.Finite,
  costTotal: Schema.Finite,
});
export type ModelUsage = typeof ModelUsage.Type;

/**
 * One live task in a session: what is running right now, in which phase, on whose behalf, and what
 * it waits for. Mirrors Pi Durable's `TaskGraph` node (LOB-183).
 *
 * Only live tasks appear — `pending`, `running`, `waiting` and `completing`. A settled task is gone
 * from the list rather than carried as a fourth kind of history, because the durable record is the
 * log and this is the "what is happening now" projection.
 *
 * `phase` is absent for `completing`: a task that has decided its outcome runs no more phases. `id`
 * and `owner` are strings because a Pi Durable id is a number that clients should not do arithmetic
 * on; `waitingOn` names the live task ids a `waiting` task joins.
 */
export const SessionTask = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  status: Schema.Literals(["pending", "running", "waiting", "completing"]),
  phase: Schema.optional(Schema.String),
  waitingOn: Schema.Array(Schema.String),
  owner: Schema.optional(Schema.String),
  conversations: Schema.Array(Schema.String),
});
export type SessionTask = typeof SessionTask.Type;

/** Spend, keyed the way Pi Durable keys it: `provider/modelId` for models, tool name for tools. */
export const SessionUsage = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({ key: Schema.String, usage: ModelUsage }),
  ),
});
export type SessionUsage = typeof SessionUsage.Type;

/**
 * Where a session's work actually lives, as the server resolved it (docs/features.md §3 A1).
 *
 * `path` is the session's working directory — one per session, so sessions never share files — and
 * under a repo it is scoped by that repo. `commands` is what the repo declares about itself, and
 * `commandsSource` says whether that came from a `.factory/config` the server could read or from
 * nothing at all: a repo with no config is a fact the caller can see, not an empty answer.
 */
export const SessionWorkspace = Schema.Struct({
  path: Schema.String,
  repo: Schema.optional(RepoSlug),
  baseRef: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  commands: RepoCommands,
  commandsSource: Schema.Literals(["repo", "none"]),
});
export type SessionWorkspace = typeof SessionWorkspace.Type;

export const SessionSnapshotFields = {
  session: SessionSummary,
  workspace: SessionWorkspace,
  entries: Schema.Array(TranscriptEntry),
  live: SessionLive,
  usage: SessionUsage,
  queued: Schema.Array(QueuedMessage),
  tasks: Schema.Array(SessionTask),
  /**
   * The approvals still waiting for a decision, oldest first (LOB-147). Folded from the log, so a
   * snapshot read after its owner was released still reports them; a settled approval is not here.
   */
  approvals: Schema.Array(ApprovalRequest),
} as const;

export const SessionSnapshot = Schema.Struct(SessionSnapshotFields);
export type SessionSnapshot = typeof SessionSnapshot.Type;

/**
 * What a session stream carries, in order and without gaps.
 *
 * `snapshot` is always first, and for a historical session it is the only event: the stream then
 * ends, so a client can tell a completed fold from a dropped connection. Entries are append-only
 * (Pi Durable commits the in-flight answer into `pi.live`, not into the transcript), so an
 * `entry` event is never an update to an entry already sent.
 *
 * The snapshot's `session` is the summary at attachment. Later changes to it arrive as events of
 * their own: `status` when the run starts or stops, and a `title` entry (the control plane commits
 * one, D7) when the session is renamed. `tasks` is the live-task list, sent when Pi Durable's task
 * graph changes — on a commit, not on a poll — so a panel of live work settles with the work.
 */
export const SessionEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", SessionSnapshotFields),
  Schema.TaggedStruct("entry", { entry: TranscriptEntry }),
  Schema.TaggedStruct("live", { live: SessionLive }),
  Schema.TaggedStruct("usage", { usage: SessionUsage }),
  Schema.TaggedStruct("status", { status: SessionStatus }),
  Schema.TaggedStruct("queued", { queued: Schema.Array(QueuedMessage) }),
  Schema.TaggedStruct("tasks", { tasks: Schema.Array(SessionTask) }),
  Schema.TaggedStruct("prOpened", { prUrl: Schema.String }),
]);
export type SessionEvent = typeof SessionEvent.Type;

/** How a message behaves when the session is already running. Mirrors Pi Durable's `whenBusy`. */
export const WhenBusy = Schema.Literals(["steer", "followUp", "reject"]);
export type WhenBusy = typeof WhenBusy.Type;

/**
 * What happened to a sent message: `run` when it started one, otherwise the queue it joined
 * (`steer` joins the running work after the current tool round, `followUp` starts the next run).
 */
export const MessagePlacement = Schema.Literals(["run", "steer", "followUp"]);
export type MessagePlacement = typeof MessagePlacement.Type;

export const SendMessageResult = Schema.Struct({
  session: SessionSummary,
  submissionId: Schema.String,
  placement: MessagePlacement,
});
export type SendMessageResult = typeof SendMessageResult.Type;

export const CreateSessionInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  /** Deduplicates a retried create: the same request id returns the same session. */
  requestId: Schema.optional(Schema.String),
  /** The repo the session works on. Absent means a scratch session, which is what tests use. */
  repo: Schema.optional(RepoSlug),
  /** The ref the session starts from. Defaults to the repo registry's default base ref. */
  baseRef: Schema.optional(Schema.String),
  /** The task this session runs against. Absent means a scratch session. */
  taskId: Schema.optional(Schema.String),
  /** The column the run was started from. Defaults to "building". */
  taskColumn: Schema.optional(Schema.String),
});
export type CreateSessionInput = typeof CreateSessionInput.Type;

/**
 * Register or update a repo so sessions can bind to it. A session that names an unregistered repo
 * still opens: `createSession` registers it with no clone URL, and this is how the URL and the
 * local checkout arrive (a trigger, later, is the other writer — D14 needs the URL to clone).
 */
export const RegisterRepoInput = Schema.Struct({
  repo: RepoSlug,
  url: Schema.optional(Schema.String),
  defaultBaseRef: Schema.optional(Schema.String),
  localPath: Schema.optional(Schema.String),
});
export type RegisterRepoInput = typeof RegisterRepoInput.Type;

/** One row of `listSessions`: what the index remembers without folding a single log (R6). */
export const SessionListEntry = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  repo: Schema.optional(RepoSlug),
  baseRef: Schema.optional(Schema.String),
  status: SessionStatus,
  createdAt: Timestamp,
  lastActivityAt: Timestamp,
  costTotal: Schema.Finite,
  /** The URL of the PR opened for this session, once one exists. */
  prUrl: Schema.optional(Schema.String),
  /**
   * The session this one was forked from, once one was (LOB-180/LOB-182). Read from the index row,
   * which `rebuildIndexes` refolds from the fork's own `factory.fork` document, so the list can show
   * lineage without folding a log (R6).
   */
  forkedFrom: Schema.optional(SessionId),
});
export type SessionListEntry = typeof SessionListEntry.Type;

export const ListSessionsInput = Schema.Struct({
  /** Page size. The server clamps it. */
  limit: Schema.optional(Schema.Int),
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor: Schema.optional(Schema.String),
});
export type ListSessionsInput = typeof ListSessionsInput.Type;

export const ListSessionsOutput = Schema.Struct({
  /** Newest activity first. */
  sessions: Schema.Array(SessionListEntry),
  nextCursor: Schema.optional(Schema.String),
});
export type ListSessionsOutput = typeof ListSessionsOutput.Type;

export const SendMessageInput = Schema.Struct({
  sessionId: SessionId,
  content: Schema.String,
  whenBusy: Schema.optional(WhenBusy),
  /** Deduplicates a retried send: the same request id admits one submission. */
  requestId: Schema.optional(Schema.String),
});
export type SendMessageInput = typeof SendMessageInput.Type;

export const SessionIdInput = Schema.Struct({ sessionId: SessionId });
export type SessionIdInput = typeof SessionIdInput.Type;

/**
 * Fork a session at one of its entries (LOB-180, D7).
 *
 * `at` is the id of a transcript entry — the `id` a `TranscriptEntry` carries — and the fork keeps
 * the parent's entries through it. Absent, the fork is taken at the parent's last entry.
 *
 * An id that names no entry of *this* session is refused as `invalid_input`: no such history exists
 * to fork. Entry ids are minted per log, so an id read out of another session is indistinguishable
 * from this session's entry of the same number when both exist — the fork then takes this session's
 * entry, which is the only thing that number can mean here. Making an entry id unique across
 * sessions is a change to every client's view of a transcript, not something a fork can decide.
 */
export const ForkSessionInput = Schema.Struct({
  sessionId: SessionId,
  at: Schema.optional(Schema.String),
});
export type ForkSessionInput = typeof ForkSessionInput.Type;

/**
 * Start a new model context for a session (LOB-181).
 *
 * `handoff` is what the fresh context opens with, as its first user message; absent or empty means
 * the context starts from nothing. The transcript keeps everything before the reset and marks where
 * it happened, so a handoff note is a summary the reader can check against the turns above it.
 */
export const ResetSessionInput = Schema.Struct({
  sessionId: SessionId,
  handoff: Schema.optional(Schema.String),
});
export type ResetSessionInput = typeof ResetSessionInput.Type;

/**
 * Compact a session's model context on demand (B4).
 *
 * `instructions` is what the summarizer should focus on, when the caller has a reason to steer it.
 * The compaction is a task in the log: this call admits it and answers the task's id, and the
 * summary arrives as a `compaction` entry when the task settles, so a caller watches the
 * transcript rather than waiting on this call. Nothing is dropped: entries before the summary
 * stay in the transcript, which is what makes the summary checkable.
 */
export const CompactSessionInput = Schema.Struct({
  sessionId: SessionId,
  instructions: Schema.optional(Schema.String),
});
export type CompactSessionInput = typeof CompactSessionInput.Type;

/** The admitted compaction task, and the session it belongs to. */
export const CompactSessionResult = Schema.Struct({
  session: SessionSummary,
  /** Opaque, like a submission id; the log's own numbering is not the wire contract. */
  taskId: Schema.String,
});
export type CompactSessionResult = typeof CompactSessionResult.Type;

/**
 * A session request that cannot be served. `code` is the part callers branch on.
 *
 * - `not_found` — no such session.
 * - `busy` — the session is running and the caller asked for `whenBusy: "reject"`.
 * - `invalid_input` — the request was well-formed but refused: a message over the length cap, a
 *   malformed repo slug, an unreadable list cursor.
 * - `storage` — the log could not be read or appended.
 * - `harness` — Pi Durable rejected the operation (bad input, closed harness, failed submit).
 */
export const SessionErrorCode = Schema.Literals([
  "not_found",
  "busy",
  "invalid_input",
  "storage",
  "harness",
]);
export type SessionErrorCode = typeof SessionErrorCode.Type;

export class SessionError extends Schema.TaggedError<SessionError>()(
  "SessionError",
  {
    code: SessionErrorCode,
    message: Schema.String,
  },
) {}
