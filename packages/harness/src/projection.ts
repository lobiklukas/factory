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
import { Option, Schema } from "effect";
import type {
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { PrEvidence, ReplayComparison } from "@repo/domain/Session";
import type {
  ModelUsage,
  QueuedMessage,
  SessionBudget,
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
/**
 * The merge of the PR a session opened, as GitHub's webhook reported it (LOB-44), and the revert
 * that undid it when one merged later. A document of its own rather than fields on `factory.pr`,
 * because the PR step writes that record and reads it back before it calls GitHub: a merge is a
 * fact about what happened to the PR afterwards, written by a different writer (the webhook).
 */
export const MERGE_DOC_KIND = "factory.merge";
/**
 * Who a session's spend is attributed to (LOB-162): the actor `createSession` was given, or the one
 * a fork or a replay took from its source. The `sessions.actor` column is its index.
 */
export const ACTOR_DOC_KIND = "factory.actor";
/** The lineage a forked session's log records (LOB-180): its parent and the entry it was taken at. */
export const FORK_DOC_KIND = "factory.fork";
/**
 * The link a replay's log records (LOB-198): the session it replays, itself, and both models — and,
 * once the replay's task settles, the comparison of the two runs (LOB-199).
 *
 * The link lives in the *replay's* log only: replaying must not change the recorded run it replays,
 * so the source's transcript, spend and lineage are never written. The comparison is the one
 * exception, and it is a document rather than a run: the source's `factory.replay` carries only
 * `comparisons` (its link fields stay empty, so the source never reads as a replay), keyed by the
 * replay it names, which is how either session reports the pairing on its own.
 */
export const REPLAY_DOC_KIND = "factory.replay";

/**
 * `factory.replay` → the pair of sessions a replay names, and the model it ran on with the one its
 * source recorded. An empty field is a document that does not say, which every reader copes with:
 * `model` empty means the log never saw a turn.
 */
export const projectReplayDoc = (
  value: JsonValue | undefined,
): {
  readonly source: string;
  readonly replay: string;
  readonly model: string;
  readonly from: string;
} => ({
  source: stringAt(value, "source") ?? "",
  replay: stringAt(value, "replay") ?? "",
  model: stringAt(value, "model") ?? "",
  from: stringAt(value, "from") ?? "",
});

const decodeComparison = Schema.decodeUnknownOption(ReplayComparison);

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * `factory.replay`'s `comparisons` → every comparison that decodes, oldest first (LOB-199).
 *
 * The document keys them by counterpart, and key order is not a contract, so they are sorted by when
 * they were taken and then by counterpart: two projections of one document compare equal. A value
 * that does not decode drops out rather than failing the read — the projection's rule for every
 * document — and a document written before comparisons existed holds none.
 */
export const projectReplayComparisons = (
  value: JsonValue | undefined,
): readonly ReplayComparison[] =>
  Object.values(objectAt(value, "comparisons") ?? {})
    .flatMap((entry) => Option.toArray(decodeComparison(entry)))
    .sort(
      (left, right) =>
        compareText(left.at, right.at) ||
        compareText(left.counterpart.session, right.counterpart.session),
    );

export const TITLE_ENTRY_KIND = "factory.title";
/**
 * The entry a session's PR is announced with (LOB-177). It carries the link, and it exists because
 * Pi Durable's conversation view mounts only its own built-in documents: a `PrDoc` commit is not
 * visible to an attached client, so the record and the announcement are two writes in one commit.
 */
export const PR_OPENED_ENTRY_KIND = "factory.pr.opened";
/**
 * What a fork's copy of its parent's `factory.pr.opened` becomes (LOB-211): the same data under a
 * kind nothing announces. A fork does not inherit the parent's PR — it runs on a branch of its own
 * (D10), and a `factory.pr` it inherited would be the record its own PR step reads back instead of
 * opening one — so its transcript keeps the line, as history, but never yields a `prOpened`. It
 * projects as transcript kind `inherited`, so a client draws it as a marker, not as agent prose.
 *
 * Rewritten rather than skipped because a fork's copy is the parent's transcript entry for entry:
 * a compaction's head can name any kept entry, and a skipped one leaves a marker with nothing to
 * point at.
 */
export const PR_INHERITED_ENTRY_KIND = "factory.pr.inherited";
/** The line an inherited PR entry reads as: whose PR it is, so nobody takes it for the fork's. */
export const inheritedPrText = (url: string): string =>
  `a session this one was forked from opened ${url}`;
/**
 * The entry a recorded page is announced with. Distinct from the document kind (`factory.page`), as
 * `factory.pr` is announced by `factory.pr.opened`: documents and entries are different namespaces,
 * and one name for both would make a fold over entries unable to say which it was reading.
 */
export const PAGE_ENTRY_KIND = "factory.page.written";
/**
 * The entry an unchanged branch is announced with (LOB-196): the PR step measured the branch
 * against its base, found nothing to publish, and opened nothing.
 *
 * An entry rather than a document, for the reason `factory.pr.opened` is one: a no-change answer
 * leaves the session's state untouched — no PR, no document, no row — so what a person watching the
 * run has to read it from is the transcript. Without it a no-op run is silence, which is
 * indistinguishable from a run that never reached the PR step at all.
 */
export const NO_CHANGE_ENTRY_KIND = "factory.pr.no-change";
/**
 * The entry a settled run's PR step announces when it opened no PR for a reason other than an
 * unchanged branch (C18): the diff over the cap, a remote branch the push may not overwrite, or a
 * failure. The step's operator-driven caller answers those to the person who asked; a run that
 * settled has nobody waiting on the answer, so the transcript is where a reader finds it.
 */
export const PR_NOT_OPENED_ENTRY_KIND = "factory.pr.not-opened";
/**
 * A session's spend ceiling and its last stop (LOB-163, `./budget`). A document because the cap is
 * state a hook reads before every request, and the stop beside it is what a snapshot reports.
 */
export const BUDGET_DOC_KIND = "factory.budget";
/**
 * The entry a budget stop is announced with (LOB-163): the cap stopped a run before its next model
 * request. An entry beside the document for the reason `factory.pr.opened` is one: an attached
 * client sees entries, not factory documents, and a stop nobody watching can see is a run that
 * merely went quiet.
 */
export const BUDGET_STOPPED_ENTRY_KIND = "factory.budget.stopped";
/**
 * The entry an operator's interrupt is announced with (C8): the run was stopped before it finished.
 * An entry for the reason a budget stop is one: Pi Durable settles the aborted run `unanswered` and
 * writes nothing a reader would see, so without it an interrupted turn reads as one that went quiet.
 */
export const INTERRUPTED_ENTRY_KIND = "factory.run.interrupted";
/** Which work an interrupt already marked (C8), so an overlapping or retried one marks it once. */
export const INTERRUPT_DOC_KIND = "factory.interrupt";
export const APPROVAL_REQUESTED_KIND = "factory.approval.requested";
export const APPROVAL_DECIDED_KIND = "factory.approval.decided";
/**
 * The entry that spends an approval (LOB-52): a gated call ran on it. An approval covers one run of
 * the call it names, so once it is used the same call asks again under a new request id.
 */
export const APPROVAL_USED_KIND = "factory.approval.used";
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
  /** When a gated call ran on this approval (LOB-52); absent while it is unused or not approved. */
  readonly usedAt?: string;
};

/** The verdict in a decision entry, or `undefined` for anything that is not one. */
const verdictAt = (
  value: JsonValue | undefined,
): ApprovalVerdict | undefined => {
  const verdict = stringAt(value, "decision");
  return verdict === "approved" || verdict === "denied" ? verdict : undefined;
};

/** The kinds `projectApprovals` folds: what a log's approval ledger (`factory.approvals`) keeps. */
export const APPROVAL_ENTRY_KINDS: ReadonlySet<string> = new Set([
  APPROVAL_REQUESTED_KIND,
  APPROVAL_DECIDED_KIND,
  APPROVAL_USED_KIND,
]);

/**
 * What `projectApprovals` reads of an entry: its kind and its data. An `EntryRecord` is one, and so
 * is an entry of the approval ledger, which keeps exactly these two fields of each approval entry
 * so a historical read folds the ledger with this same function instead of the whole transcript
 * (LOB-243).
 */
export type ApprovalEntry = {
  readonly kind: string;
  readonly data?: JsonValue | undefined;
};

/**
 * `factory.approval.requested`, `.decided` and `.used` → one record per request id.
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
  entries: readonly ApprovalEntry[],
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
    if (entry.kind === APPROVAL_USED_KIND) {
      // Only an approval can be used, and only once: a use that names a request still pending, or
      // denied, spends nothing.
      const record = records.get(requestId);
      const usedAt = stringAt(entry.data, "usedAt");
      if (
        record?.decision?.decision !== "approved" ||
        record.usedAt !== undefined ||
        usedAt === undefined
      )
        continue;
      records.set(requestId, { ...record, usedAt });
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

/** A JSON array of strings, with anything else at an element dropped rather than guessed. */
const stringsAt = (
  parent: JsonValue | undefined,
  key: string,
): readonly string[] =>
  arrayAt(parent, key).flatMap((value) =>
    typeof value === "string" ? [value] : [],
  );

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
    case BUDGET_STOPPED_ENTRY_KIND:
      return "budget";
    case INTERRUPTED_ENTRY_KIND:
      return "interrupted";
    case PR_INHERITED_ENTRY_KIND:
      return "inherited";
    default:
      return "other";
  }
};

