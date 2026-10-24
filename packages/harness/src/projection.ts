/**
 * The projection: Pi Durable's committed records and documents into the session contracts the
 * API and the dashboard speak (`packages/domain/Session`).
 *
 * Entries are typed by Pi Durable, so they are read directly. Documents arrive as JSON
 * (`ConversationView.docs`), so they are read defensively: an unknown or renamed field drops out
 * of the projection instead of breaking it, which is the point of having a projection at all.
 */
import type {
  ConversationView,
  EntryRecord,
  TaskGraph,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type {
  ModelUsage,
  QueuedMessage,
  SessionEvent,
  SessionLive,
  SessionStatus,
  SessionUsage,
  SessionTask,
  ToolCallRef,
  ToolSlotView,
  TranscriptEntry,
  TranscriptEntryKind,
} from "@repo/domain/Session";
import type { ApprovalVerdict } from "@repo/domain/Approval";

/** The conversation documents this projection reads, and the entry kind this package writes. */
export const LIVE_DOC = "pi.live";
export const USAGE_DOC = "pi.usage";
export const INBOX_DOC = "pi.inbox";
export const SESSION_DOC_KIND = "factory.session";
export const TASK_DOC_KIND = "factory.task";
export const SPEC_DOC_KIND = "factory.spec";
export const CRITERIA_DOC_KIND = "factory.criteria";
export const PR_DOC_KIND = "factory.pr";
export const RETRY_DOC_KIND = "factory.retry";
/** The lineage a forked session's log records (LOB-180): its parent and the entry it was taken at. */
export const FORK_DOC_KIND = "factory.fork";
export const TITLE_ENTRY_KIND = "factory.title";
/**
 * The entry a session's PR is announced with (LOB-177). It carries the link, and it exists because
 * Pi Durable's conversation view mounts only its own built-in documents: a `PrDoc` commit is not
 * visible to an attached client, so the record and the announcement are two writes in one commit.
 */
export const PR_OPENED_ENTRY_KIND = "factory.pr.opened";
export const APPROVAL_REQUESTED_KIND = "factory.approval.requested";
export const APPROVAL_DECIDED_KIND = "factory.approval.decided";
/**
 * One approval as a log records it (D11, LOB-147): the request, and the decision that settled it.
 *
 * The session id is not here, because a log *is* one session: the caller that needs it has it, and
 * carrying it would let a fold fabricate an id its log never named.
 */
export type ApprovalLogRecord = {
  readonly requestId: string;
  readonly action: string;
  readonly detail: string;
  readonly requestedAt: string;
  readonly decision?: {
    readonly decision: ApprovalVerdict;
    readonly actor: string;
    readonly decidedAt: string;
  };
};

/** The verdict in a decision entry, or `undefined` for anything that is not one. */
const verdictAt = (
  value: JsonValue | undefined,
): ApprovalVerdict | undefined => {
  const verdict = stringAt(value, "decision");
  return verdict === "approved" || verdict === "denied" ? verdict : undefined;
};

/**
 * `factory.approval.requested` and `factory.approval.decided` → one record per request id.
 *
 * Folded rather than accumulated, so two folds of one log agree: a repeated request id (a retried
 * request whose first commit landed, or a log that recorded the same request twice) is one record,
 * the first request winning, and a decision settles the request it names. A decision whose request
 * is not in the log settles nothing, and is dropped rather than invented into a request.
 *
 * Order is the pending list's order — `requestedAt`, then `requestId` for two asks in one
 * millisecond — because both the snapshot fold and the index's list answer from it.
 */
export const projectApprovals = (
  entries: readonly EntryRecord[],
): readonly ApprovalLogRecord[] => {
  const records = new Map<string, ApprovalLogRecord>();
  for (const entry of entries) {
    const requestId = stringAt(entry.data, "requestId");
    if (requestId === undefined) continue;
    if (entry.kind === APPROVAL_REQUESTED_KIND) {
      if (records.has(requestId)) continue;
      const action = stringAt(entry.data, "action");
      const requestedAt = stringAt(entry.data, "requestedAt");
      if (action === undefined || requestedAt === undefined) continue;
      records.set(requestId, {
        requestId,
        action,
        detail: stringAt(entry.data, "detail") ?? "",
        requestedAt,
      });
      continue;
    }
    if (entry.kind !== APPROVAL_DECIDED_KIND) continue;
    const record = records.get(requestId);
    if (record === undefined || record.decision !== undefined) continue;
    const decision = verdictAt(entry.data);
    const actor = stringAt(entry.data, "actor");
    const decidedAt = stringAt(entry.data, "decidedAt");
    if (
      decision === undefined ||
      actor === undefined ||
      decidedAt === undefined
    )
      continue;
    records.set(requestId, {
      ...record,
      decision: { decision, actor, decidedAt },
    });
  }
  return [...records.values()].sort((left, right) =>
    left.requestedAt === right.requestedAt
      ? left.requestId.localeCompare(right.requestId)
      : left.requestedAt.localeCompare(right.requestedAt),
  );
};

/** The requests still waiting for a decision, in the same order as the fold. */
export const pendingApprovals = (
  records: readonly ApprovalLogRecord[],
): readonly ApprovalLogRecord[] =>
  records.filter((record) => record.decision === undefined);

type ContentBlock = TextContent | ThinkingContent | ToolCall | ImageContent;

/** A JSON object with no shape promise: documents are read field by field, defensively. */
export type JsonRecord = { readonly [key: string]: JsonValue };

const asObject = (value: JsonValue | undefined): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;

const objectAt = (
  parent: JsonValue | undefined,
  key: string,
): JsonRecord | undefined => asObject(asObject(parent)?.[key]);

const stringAt = (
  parent: JsonValue | undefined,
  key: string,
): string | undefined => {
  const value = asObject(parent)?.[key];
  return typeof value === "string" ? value : undefined;
};

const numberAt = (parent: JsonValue | undefined, key: string): number => {
  const value = asObject(parent)?.[key];
  return typeof value === "number" ? value : 0;
};

const arrayAt = (
  parent: JsonValue | undefined,
  key: string,
): readonly JsonValue[] => {
  const value = asObject(parent)?.[key];
  return Array.isArray(value) ? value : [];
};

/** Flatten model content blocks to their text. */
const blocksText = (blocks: readonly ContentBlock[]): string =>
  blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

const messageText = (message: Message | undefined): string => {
  if (message === undefined) return "";
  switch (message.role) {
    case "user":
      return typeof message.content === "string"
        ? message.content
        : blocksText(message.content);
    case "assistant":
    case "toolResult":
      return blocksText(message.content);
    default:
      return "";
  }
};

const toolCallRefs = (message: Message | undefined): readonly ToolCallRef[] =>
  message?.role === "assistant"
    ? message.content.flatMap((block) =>
        block.type === "toolCall" ? [{ id: block.id, name: block.name }] : [],
      )
    : [];

/** Pi Durable entry kinds, ours, and everything else. */
const entryKind = (kind: string): TranscriptEntryKind => {
  switch (kind) {
    case "pi.user":
      return "user";
    case "pi.assistant":
      return "assistant";
    case "pi.tool-result":
      return "toolResult";
    case "pi.system":
      return "system";
    case "pi.reset":
      return "reset";
    case "pi.compaction":
      return "compaction";
    case TITLE_ENTRY_KIND:
      return "title";
    default:
      return "other";
  }
};

export const projectEntry = (entry: EntryRecord): TranscriptEntry => {
  const message = entry.model?.[0];
  const toolName =
    message?.role === "toolResult" ? message.toolName : undefined;
  const isError = message?.role === "toolResult" ? message.isError : undefined;
  // The title entry carries no model content, so its text comes from its data.
  const text =
    entry.kind === TITLE_ENTRY_KIND
      ? (stringAt(asObject(entry.data), "title") ?? "")
      : messageText(message);
  return {
    id: String(entry.id),
    kind: entryKind(entry.kind),
    text,
    toolCalls: toolCallRefs(message),
    ...(toolName === undefined ? {} : { toolName }),
    ...(isError === undefined ? {} : { isError }),
  };
};

const projectToolSlot = (value: JsonValue): ToolSlotView | undefined => {
  const slot = asObject(value);
  const callId = stringAt(slot, "callId");
  const name = stringAt(slot, "name");
  const status = stringAt(slot, "status");
  if (callId === undefined || name === undefined) return undefined;
  if (status !== "pending" && status !== "running" && status !== "done")
    return undefined;
  const output = stringAt(slot, "output");
  return { callId, name, status, ...(output === undefined ? {} : { output }) };
};

/** The in-flight generation's committed partial, flattened. */
const partialText = (live: JsonValue | undefined): string | undefined => {
  const message = objectAt(objectAt(live, "generation"), "message");
  if (message === undefined) return undefined;
  return arrayAt(message, "content")
    .flatMap((block) => {
      const content = asObject(block);
      if (stringAt(content, "type") !== "text") return [];
      return [stringAt(content, "text") ?? ""];
    })
    .join("");
};

/** `pi.live` → what the UI shows as happening now. */
export const projectLive = (
  docs: Readonly<Record<string, JsonValue>>,
): SessionLive => {
  const live = docs[LIVE_DOC];
  const partial = partialText(live);
  return {
    busy: objectAt(live, "run") !== undefined,
    ...(partial === undefined ? {} : { partial }),
    tools: arrayAt(live, "tools").flatMap((slot) => {
      const projected = projectToolSlot(slot);
      return projected === undefined ? [] : [projected];
    }),
  };
};

/**
 * The PR `factory.pr` records: the link, its number, and where it came from. An unwritten document
 * and a document with no URL project the same way, because `initial()` is a document with no URL —
 * there is no PR until the URL is there, so "is there one" is `url !== ""` rather than a flag.
 */
export type PrDocView = {
  readonly url: string;
  readonly number: number;
  readonly base: string;
  readonly head: string;
  readonly openedAt: string;
};

export const projectPrDoc = (value: JsonValue | undefined): PrDocView => ({
  url: stringAt(value, "url") ?? "",
  number: numberAt(value, "number"),
  base: stringAt(value, "base") ?? "",
  head: stringAt(value, "head") ?? "",
  openedAt: stringAt(value, "openedAt") ?? "",
});

const ZERO_USAGE: ModelUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  costTotal: 0,
};

