/**
 * The curator pass over a completed session (LOB-206, part 3 of LOB-47).
 *
 * A curator is not a session. It makes **one** model call over a session's own transcript and the
 * pages that session already holds, and proposes pages from what the work taught. The shape is the
 * requirement: the parent bounds the pass at "a curator run that finds nothing new writes nothing
 * and costs one bounded call", so this module does not retry, schedule, embed or reopen the
 * question. The call count is not promised here — it is counted by the suite against the model
 * provider's own counter, so a second request fails the gate.
 *
 * The prompt is bounded on the way in, because "one bounded call" is about the input too: the newest
 * entries are what the work taught, and the tail is what fits.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UsageDoc } from "@earendil-works/pi-durable";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { Clock, Effect, Schema } from "effect";
import type { Page } from "@repo/domain/Page";
import {
  SessionError as SessionErrorClass,
  type TranscriptEntry,
} from "@repo/domain/Session";
import type { SessionUsage } from "@repo/domain/Session";
import { CURATION_PROMPT_PREFIX, type ModelAccess } from "./models";
import { projectUsageDoc } from "./projection";
import { attempt, type Conversation, type Harness } from "./session";

/** The most pages one curation writes when the caller does not choose a limit. */
export const DEFAULT_CURATION_PAGES = 3;
/**
 * The hard cap: `maxPages` is clamped to this, as `listSessions` clamps its page size. A curation is
 * one bounded call, and a call that may write unbounded pages is not bounded.
 */
export const MAX_CURATION_PAGES = 10;

/** `maxPages` as the pass will use it: the caller's number, clamped into `1..MAX_CURATION_PAGES`. */
export const clampCurationPages = (maxPages: number | undefined): number => {
  if (maxPages === undefined) return DEFAULT_CURATION_PAGES;
  if (!Number.isFinite(maxPages)) return DEFAULT_CURATION_PAGES;
  return Math.min(MAX_CURATION_PAGES, Math.max(1, Math.trunc(maxPages)));
};

/** How much of one transcript entry the curator reads. */
const ENTRY_CHARS = 400;
/** How much of the transcript the curator reads at all, newest entries kept. */
const TRANSCRIPT_CHARS = 8_000;
/** How much of one existing page's content the curator reads. */
const PAGE_CHARS = 400;
/** How much of the existing pages the curator reads at all: the input is bounded too. */
const PAGES_CHARS = 2_000;

/**
 * What the model is told, once, before it is asked anything. Fixed text: a prompt that changes with
 * the session would make two curations of the same work incomparable, and the parent's bound is a
 * property of this call rather than of the model's mood.
 */
export const CURATION_INSTRUCTIONS = [
  "You curate the cited knowledge pages of one finished engineering session.",
  "A page is a named, kinded note that outlives the session: a decision, a trap, a guide.",
  "Its links name other pages, and its sources name the sessions it was learned from.",
  "Read the transcript and the pages the session already holds.",
  "Propose only pages the transcript actually teaches, and only ones the session does not already",
  "hold. If it taught nothing new, propose nothing: an empty array is a correct answer.",
].join(" ");

/** One proposed page as the model answers it: `links` and `sources` may be omitted. */
const CuratedProposal = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  content: Schema.String,
  links: Schema.optional(Schema.Array(Schema.String)),
  sources: Schema.optional(Schema.Array(Schema.String)),
});

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/**
 * One transcript entry as the curator reads it, or `undefined` for the entries that are not the
 * work: a system prompt section, a reset marker, a title, a budget stop, a line a fork inherited and
 * the control plane's own entries are what the session was told or how it was labelled, not what it taught.
 */
const renderEntry = (entry: TranscriptEntry): string | undefined => {
  const text = clip(entry.text, ENTRY_CHARS);
  switch (entry.kind) {
    case "user":
      return `user: ${text}`;
    case "assistant": {
      const tools = entry.toolCalls.map((call) => call.name).join(", ");
      return `assistant: ${text}${tools === "" ? "" : ` [tools: ${tools}]`}`;
    }
    case "toolResult":
      return `toolResult ${entry.toolName ?? "tool"}: ${text}`;
    case "compaction":
      return `compaction: ${text}`;
    case "system":
      return undefined;
    case "reset":
      return undefined;
    case "title":
      return undefined;
    case "budget":
      return undefined;
    case "inherited":
      return undefined;
    case "other":
      return undefined;
  }
};