/**
 * How a log's newest run ended (C18): `finished` when it answered, `interrupted` when an operator
 * stopped it (C8), `budget` when its cap did (LOB-163), and `failed` when its last model answer is
 * an error or an abort. A settled run's PR step reads it, because only a run that finished made the
 * change it set out to make: a stopped one's branch holds whatever it had reached.
 */
export type RunEnding = "finished" | "interrupted" | "budget" | "failed";

/**
 * The newest run's ending, from the log's entries newest first, read back to the run's newest user
 * input (`pi.user`, where a run — or a steer into it — starts). The interrupt and budget markers
 * are committed before their abort, so either one that sits after that input is this run's, and it
 * decides whatever follows it (an interrupted tool call's aborted result, a partial answer). With
 * neither, the newest model answer decides: an `error` or `aborted` stop is a run that failed.
 * Entries past the input — an earlier run's markers, the PR step's own lines — say nothing about it.
 */
export const runEndingOf = (newestFirst: Iterable<EntryRecord>): RunEnding => {
  const run = scanLatestRun(newestFirst);
  if (run.marker !== undefined) return run.marker;
  return run.answer === "error" ? "failed" : "finished";
};

/**
 * What the newest run's entries say, read back to its newest user input (`runEndingOf`): the stop
 * marker an operator or the budget committed, if either sits after that input, and the stop reason
 * of the newest model answer after it — `none` when it has none yet, `other` for an assistant
 * entry whose message the log does not carry.
 */