const readModelUsage = (value: JsonValue): ModelUsage => {
  const usage = asObject(value);
  if (usage === undefined) return ZERO_USAGE;
  return {
    input: numberAt(usage, "input"),
    output: numberAt(usage, "output"),
    cacheRead: numberAt(usage, "cacheRead"),
    cacheWrite: numberAt(usage, "cacheWrite"),
    totalTokens: numberAt(usage, "totalTokens"),
    costTotal: numberAt(objectAt(usage, "cost"), "total"),
  };
};

const bucketEntries = (
  bucket: JsonRecord | undefined,
): readonly { readonly key: string; readonly usage: ModelUsage }[] =>
  Object.entries(bucket ?? {}).map(([key, value]) => ({
    key,
    usage: readModelUsage(value),
  }));

export const projectUsageDoc = (
  value: JsonRecord | undefined,
): SessionUsage => ({
  models: bucketEntries(objectAt(value, "models")),
});

/**
 * `Harness.taskGraph()` → the live tasks a session reports (LOB-183).
 *
 * Sorted by id so two projections of the same graph compare equal and a client's list does not
 * reshuffle: the graph is keyed by decimal id, and object key order is not a contract.
 */
export const projectTasks = (graph: TaskGraph): readonly SessionTask[] =>
  Object.entries(graph.tasks)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([id, node]) => ({
      id,
      kind: node.kind,
      status: node.state.status,
      ...(node.state.status === "completing"
        ? {}
        : { phase: node.state.phase }),
      waitingOn:
        node.state.status === "waiting" ? node.state.on.map(String) : [],
      ...(node.owner === undefined ? {} : { owner: String(node.owner) }),
      conversations: node.conversations.map(String),
    }));