/** The newest entries that fit the budget, in transcript order. */
const renderTranscript = (entries: readonly TranscriptEntry[]): string => {
  const lines: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const line = renderEntry(entry);
    if (line === undefined) continue;
    if (used + line.length > TRANSCRIPT_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length === 0 ? "(empty)" : lines.reverse().join("\n");
};

/**
 * The pages the session already holds, bounded the way the transcript is: a session curated many
 * times would otherwise grow the prompt with every pass, and a prompt that grows is not one bounded
 * call. What does not fit is counted rather than silently dropped.
 */
const renderPages = (pages: readonly Page[]): string => {
  if (pages.length === 0) return "(none)";
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const page of pages) {
    const line = `- ${page.name} [${page.kind}]: ${clip(page.content, PAGE_CHARS)}`;
    if (used + line.length > PAGES_CHARS) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) {
    lines.push(`(${omitted} more page${omitted === 1 ? "" : "s"} not shown)`);
  }
  return lines.join("\n");
};

/** The one request's user message. The marker is what a scripted model answers (see `models.ts`). */
export const curationPrompt = (
  options: Omit<CurationOptions, "model">,
): string =>
  [
    `${CURATION_PROMPT_PREFIX} session ${options.sourceId}`,
    "",
    `## pages this session already holds`,
    renderPages(options.pages),
    "",
    "## the transcript",
    renderTranscript(options.entries),
    "",
    "## your answer",
    `Reply with only a JSON array of at most ${options.maxPages} pages, shaped`,
    '{"name": "...", "kind": "...", "content": "...", "links": [], "sources": []}.',
    "An empty array means the session taught nothing new.",
  ].join("\n");

/** The answer's text, flattened: a curator reads text, not a tool call. */
const answerText = (message: AssistantMessage): string =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");

/** One answer, read as a JSON array of proposals. */
const CurationAnswer = Schema.fromJsonString(Schema.Array(CuratedProposal));

/**
 * The proposals in an answer.
 *
 * A model answers JSON, and a model that fences its JSON in a Markdown block has still answered
 * JSON, so the array is taken between its first `[` and its last `]`. Anything else is a refusal
 * rather than "nothing new": a curator whose answer cannot be read did not teach nothing, it failed,
 * and pretending otherwise would make a broken curator look like a quiet one.
 */
const parseProposals = (
  answer: string,
): Effect.Effect<
  readonly (typeof CuratedProposal.Type)[],
  SessionErrorClass
> => {
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");
  if (start < 0 || end < start) {
    return Effect.fail(
      new SessionErrorClass({
        code: "harness",
        message: `the curator answered no JSON array: ${clip(answer, 200)}`,
      }),
    );
  }
  return Schema.decodeEffect(CurationAnswer)(answer.slice(start, end + 1)).pipe(
    Effect.mapError(
      (cause) =>
        new SessionErrorClass({
          code: "harness",
          message: `the curator's answer is not a list of pages: ${String(cause)}`,
        }),
    ),
  );
};

/** The run two counters, which pi-durable's ledger also adds: absent on both sides stays absent. */
const sum = (
  left: number | undefined,
  right: number | undefined,
): number | undefined =>
  left === undefined && right === undefined
    ? undefined
    : (left ?? 0) + (right ?? 0);

/**
 * One call's usage added to a bucket, field by field — the arithmetic `pi-durable` does for a turn
 * it ran itself (`recordUsage`, which the package does not export; the document is public).
 */