const scanLatestRun = (
  newestFirst: Iterable<EntryRecord>,
): {
  readonly marker: "interrupted" | "budget" | undefined;
  readonly answer: "none" | "other" | "error" | "toolUse" | "length" | "stop";
} => {
  let answer: "none" | "other" | "error" | "toolUse" | "length" | "stop" =
    "none";
  for (const entry of newestFirst) {
    if (entry.kind === "pi.user") break;
    if (entry.kind === INTERRUPTED_ENTRY_KIND)
      return { marker: "interrupted", answer };
    if (entry.kind === BUDGET_STOPPED_ENTRY_KIND)
      return { marker: "budget", answer };
    if (entry.kind === "pi.assistant" && answer === "none") {
      const message = entry.model?.[0];
      answer =
        message?.role !== "assistant"
          ? "other"
          : message.stopReason === "error" || message.stopReason === "aborted"
            ? "error"
            : message.stopReason === "toolUse"
              ? "toolUse"
              : message.stopReason === "length"
                ? "length"
                : "stop";
    }
  }
  return { marker: undefined, answer };
};

/**
 * How the card's newest run stands as a board's `run_completed` exit requirement reads it (D9):
 * `completed` when its newest answer ended the turn on its own, `unfinished` when it has no answer
 * yet or its newest answer asked for a tool whose result has not been answered (still working, or
 * it died mid-loop), `truncated` when its newest answer was cut off at the model's output limit
 * (`stopReason: "length"`: the answer did not end on its own, so it is not a completed turn), and
 * `interrupted`, `budget` or `failed` as `RunEnding` says. A run that is parked on a person's
 * question or approval has not completed either; it is `unfinished`.
 */