/** Whether two task projections say the same thing, field by field. */
export const sameTasks = (
  left: readonly SessionTask[],
  right: readonly SessionTask[],
): boolean =>
  left.length === right.length &&
  left.every((task, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      task.id === other.id &&
      task.kind === other.kind &&
      task.status === other.status &&
      task.phase === other.phase &&
      task.owner === other.owner &&
      task.waitingOn.length === other.waitingOn.length &&
      task.waitingOn.every((id, at) => id === other.waitingOn[at]) &&
      task.conversations.length === other.conversations.length &&
      task.conversations.every((id, at) => id === other.conversations[at])
    );
  });

/** Everything a snapshot of one session carries, from either the live view or a fold. */
export type SessionProjection = {
  readonly entries: readonly TranscriptEntry[];
  readonly live: SessionLive;
  readonly usage: SessionUsage;
  readonly status: SessionStatus;
  readonly queued: readonly QueuedMessage[];
};

/** `pi.inbox` → queued messages. */
export const projectInbox = (
  docs: Readonly<Record<string, JsonValue>>,
): readonly QueuedMessage[] => {
  const inbox = docs[INBOX_DOC];
  const items = arrayAt(inbox, "items");
  return items.flatMap((item) => {
    const obj = asObject(item);
    if (obj === undefined) return [];
    const id = stringAt(obj, "id");
    if (id === undefined) return [];
    const modeRaw = stringAt(obj, "mode");
    const mode =
      modeRaw === "steer" || modeRaw === "followUp" || modeRaw === "write"
        ? modeRaw
        : "followUp";
    return [{ id, mode, content: obj["content"] ?? obj["entry"] }];
  });
};

