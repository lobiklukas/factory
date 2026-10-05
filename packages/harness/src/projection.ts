/**
 * The projection: Pi Durable's committed records and documents into the session contracts the
 * API and the dashboard speak (`packages/domain/Session`).
 *
 * Entries are typed by Pi Durable, so they are read directly. Documents arrive as JSON
 * (`ConversationView.docs`), so they are read defensively: an unknown or renamed field drops out
 * of the projection instead of breaking it, which is the point of having a projection at all.
 */
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
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
  SessionEvent,
  SessionLive,
  SessionStatus,
  SessionUsage,
  ToolCallRef,
  ToolSlotView,
  TranscriptEntry,
  TranscriptEntryKind,
} from "@repo/domain/Session";

/** The conversation documents this projection reads, and the entry kind this package writes. */
export const LIVE_DOC = "pi.live";
export const USAGE_DOC = "pi.usage";
export const TITLE_ENTRY_KIND = "factory.title";

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
  tools: bucketEntries(objectAt(value, "tools")),
});

/** Everything a snapshot of one session carries, from either the live view or a fold. */
export type SessionProjection = {
  readonly entries: readonly TranscriptEntry[];
  readonly live: SessionLive;
  readonly usage: SessionUsage;
  readonly status: SessionStatus;
};

/** A live conversation view → a snapshot. */
export const projectView = (view: ConversationView): SessionProjection => {
  const live = projectLive(view.docs);
  return {
    entries: view.entries.map(projectEntry),
    live,
    usage: projectUsageDoc(view.docs[USAGE_DOC]),
    status: live.busy ? "busy" : "idle",
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
): readonly SessionEvent[] => {
  const events: SessionEvent[] = [];

  const known = new Set(previous.entries.map((entry) => String(entry.id)));
  for (const entry of next.entries) {
    if (!known.has(String(entry.id))) {
      events.push({ _tag: "entry", entry: projectEntry(entry) });
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

  return events;
};