export type RunTurn =
  | "completed"
  | "unfinished"
  | "truncated"
  | Exclude<RunEnding, "finished">;

/** The newest run's turn, from the log's entries newest first (`runEndingOf`'s window). */
export const runTurnOf = (newestFirst: Iterable<EntryRecord>): RunTurn => {
  const run = scanLatestRun(newestFirst);
  if (run.marker !== undefined) return run.marker;
  switch (run.answer) {
    case "error":
      return "failed";
    case "length":
      return "truncated";
    case "none":
    case "toolUse":
      return "unfinished";
    case "other":
    case "stop":
      return "completed";
  }
};

export const projectEntry = (entry: EntryRecord): TranscriptEntry => {
  const message = entry.model?.[0];
  const toolName =
    message?.role === "toolResult" ? message.toolName : undefined;
  // A tool result says whether the tool failed; an assistant entry is an error when its model
  // request failed (`stopReason: "error"`), which is what ends a run `model_error` once Pi Durable
  // stops retrying it — the activity projection records that run as failed (S-notifications).
  const failedRequest =
    message?.role === "assistant" && message.stopReason === "error";
  const isError =
    message?.role === "toolResult"
      ? message.isError
      : failedRequest
        ? true
        : undefined;
  // The title, no-change, not-opened, budget, interrupted and inherited-PR entries carry no model
  // content, so their text comes from their data — which is what makes a no-op PR step or a budget
  // stop a readable line, not an empty entry.
  const text =
    entry.kind === TITLE_ENTRY_KIND
      ? (stringAt(asObject(entry.data), "title") ?? "")
      : entry.kind === NO_CHANGE_ENTRY_KIND ||
          entry.kind === PR_NOT_OPENED_ENTRY_KIND ||
          entry.kind === BUDGET_STOPPED_ENTRY_KIND ||
          entry.kind === INTERRUPTED_ENTRY_KIND
        ? (stringAt(asObject(entry.data), "text") ?? "")
        : entry.kind === PR_INHERITED_ENTRY_KIND
          ? inheritedPrText(stringAt(asObject(entry.data), "url") ?? "")
          : messageText(message);
  // A failed request's provider message rides beside the text, not in it: the text is what the
  // model answered, and the CLI and the transcript read it as that (S-notifications).
  const error = failedRequest
    ? message.errorMessage === undefined || message.errorMessage === ""
      ? "the model request failed"
      : message.errorMessage
    : undefined;
  return {
    id: String(entry.id),
    kind: entryKind(entry.kind),
    text,
    toolCalls: toolCallRefs(message),
    ...(toolName === undefined ? {} : { toolName }),
    ...(isError === undefined ? {} : { isError }),
    ...(error === undefined ? {} : { error }),
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
  /** The commit the PR's head was published at when the session recorded it (C19); `""` unknown. */
  readonly commit: string;
  /**
   * What the PR says was verified (LOB-79). Absent for a PR recorded before evidence existed, and
   * for a value that does not decode: a document is read defensively, so a stray shape drops out
   * rather than reaching a reader as evidence.
   */
  readonly evidence?: PrEvidence;
};

const decodeEvidence = Schema.decodeUnknownOption(PrEvidence);

/** The evidence a `factory.pr` document or its `factory.pr.opened` entry carries, if it decodes. */
export const evidenceAt = (
  parent: JsonValue | undefined,
): PrEvidence | undefined =>
  Option.getOrUndefined(decodeEvidence(asObject(parent)?.["evidence"]));

export const projectPrDoc = (value: JsonValue | undefined): PrDocView => {
  const evidence = evidenceAt(value);
  return {
    url: stringAt(value, "url") ?? "",
    number: numberAt(value, "number"),
    base: stringAt(value, "base") ?? "",
    head: stringAt(value, "head") ?? "",
    openedAt: stringAt(value, "openedAt") ?? "",
    commit: stringAt(value, "commit") ?? "",
    ...(evidence === undefined ? {} : { evidence }),
  };
};

/**
 * What `factory.merge` records (LOB-44): the PR that merged and when, and the revert that undid it.
 * An empty string is a field the document does not hold: `mergedAt` empty is "no merge recorded",
 * and `revertedAt` empty is "not reverted" — the seed is both.
 */
export type MergeDocView = {
  readonly url: string;
  readonly number: number;
  readonly mergedAt: string;
  /** The merge commit GitHub reported (`merge_commit_sha`), empty when it named none. */
  readonly commit: string;
  /** The PR that reverted this one, by its page. */
  readonly revertedBy: string;
  readonly revertedAt: string;
};

export const projectMergeDoc = (
  value: JsonValue | undefined,
): MergeDocView => ({
  url: stringAt(value, "url") ?? "",
  number: numberAt(value, "number"),
  mergedAt: stringAt(value, "mergedAt") ?? "",
  commit: stringAt(value, "commit") ?? "",
  revertedBy: stringAt(value, "revertedBy") ?? "",
  revertedAt: stringAt(value, "revertedAt") ?? "",
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
  // Sorted by key so two projections of one ledger compare equal and a client's list does not
  // reshuffle: `pi.usage`'s buckets are objects, and their key order is not a contract.
  Object.entries(bucket ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => ({
      key,
      usage: readModelUsage(value),
    }));

/**
 * `pi.usage` → the session's spend, both buckets (LOB-153).
 *
 * A tool's usage has no model identity and is keyed by the tool's name instead; both buckets carry
 * the same counters. A document that predates `tools` (or a conversation that ran none) reads as
 * an empty list, so "nothing reported" and "nothing to report" project the same way.
 */
export const projectUsageDoc = (
  value: JsonRecord | undefined,
): SessionUsage => ({
  models: bucketEntries(objectAt(value, "models")),
  tools: bucketEntries(objectAt(value, "tools")),
});

const addModelUsage = (left: ModelUsage, right: ModelUsage): ModelUsage => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  totalTokens: left.totalTokens + right.totalTokens,
  costTotal: left.costTotal + right.costTotal,
});

type UsageBucket = { readonly key: string; readonly usage: ModelUsage };

const mergeBuckets = (
  buckets: readonly (readonly UsageBucket[])[],
): readonly UsageBucket[] => {
  const sums = new Map<string, ModelUsage>();
  for (const bucket of buckets)
    for (const { key, usage } of bucket)
      sums.set(key, addModelUsage(sums.get(key) ?? ZERO_USAGE, usage));
  return [...sums.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, usage]) => ({ key, usage }));
};

