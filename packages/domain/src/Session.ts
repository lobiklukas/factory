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

/** Ten characters of millisecond timestamp then sixteen of randomness, Crockford base32. */
export const SessionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^ses_[0-9abcdefghjkmnpqrstvwxyz]{26}$/)),
  Schema.brand("SessionId"),
);
export type SessionId = typeof SessionId.Type;

/** Whether these reads come from a harness running here, or from folding the log (D8). */
export const SessionMode = Schema.Literals(["live", "historical"]);
export type SessionMode = typeof SessionMode.Type;

export const SessionStatus = Schema.Literals(["idle", "busy"]);
export type SessionStatus = typeof SessionStatus.Type;

/** ISO 8601, UTC. */
export const Timestamp = Schema.String;
export type Timestamp = typeof Timestamp.Type;

export const SessionSummary = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  status: SessionStatus,
  mode: SessionMode,
  createdAt: Timestamp,
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

/** Spend, keyed the way Pi Durable keys it: `provider/modelId` for models, tool name for tools. */
export const SessionUsage = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({ key: Schema.String, usage: ModelUsage }),
  ),
  tools: Schema.Array(Schema.Struct({ key: Schema.String, usage: ModelUsage })),
});
export type SessionUsage = typeof SessionUsage.Type;

export const SessionSnapshotFields = {
  session: SessionSummary,
  entries: Schema.Array(TranscriptEntry),
  live: SessionLive,
  usage: SessionUsage,
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
 * one, D7) when the session is renamed.
 */
export const SessionEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", SessionSnapshotFields),
  Schema.TaggedStruct("entry", { entry: TranscriptEntry }),
  Schema.TaggedStruct("live", { live: SessionLive }),
  Schema.TaggedStruct("usage", { usage: SessionUsage }),
  Schema.TaggedStruct("status", { status: SessionStatus }),
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
});
export type CreateSessionInput = typeof CreateSessionInput.Type;

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
 * A session request that cannot be served. `code` is the part callers branch on.
 *
 * - `not_found` — no such session.
 * - `busy` — the session is running and the caller asked for `whenBusy: "reject"`.
 * - `storage` — the log could not be read or appended.
 * - `harness` — Pi Durable rejected the operation (bad input, closed harness, failed submit).
 */
export const SessionErrorCode = Schema.Literals([
  "not_found",
  "busy",
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