const addUsage = (total: Usage | undefined, usage: Usage): Usage => {
  const cacheWrite1h = sum(total?.cacheWrite1h, usage.cacheWrite1h);
  const reasoning = sum(total?.reasoning, usage.reasoning);
  return {
    input: sum(total?.input, usage.input) ?? 0,
    output: sum(total?.output, usage.output) ?? 0,
    cacheRead: sum(total?.cacheRead, usage.cacheRead) ?? 0,
    cacheWrite: sum(total?.cacheWrite, usage.cacheWrite) ?? 0,
    totalTokens: sum(total?.totalTokens, usage.totalTokens) ?? 0,
    cost: {
      input: sum(total?.cost.input, usage.cost.input) ?? 0,
      output: sum(total?.cost.output, usage.cost.output) ?? 0,
      cacheRead: sum(total?.cost.cacheRead, usage.cost.cacheRead) ?? 0,
      cacheWrite: sum(total?.cost.cacheWrite, usage.cost.cacheWrite) ?? 0,
      total: sum(total?.cost.total, usage.cost.total) ?? 0,
    },
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
};

/**
 * Charge one curation call to the session it curated, in that session's own `pi.usage` ledger.
 *
 * A curator is not a session, so there is no curator's log to charge: the spend of a call made on
 * behalf of a session belongs in the document a later reader (and the PR step's spend block) reads
 * for that session. `key` is the model, keyed as `provider/modelId` the way `pi-durable` keys it.
 */
export const writeCurationUsage = (
  conversation: Conversation,
  key: string,
  usage: Usage,
): Effect.Effect<void, SessionErrorClass> =>
  attempt("write curation usage", () =>
    conversation.commit(
      (tx) =>
        tx.doc(UsageDoc, conversation.id).then((doc) => {
          doc.models[key] = addUsage(doc.models[key], usage);
        }),
      BACKGROUND_CONTEXT,
    ),
  );

/**
 * The spend a conversation's own ledger records, as the control plane reports it.
 *
 * The service derives its activity index from this rather than from a snapshot taken before the
 * call: a run that emitted a usage event while the curation was in flight must not be overwritten
 * with a pre-call total, and the ledger read after the charge can only be at least that event's.
 */
export const readCurationUsage = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<SessionUsage, SessionErrorClass> =>
  Effect.map(
    attempt("read session usage", () =>
      harness.snapshot(UsageDoc, conversation.id, BACKGROUND_CONTEXT),
    ),
    (state) => projectUsageDoc(state),
  );

export type CurationOptions = {
  /** The model the process serves; the one call runs on it. */
  readonly model: ModelAccess;
  /** The session being curated: every page this proposes cites it. */
  readonly sourceId: string;
  /** The curated session's transcript, as the control plane already folded it. */
  readonly entries: readonly TranscriptEntry[];
  /** The pages the curated session already holds, so it does not propose them again. */
  readonly pages: readonly Page[];
  /** The most pages to propose, already clamped by `clampCurationPages`. */
  readonly maxPages: number;
};

export type Curation = {
  /** What the model proposed, capped to `maxPages`: what a caller may write. */
  readonly proposals: readonly Page[];
  /** How many it proposed before the cap, so a caller can see the cap did work. */
  readonly proposed: number;
};

/** One call's answer, and what that call cost. */
export type CurationRequest = {
  readonly answer: AssistantMessage;
  /** The call's spend. The caller charges it before it reads the answer: the call was made. */
  readonly usage: Usage;
};

/**
 * The one model call. It is the only place this module reaches a provider, which is what makes "a
 * curation is one call" a property of the code rather than of a caller's promise.
 *
 * It takes the whole `CurationOptions` — the cap included — because the prompt names the cap it is
 * asking for: a pass told "at most 3" and then cut to 2 would be a pass that asked a question it
 * did not want answered.
 */
export const requestCuration = (
  options: CurationOptions,
): Effect.Effect<CurationRequest, SessionErrorClass> =>
  Effect.gen(function* () {
    const request = options.model.models.getModel(
      options.model.provider,
      options.model.modelId,
    );
    if (request === undefined) {
      return yield* new SessionErrorClass({
        code: "harness",
        message: `this process serves no model ${options.model.provider}/${options.model.modelId}, so nothing can curate`,
      });
    }
    const message: Message = {
      role: "user",
      content: curationPrompt(options),
      timestamp: yield* Clock.currentTimeMillis,
    };
    const answer = yield* Effect.tryPromise({
      try: () =>
        options.model.models.completeSimple(request, {
          systemPrompt: CURATION_INSTRUCTIONS,
          messages: [message],
        }),
      catch: (cause) =>
        new SessionErrorClass({
          code: "harness",
          message: `the curator's model call failed: ${String(cause)}`,
        }),
    });
    // An error answer is not a failure here: the call happened and was billed, and the caller has to
    // charge it before this pass decides the answer is unusable. `curationProposals` is where an
    // unusable answer is refused.
    return { answer, usage: answer.usage };
  });

/**
 * The proposals in a curation's answer, capped and cited.
 *
 * Every proposal cites the curated session, whether or not the model named it: a page this pass
 * wrote was, by construction, learned from this session, and a citation the caller has to trust the
 * model to add is one that is silently missing when it forgets.
 *
 * An answer that cannot be read is a refusal rather than "nothing new" — and it is the caller's job
 * to have charged the call before asking this.
 */
export const curationProposals = (
  request: CurationRequest,
  options: Pick<CurationOptions, "sourceId" | "maxPages">,
): Effect.Effect<Curation, SessionErrorClass> =>
  Effect.gen(function* () {
    if (request.answer.stopReason === "error") {
      return yield* new SessionErrorClass({
        code: "harness",
        message: `the curator's model call failed: ${request.answer.errorMessage ?? "no message"}`,
      });
    }
    const proposed = yield* parseProposals(answerText(request.answer));
    const kept = proposed
      .filter((proposal) => proposal.name.trim().length > 0)
      .slice(0, options.maxPages);
    return {
      proposals: kept.map((proposal) => ({
        name: proposal.name.trim(),
        kind: proposal.kind,
        content: proposal.content,
        links: proposal.links ?? [],
        sources: [...new Set([options.sourceId, ...(proposal.sources ?? [])])],
      })),
      proposed: proposed.length,
    };
  });