/**
 * Several conversations' spend as one session's: each bucket summed by key, sorted as
 * `projectUsageDoc` sorts them.
 *
 * `pi.usage` is per conversation, and a session can hold more than its root: a mission's workers
 * talk in conversations of their own (LOB-193). The session's spend — what the list reports, what a
 * fork carries and what the budget cap is checked against — is every conversation's, which is what
 * `Harness.usage()` sums for a log this process owns; a fold sums the same documents through this.
 */
export const mergeUsage = (usages: readonly SessionUsage[]): SessionUsage => ({
  models: mergeBuckets(usages.map((usage) => usage.models)),
  tools: mergeBuckets(usages.map((usage) => usage.tools)),
});

/**
 * What a session's spend adds up to, in the currency `pi.usage` reports: every model bucket plus
 * every tool bucket.
 *
 * The list surface shows this (`costTotal`) and the rebuild fold writes it (`session_activity`), so
 * the two have to add the same buckets or a rebuilt index disagrees with the live one for any
 * session whose spend is not all model spend. Exported rather than inlined in either place for
 * exactly that reason: one definition, two callers.
 */
export const usageCostTotal = (usage: SessionUsage): number =>
  [...usage.models, ...usage.tools].reduce(
    (total, bucket) => total + bucket.usage.costTotal,
    0,
  );

/**
 * One ledger's spend as a single set of counters: every model bucket and every tool bucket added,
 * the buckets `usageCostTotal` adds. A mission worker's share of the session's spend (LOB-194) is
 * this over the conversation it owns, so `usageCostTotal` of the session's usage is the sum of its
 * conversations' `costTotal` here.
 */
export const totalSpend = (usage: SessionUsage): ModelUsage =>
  [...usage.models, ...usage.tools].reduce(
    (total, bucket) => addModelUsage(total, bucket.usage),
    ZERO_USAGE,
  );

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