/** A live conversation view → a snapshot. */
export const projectView = (
  view: ConversationView,
  /** The transcript to project. Defaults to the view's active window; the read paths pass the
   * whole log, so a `pi.reset` is a marker in the transcript rather than a truncation of it. */
  entries: readonly EntryRecord[] = view.entries,
): SessionProjection => {
  const live = projectLive(view.docs);
  return {
    entries: entries.map(projectEntry),
    live,
    usage: projectUsageDoc(view.docs[USAGE_DOC]),
    status: live.busy ? "busy" : "idle",
    queued: projectInbox(view.docs),
  };
};

/**
 * What changed between two revisions of a view, as events for an attached client.
 *
 * Documents are compared by reference: Chord publishes immutable revisions and shares unchanged
 * data, so a different reference means a real change. A false positive costs one redundant event,
 * never a missed one.
 */
export const diffView = (
  previous: ConversationView,
  next: ConversationView,
  /** Entry ids the receiver already has. Defaults to what `previous` holds, which is right for a
   * diff against a view; an attach seeds it with the snapshot it sent. Ids are added as they are
   * reported, so an entry is never sent twice. */
  sent: Set<string> = new Set(
    previous.entries.map((entry) => String(entry.id)),
  ),
): readonly SessionEvent[] => {
  const events: SessionEvent[] = [];

  for (const entry of next.entries) {
    const id = String(entry.id);
    if (sent.has(id)) continue;
    sent.add(id);
    events.push({ _tag: "entry", entry: projectEntry(entry) });
    // The PR link is announced by the entry committed beside its document, so a client attached
    // across that commit sees exactly one `prOpened` — a new entry is never re-sent — and one
    // that attaches afterwards reads the link from the session's summary instead.
    if (entry.kind === PR_OPENED_ENTRY_KIND) {
      const prUrl = stringAt(entry.data, "url");
      if (prUrl !== undefined) events.push({ _tag: "prOpened", prUrl });
    }
  }

  if (previous.docs[LIVE_DOC] !== next.docs[LIVE_DOC]) {
    const before = projectLive(previous.docs);
    const live = projectLive(next.docs);
    events.push({ _tag: "live", live });
    if (before.busy !== live.busy) {
      events.push({ _tag: "status", status: live.busy ? "busy" : "idle" });
    }
  }

  if (previous.docs[USAGE_DOC] !== next.docs[USAGE_DOC]) {
    events.push({
      _tag: "usage",
      usage: projectUsageDoc(next.docs[USAGE_DOC]),
    });
  }

  if (previous.docs[INBOX_DOC] !== next.docs[INBOX_DOC]) {
    events.push({
      _tag: "queued",
      queued: projectInbox(next.docs),
    });
  }

  return events;
};