/**
 * `factory.budget` and the session's spend → its budget (LOB-163), or `undefined` for a session with
 * no cap. `spent` is the log's own `pi.usage` total plus what it inherited (`carried`, a fork's). The seed's cap is `0`, which is "no cap": `SessionBudgetCap` refuses a zero, so no session
 * asked for one. The stop is reported only once one was recorded (`stoppedAt` set).
 */
export const projectBudgetDoc = (
  value: JsonValue | undefined,
  usage: SessionUsage,
): SessionBudget | undefined => {
  const cap = numberAt(value, "cap");
  if (cap <= 0) return undefined;
  const at = stringAt(value, "stoppedAt") ?? "";
  return {
    cap,
    // A fork's inherited spend counts as the hook counts it (`BudgetDoc.carried`).
    spent: numberAt(value, "carried") + usageCostTotal(usage),
    ...(at === ""
      ? {}
      : {
          stopped: {
            at,
            spent: numberAt(value, "stoppedSpent"),
            cap: numberAt(value, "stoppedCap"),
          },
        }),
  };
};

/** Everything a snapshot of one session carries, from either the live view or a fold. */
export type SessionProjection = {
  readonly entries: readonly TranscriptEntry[];
  readonly live: SessionLive;
  readonly usage: SessionUsage;
  readonly status: SessionStatus;
  readonly queued: readonly QueuedMessage[];
};

/**
 * `pi.inbox` → queued messages.
 *
 * An item's id is its submission's: a branded number in the document, sent as the opaque string
 * `sendMessage` answers (LOB-166). Reading it only as a string dropped every real item, and a queued
 * message a client cannot name is one it cannot withdraw.
 */
export const projectInbox = (
  docs: Readonly<Record<string, JsonValue>>,
): readonly QueuedMessage[] => {
  const inbox = docs[INBOX_DOC];
  const items = arrayAt(inbox, "items");
  return items.flatMap((item) => {
    const obj = asObject(item);
    if (obj === undefined) return [];
    const raw = obj["id"];
    const id =
      typeof raw === "number"
        ? String(raw)
        : typeof raw === "string"
          ? raw
          : undefined;
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
      const evidence = evidenceAt(entry.data);
      if (prUrl !== undefined)
        events.push({
          _tag: "prOpened",
          prUrl,
          ...(evidence === undefined ? {} : { evidence }),
        });
    }
  }

  // The queue before liveness: a follower stops at the first event that says the run settled
  // (`factory run`/`watch`), so a queue reading committed beside it must already be out, or the
  // drain it reports is never seen (LOB-166).
  if (previous.docs[INBOX_DOC] !== next.docs[INBOX_DOC]) {
    events.push({
      _tag: "queued",
      queued: projectInbox(next.docs),
    });
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

/**
 * The cited knowledge pages a log holds (LOB-204), folded from the `factory.page` entries that
 * announce each one.
 *
 * The entries, not the `factory.page` documents, are what a rebuild can see: a fold reads `commits`,
 * and a document is a separate record. So every page is committed twice in one transaction — the
 * document for the typed read, the entry for this fold — exactly as the PR step announces itself
 * (LOB-177).
 *
 * A later entry for the same name replaces the earlier one, and the fold is ordered by name, so two
 * logs that committed the same pages in a different order read back the same way.
 */
export type PageLogRecord = {
  readonly name: string;
  readonly kind: string;
  readonly content: string;
  readonly links: readonly string[];
  readonly sources: readonly string[];
};

export const projectPages = (
  entries: readonly EntryRecord[],
): readonly PageLogRecord[] => {
  const pages = new Map<string, PageLogRecord>();
  for (const entry of entries) {
    if (entry.kind !== PAGE_ENTRY_KIND) continue;
    const name = stringAt(entry.data, "name");
    if (name === undefined || name === "") continue;
    pages.set(name, {
      name,
      kind: stringAt(entry.data, "kind") ?? "",
      content: stringAt(entry.data, "content") ?? "",
      links: stringsAt(entry.data, "links"),
      sources: stringsAt(entry.data, "sources"),
    });
  }
  return [...pages.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
};
