/**
 * Model access for a harness.
 *
 * `anthropic` is the real provider. `faux` is pi-ai's deterministic in-process provider: scripted
 * answers, no key, no network, no cost, so verification (`.pi/skills/verify-api`) drives sessions
 * reproducibly and the gate stays offline. Switching backend is configuration, not code.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createModels,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai/models";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  AuthContext,
  Message,
  ToolCall,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

import {
  DEFAULT_COMPACTION_POLICY,
  type CompactionPolicy,
} from "@earendil-works/pi-durable";
import { Effect, Option, Schema } from "effect";
import { MAX_PROPOSALS, titleKey } from "@repo/domain/Decomposition";
import { MAX_PLAN_PROPOSALS } from "@repo/domain/PlanFreshness";
import { VERIFY_TOOL } from "./verify";
import { ASK_TOOL, THREAD_SECTION_KEY } from "./ask";
import { SPEC_TOOL } from "./specify";
import { REVIEW_TOOL } from "./review";

/** pi-ai's credential lookup, so a caller can read the variables a request would authenticate from. */
export {
  defaultProviderAuthContext,
  type AuthContext,
} from "@earendil-works/pi-ai";

export type ModelBackend = "anthropic" | "faux";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

/**
 * The id pi-ai's faux provider publishes its model under, so a session can name it before the
 * provider is registered (`fauxProvider` defaults to it).
 */
export const FAUX_MODEL_ID = "faux-1";

/** The command the faux script runs unless a caller scripts another one. */
export const FAUX_COMMAND = "echo faux-ok";

export type ModelAccess = {
  readonly backend: ModelBackend;
  readonly models: Models;
  /** Provider id and model id stored in a conversation's agent. */
  readonly provider: string;
  readonly modelId: string;
  /**
   * The context window the provider's catalog publishes for this model, which is what a session's
   * compaction thresholds are derived from; `0` when the catalog does not say.
   */
  readonly contextWindow: number;
  /**
   * What every answer costs on top of the catalog's price, in US dollars: the faux backend's flat
   * `fauxCost`, which its catalog cannot express. A caller that bounds a call's cost before making it
   * (LOB-45's plan-freshness pass) adds it to the worst case. Absent: the catalog's price is all.
   */
  readonly flatCost?: number;
};

/** The text of the newest `toolName` result in the transcript, or `undefined` if it has not run. */
const toolResultText = (
  messages: readonly Message[],
  toolName: string,
): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message !== undefined &&
      message.role === "toolResult" &&
      message.toolName === toolName
    ) {
      return message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
    }
  }
  return undefined;
};

/** Every `toolName` result in the transcript, oldest first, as whether each was an error. */
const toolResultErrors = (
  messages: readonly Message[],
  toolName: string,
): readonly boolean[] =>
  messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === toolName
      ? [message.isError]
      : [],
  );

/** A spec attempt the faux script sends (`fauxSpec`): the `spec` tool's arguments, verbatim. */
export type FauxSpecAttempt = ToolCall["arguments"];

/**
 * The `spec` call the faux script makes next, or `undefined` when it is done specifying (LOB-238).
 *
 * Only a run offered the tool specs, and only until one attempt is accepted. A run whose prompt has
 * no task thread yet tries the attempts in order, one per refusal, so a first attempt without `gaps`
 * is the model that forgot the field and the next is its retry. A run whose prompt carries the thread
 * — the run after a person answered — declares the last attempt with its gaps closed (`gaps` and
 * `openQuestions` empty), once: the answer is what closed them.
 */
const nextSpecAttempt = (
  messages: readonly Message[],
  attempts: readonly FauxSpecAttempt[],
): FauxSpecAttempt | undefined => {
  if (attempts.length === 0 || !offersTool(messages, SPEC_TOOL))
    return undefined;
  const results = toolResultErrors(messages, SPEC_TOOL);
  if (results.some((isError) => !isError)) return undefined;
  if (sectionInEffect(messages, THREAD_SECTION_KEY)) {
    const last = attempts.at(-1);
    return results.length > 0 || last === undefined
      ? undefined
      : { ...last, gaps: [], openQuestions: [] };
  }
  return attempts[results.length];
};

/**
 * The `review` call the faux script makes next, or `undefined` when it is done reviewing (LOB-36):
 * only a run offered the tool reviews, it tries the attempts in order — one per refusal, so a first
 * attempt the rubric refuses is the model that got it wrong and the next is its retry — and it stops
 * at the first accepted one. Counted per turn, so a second message makes it review again.
 */
const nextReviewAttempt = (
  messages: readonly Message[],
  attempts: readonly FauxSpecAttempt[],
): FauxSpecAttempt | undefined => {
  if (attempts.length === 0 || !offersTool(messages, REVIEW_TOOL))
    return undefined;
  // Per turn: a reviewer told something new reviews again, which is what the tool's one-review rule
  // has to refuse.
  const results = toolResultErrors(sinceLastUser(messages), REVIEW_TOOL);
  if (results.some((isError) => !isError)) return undefined;
  return attempts[results.length];
};

/** The user's newest message, flattened. */
const lastUserText = (messages: readonly Message[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === "user") {
      return typeof message.content === "string"
        ? message.content
        : message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("");
    }
  }
  return "";
};

/** The messages after the user's newest one: what the current turn has done so far. */
const sinceLastUser = (messages: readonly Message[]): readonly Message[] => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages.slice(index + 1);
  }
  return messages;
};

/** Whether a system message in the transcript offered `toolName` to the model. */
const offersTool = (messages: readonly Message[], toolName: string): boolean =>
  messages.some(
    (message) =>
      message.role === "system" &&
      (message.toolsAdded ?? []).some((tool) => tool.name === toolName),
  );

/**
 * Whether the prompt section `key` is in effect, folded the way the transcript folds sections: a
 * later system message replaces a section by name, and a `null` removes it.
 */
const sectionInEffect = (
  messages: readonly Message[],
  key: string,
): boolean => {
  let shown = false;
  for (const message of messages) {
    if (message.role !== "system" || message.sections === undefined) continue;
    if (key in message.sections) shown = message.sections[key] !== null;
  }
  return shown;
};

/** How a compaction task opens the conversation it wants summarized. */
const SUMMARY_PROMPT_PREFIX = "<conversation>";

/**
 * How a curator prompt opens (LOB-206, `curate.ts`), so the scripted model can tell a curation from
 * a turn. It lives here, beside the other marker a scripted answer reads, because the faux script is
 * what has to recognize it: the module that writes the prompt imports this one, never the reverse.
 */
export const CURATION_PROMPT_PREFIX = "<curate>";

/**
 * What the scripted model answers to a curation prompt: one page per tool the rendered transcript
 * shows a result from, named after it, and an empty array when the session ran no tool at all.
 *
 * Derived from the prompt rather than queued, for the reason `fauxAnswer` is: a session that taught
 * nothing (no tool ran) has to be able to answer "nothing" without a second script, and a curation
 * that proposes is what the transcript says it learned. `fauxCuration` scripts the answer when a
 * suite has to make a different one happen — three proposals, or an unreadable body.
 */
const derivedCurationAnswer = (prompt: string): AssistantMessage => {
  const tools = new Set<string>();
  for (const line of prompt.split("\n")) {
    const match = /^toolResult (\S+):/.exec(line);
    if (match?.[1] !== undefined) tools.add(match[1]);
  }
  return fauxAssistantMessage(
    JSON.stringify(
      [...tools].map((tool) => ({
        name: `${tool}-ran`,
        kind: "trap",
        content: `the session ran ${tool}`,
        links: [],
        sources: [],
      })),
    ),
  );
};

/**
 * How a decomposition prompt opens (LOB-201, `decompose.ts`), so the scripted model can tell a
 * decomposition from a turn and from a curation. Here for the reason `CURATION_PROMPT_PREFIX` is.
 */
export const DECOMPOSITION_PROMPT_PREFIX = "<decompose>";

/**
 * The prompt's headings the derived answer reads the spec back from. `decompose.ts` writes them, and
 * each value on one line, which is what lets a line-by-line read recover them.
 */
export const DECOMPOSITION_GOAL_HEADING = "## goal";
export const DECOMPOSITION_ACCEPTANCE_HEADING = "## acceptance";

/**
 * What the scripted model answers to a decomposition prompt: one proposal per acceptance criterion
 * of the spec the prompt carries, titled by the criterion, with the spec's goal as its goal and the
 * criterion as its acceptance line — folded, where one proposal per criterion would break the rules
 * (a repeated criterion, or more than `MAX_PROPOSALS`), into a proposal already made. No edges: the derived answer cannot know an order, and an
 * edge it made up would be exactly the unreal ordering the decomposition is told not to declare.
 *
 * Derived rather than queued, as the curation answer is, so a drive needs no script to decompose;
 * `fauxDecomposition` scripts the answer verbatim when a suite has to make a refusal happen.
 */
const derivedDecompositionAnswer = (prompt: string): AssistantMessage => {
  let section = "";
  let goal = "";
  const acceptance: string[] = [];
  for (const line of prompt.split("\n")) {
    if (line.startsWith("## ")) {
      section = line.trim();
      continue;
    }
    if (section === DECOMPOSITION_GOAL_HEADING && line.trim() !== "") {
      goal = line.trim();
    }
    if (section === DECOMPOSITION_ACCEPTANCE_HEADING && line.startsWith("- ")) {
      acceptance.push(line.slice(2).trim());
    }
  }
  // The set the validator would accept: a criterion whose title another already has (compared as
  // the validator compares titles) joins that proposal's acceptance lines, and past
  // `MAX_PROPOSALS` every further criterion joins the last proposal's. Each criterion is still some
  // proposal's acceptance line, and no spec the decomposition accepts is refused for its size.
  const proposals: {
    title: string;
    goal: string;
    change: string;
    acceptance: string[];
    blockedBy: number[];
  }[] = [];
  const byTitle = new Map<string, number>();
  for (const criterion of acceptance) {
    const key = criterion.replaceAll(/\s+/g, " ").trim().toLowerCase();
    const into =
      byTitle.get(key) ??
      (proposals.length >= MAX_PROPOSALS ? proposals.length - 1 : undefined);
    const existing = into === undefined ? undefined : proposals[into];
    if (existing !== undefined) {
      existing.acceptance.push(criterion);
      continue;
    }
    byTitle.set(key, proposals.length);
    proposals.push({
      title: criterion,
      goal,
      change: `Make this hold: ${criterion}`,
      acceptance: [criterion],
      blockedBy: [],
    });
  }
  return fauxAssistantMessage(JSON.stringify({ proposals }));
};

/**
 * How a plan-freshness prompt opens (LOB-45, `planFreshness.ts`), so the scripted model can tell the
 * pass from a turn, a curation and a decomposition. The goal and acceptance headings are the
 * decomposition's; the issues follow under their own heading, one JSON object per line.
 */
export const PLAN_PROMPT_PREFIX = "<plan-freshness>";
export const PLAN_ISSUES_HEADING = "## tracker issues";

/**
 * What the scripted model answers to a plan-freshness prompt: an `add` for each acceptance criterion
 * no tracker issue is titled by, and a `close` for each open issue whose title is no criterion — the
 * plan read the way a literal-minded agent would read it. Capped at `MAX_PLAN_PROPOSALS`, so the
 * derived answer is always one the validator accepts. Derived rather than queued, as the
 * decomposition's is; `fauxPlanFreshness` scripts it verbatim when a suite needs a refusal.
 */
const derivedPlanAnswer = (prompt: string): AssistantMessage => {
  let section = "";
  let goal = "";
  const acceptance: string[] = [];
  const issues: { issue: string; title: string; closed: boolean }[] = [];
  for (const line of prompt.split("\n")) {
    if (line.startsWith("## ")) {
      section = line.trim();
      continue;
    }
    if (section === DECOMPOSITION_GOAL_HEADING && line.trim() !== "") {
      goal = line.trim();
    }
    if (section === DECOMPOSITION_ACCEPTANCE_HEADING && line.startsWith("- ")) {
      acceptance.push(line.slice(2).trim());
    }
    if (section === PLAN_ISSUES_HEADING && line.startsWith("- {")) {
      const parsed = Option.getOrUndefined(
        Schema.decodeOption(
          Schema.fromJsonString(
            Schema.Struct({
              issue: Schema.String,
              title: Schema.String,
              closed: Schema.Boolean,
            }),
          ),
        )(line.slice(2)),
      );
      if (parsed !== undefined) issues.push(parsed);
    }
  }
  const titled = new Set(issues.map((issue) => titleKey(issue.title)));
  const wanted = new Set(acceptance.map(titleKey));
  const proposals: unknown[] = [];
  const added = new Set<string>();
  for (const criterion of acceptance) {
    const key = titleKey(criterion);
    if (titled.has(key) || added.has(key)) continue;
    added.add(key);
    proposals.push({
      kind: "add",
      title: criterion,
      goal,
      change: `Make this hold: ${criterion}`,
      acceptance: [criterion],
    });
  }
  for (const issue of issues) {
    if (issue.closed || wanted.has(titleKey(issue.title))) continue;
    proposals.push({
      kind: "close",
      issue: issue.issue,
      reason: "no acceptance criterion of the spec asks for it",
    });
  }
  return fauxAssistantMessage(
    JSON.stringify({ proposals: proposals.slice(0, MAX_PLAN_PROPOSALS) }),
  );
};

/**
 * The answer a faux session gives, derived from its own transcript rather than from a queue: the
 * first turn calls `bash`, every later turn replies with exactly what that command printed. Two
 * steps, repeatable for the life of a session, and it exercises the tool path a real turn uses.
 *
 * `command` is scriptable so a verification run can hold a turn open deliberately with a command
 * that sleeps (`FAUX_COMMAND`). The other way to hold one open is the sleeping script, which naps
 * before each step rather than in the tool (`fauxSleepMs`, applied by `createFauxModelAccess`:
 * this function stays a pure reading of the transcript).
 *
 * `verify` adds a step between the two (LOB-78): after the `bash` result the script calls the
 * `verify` tool, and the reply is what that tool reported — the shape of a run that makes a change,
 * verifies it, and says what the verification found.
 *
 * `everyTurn` makes every turn call `bash`, not only the first (LOB-52): the shape of an agent that
 * retries a call it was blocked on once it is told to go ahead, which is how a gated call is driven
 * past its approval.
 *
 * `ask` adds the parked run (LOB-73): after the `bash` result, a run that was offered the `ask` tool
 * and whose prompt carries no task thread yet asks `ask`, verbatim. The tool ends the run, so there
 * is no reply. A run whose prompt *does* carry the thread — the run after a person answered — does
 * not ask again and replies as usual, which is how one script plays both runs of the story.
 *
 * `spec` adds the specifier's declaration before the ask (LOB-238): a run offered the `spec` tool
 * calls it with the scripted attempts until one is accepted (`nextSpecAttempt`), and only then asks
 * — a run declares what it is missing before it asks a person for it.
 *
 * `review` is the reviewer's verdict (LOB-36), in the same place: after the `bash` turn that read the
 * diff, a run offered the `review` tool calls it with the scripted attempts until one is accepted
 * (`nextReviewAttempt`).
 */
export const fauxAnswer = (
  messages: readonly Message[],
  command: string = FAUX_COMMAND,
  curation?: string,
  verify = false,
  ask?: string,
  everyTurn = false,
  spec: readonly FauxSpecAttempt[] = [],
  decomposition?: string,
  review: readonly FauxSpecAttempt[] = [],
  plan?: string,
): AssistantMessage => {
  // A compaction asks for a summary of a transcript rather than for a turn: it has to answer with
  // text, because a tool call there fails the compaction and the run that waited for it.
  if (lastUserText(messages).trimStart().startsWith(SUMMARY_PROMPT_PREFIX)) {
    return fauxAssistantMessage(
      "Summary: the session ran its tools and kept working.",
    );
  }
  if (lastUserText(messages).trimStart().startsWith(CURATION_PROMPT_PREFIX)) {
    // A scripted answer is what the model "proposes", verbatim — a suite that has to make the cap
    // or an unreadable answer happen says so here rather than by editing the prompt.
    return curation === undefined
      ? derivedCurationAnswer(lastUserText(messages))
      : fauxAssistantMessage(curation);
  }
  if (
    lastUserText(messages).trimStart().startsWith(DECOMPOSITION_PROMPT_PREFIX)
  ) {
    return decomposition === undefined
      ? derivedDecompositionAnswer(lastUserText(messages))
      : fauxAssistantMessage(decomposition);
  }
  if (lastUserText(messages).trimStart().startsWith(PLAN_PROMPT_PREFIX)) {
    return plan === undefined
      ? derivedPlanAnswer(lastUserText(messages))
      : fauxAssistantMessage(plan);
  }
  const turn = everyTurn ? sinceLastUser(messages) : messages;
  const output = toolResultText(turn, "bash");
  if (output === undefined) {
    // `toolUse` is what a real provider reports for a tool-calling answer; without it the
    // generation treats the call as a final answer and never runs the tool.
    return fauxAssistantMessage(fauxToolCall("bash", { command }), {
      stopReason: "toolUse",
    });
  }
  const verified = verify ? toolResultText(turn, VERIFY_TOOL) : undefined;
  if (verify && verified === undefined) {
    return fauxAssistantMessage(fauxToolCall(VERIFY_TOOL, {}), {
      stopReason: "toolUse",
    });
  }
  const specAttempt = nextSpecAttempt(messages, spec);
  if (specAttempt !== undefined) {
    return fauxAssistantMessage(fauxToolCall(SPEC_TOOL, specAttempt), {
      stopReason: "toolUse",
    });
  }
  const reviewAttempt = nextReviewAttempt(messages, review);
  if (reviewAttempt !== undefined) {
    return fauxAssistantMessage(fauxToolCall(REVIEW_TOOL, reviewAttempt), {
      stopReason: "toolUse",
    });
  }
  if (
    ask !== undefined &&
    offersTool(messages, ASK_TOOL) &&
    !sectionInEffect(messages, THREAD_SECTION_KEY) &&
    toolResultText(messages, ASK_TOOL) === undefined
  ) {
    return fauxAssistantMessage(fauxToolCall(ASK_TOOL, { question: ask }), {
      stopReason: "toolUse",
    });
  }
  return fauxAssistantMessage(
    `${(verified ?? output).trim()} (re: ${lastUserText(messages).trim()})`,
  );
};

/**
 * Whether a request asks the script for a step of a turn, rather than for a compaction's summary or
 * a curation or a decomposition: the only requests the sleeping script (`fauxSleepMs`) is slow to
 * answer. A summary that slept would hold a compaction rather than a run, and a curation or a
 * decomposition is not a turn at all.
 */
export const isFauxTurnStep = (messages: readonly Message[]): boolean => {
  const text = lastUserText(messages).trimStart();
  return (
    !text.startsWith(SUMMARY_PROMPT_PREFIX) &&
    !text.startsWith(CURATION_PROMPT_PREFIX) &&
    !text.startsWith(DECOMPOSITION_PROMPT_PREFIX) &&
    !text.startsWith(PLAN_PROMPT_PREFIX)
  );
};

/**
 * Wait `ms`, or less when `signal` aborts first. The sleeping script's nap is the model "thinking",
 * so an interrupted run must stop waiting the moment it is interrupted, as a real provider's
 * request would — not wait out the nap and then report the abort. The abort interrupts the sleep,
 * which ends the nap rather than failing it: the provider sees the signal and answers `aborted`.
 */
const fauxNap = (ms: number, signal?: AbortSignal): Promise<void> =>
  Effect.runPromiseExit(Effect.sleep(ms), { signal }).then(() => undefined);

export type ModelAccessOptions = {
  /** The command the faux script runs, for a run that needs a turn to take a known time. */
  readonly fauxCommand?: string | undefined;
  /**
   * How long the sleeping faux script takes over each step of a turn, in milliseconds (LOB-167):
   * the model "thinks" before it calls `bash` and again before it answers, so a run is genuinely
   * busy for about twice this long without scripting a slow command. That is what lets a second
   * message arrive while the run is in flight — a steer that joins it, a follow-up that queues
   * behind it, a `whenBusy: "reject"` that is refused with `busy` — whatever the tool policy does
   * with the command. Absent or `0`: the script answers at once.
   */
  readonly fauxSleepMs?: number | undefined;
  /** Whether the faux script calls `verify` after its `bash` turn (LOB-78, `fauxAnswer`). */
  readonly fauxVerify?: boolean | undefined;
  /** Whether the faux script calls `bash` on every turn rather than the first (LOB-52, `fauxAnswer`). */
  readonly fauxEveryTurn?: boolean | undefined;
  /**
   * The question the faux script asks with the `ask` tool after its `bash` turn (LOB-73,
   * `fauxAnswer`), when the run was offered the tool and carries no task thread. Absent: never asks.
   */
  readonly fauxAsk?: string | undefined;
  /**
   * The `spec` calls the faux script makes, in order, when the run was offered the tool (LOB-238,
   * `fauxAnswer`): each is the tool's arguments verbatim, and the next is sent only when the one
   * before it was refused. Absent or empty: never specs.
   */
  readonly fauxSpec?: readonly FauxSpecAttempt[] | undefined;
  /**
   * The `review` calls the faux script makes, in order, when the run was offered the tool (LOB-36,
   * `fauxAnswer`): each is the tool's arguments verbatim, and the next is sent only when the one
   * before it was refused. Absent or empty: never reviews.
   */
  readonly fauxReview?: readonly FauxSpecAttempt[] | undefined;
  /**
   * The body a scripted model answers a curation prompt with (LOB-206), verbatim: what the curator
   * "proposes". Absent, the faux derives one page per tool the transcript shows a result from.
   */
  readonly fauxCuration?: string | undefined;
  /**
   * The body a scripted model answers a decomposition prompt with (LOB-201), verbatim: what the
   * decomposition "proposes". Absent, the faux derives one proposal per acceptance criterion of the
   * spec the prompt carries.
   */
  readonly fauxDecomposition?: string | undefined;
  /**
   * The body a scripted model answers a plan-freshness prompt with (LOB-45), verbatim. Absent, the
   * faux derives an `add` per criterion no issue is titled by and a `close` per open issue no
   * criterion names.
   */
  readonly fauxPlanFreshness?: string | undefined;
  /**
   * The context window the faux model is published with (pi-ai's default is 128k). Lowering it is
   * how a test drives a session past a compaction threshold without a 100k-token transcript.
   */
  readonly contextWindow?: number | undefined;
  /**
   * Extra model ids the faux provider publishes, beyond its own default. The first is the one a
   * session opens on, so passing any changes which model the process serves by default.
   *
   * Only the faux backend needs this, and it needs it because one id cannot show a replay onto a
   * *different* model (LOB-198): the real backends register a whole catalog, so `modelAccessFor`
   * finds a second model there without an option.
   */
  readonly fauxModels?: readonly string[] | undefined;
  /**
   * What every faux request costs, in US dollars (LOB-163). pi-ai's faux provider reports a cost of
   * zero whatever its model is priced at, so a session on it never spends and a budget cap could
   * never be reached; this charges each answer a flat amount, which lands in `pi.usage` the way a
   * real provider's cost does. Absent or `0`: free, as before.
   */
  readonly fauxCost?: number | undefined;
  /**
   * A script per published faux model id, overriding `fauxCommand` and `fauxVerify` for a request
   * made under that model (LOB-86). Under the faux backend a model *is* its script, so a role that
   * runs another model (`ROLE_MODELS`, LOB-207) is how one process plays two kinds of run: a
   * read-only specifier whose command only sleeps and prints, and a builder whose command writes
   * and commits a change and then verifies it. A model with no entry runs the process's script.
   */
  readonly fauxModelScripts?: FauxModelScripts | undefined;
  /**
   * Where the real provider reads its credentials from (LOB-258). Absent: pi-ai's default, which
   * reads `process.env` and treats an empty or whitespace-only value as unset. A test passes its own
   * so it can say which variables are set without touching the process's environment.
   */
  readonly authContext?: AuthContext | undefined;
};

/** What one faux model's script does differently from the process's (`fauxModelScripts`). */
export type FauxScript = {
  /** The command its first turn calls `bash` with, instead of `fauxCommand`. */
  readonly command?: string | undefined;
  /** Whether it calls `verify` after its `bash` turn, instead of `fauxVerify`. */
  readonly verify?: boolean | undefined;
};

/** Faux model id → its script. */
export type FauxModelScripts = ReadonlyMap<string, FauxScript>;

/** `FAUX_MODEL_SCRIPTS` is not a script table, or names a model the faux backend does not publish. */
export class InvalidFauxModelScripts extends Schema.TaggedError<InvalidFauxModelScripts>()(
  "InvalidFauxModelScripts",
  { message: Schema.String },
) {}

/** The table as a deployment writes it: a JSON object of model id → `{command?, verify?}`. */
const FauxModelScriptsJson = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      command: Schema.optional(Schema.NonEmptyString),
      verify: Schema.optional(Schema.Boolean),
    }),
  ),
);

/**
 * Read the faux script table (`FAUX_MODEL_SCRIPTS`) against the model ids the faux backend
 * publishes. Blank is an empty table. Anything that does not decode, or a row for a model nobody
 * can run, fails the boot rather than being ignored: a script keyed by a typo would leave the run
 * it was meant for on the process's script, and the verification that relied on it would prove
 * the wrong run.
 */
export const parseFauxModelScripts = (
  text: string,
  published: readonly string[],
): Effect.Effect<FauxModelScripts, InvalidFauxModelScripts> =>
  Effect.gen(function* () {
    if (text.trim().length === 0) return new Map();
    // A misspelt field (`verfy`) is as much a typo as a misspelt model id: it must fail, not be
    // stripped, or the row it was meant for runs without it.
    const table = yield* Schema.decodeEffect(FauxModelScriptsJson)(text, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new InvalidFauxModelScripts({
            message: `faux model scripts are not a {"<model>": {"command"?, "verify"?}} object: ${cause.message}`,
          }),
      ),
    );
    const scripts = new Map<string, FauxScript>();
    for (const [model, script] of Object.entries(table)) {
      if (!published.includes(model)) {
        return yield* new InvalidFauxModelScripts({
          message: `faux model script for ${model}, which the faux backend does not publish (it publishes ${published.join(", ")})`,
        });
      }
      scripts.set(model, script);
    }
    return scripts;
  });

/** An answer with `amount` added to what it cost, as a provider reports its own price. */
const charge = (
  message: AssistantMessage,
  amount: number,
): AssistantMessage => ({
  ...message,
  usage: {
    ...message.usage,
    cost: {
      ...message.usage.cost,
      output: message.usage.cost.output + amount,
      total: message.usage.cost.total + amount,
    },
  },
});

/**
 * The same stream of events, with the finished answer charged `amount`. Only a finished answer is
 * charged: an error or an aborted request is not one a provider bills for here.
 */
const charged = (
  inner: AssistantMessageEventStream,
  amount: number,
): AssistantMessageEventStream => {
  const outer = createAssistantMessageEventStream();
  const events = inner[Symbol.asyncIterator]();
  const pump = (): Promise<void> =>
    events.next().then((step) => {
      if (step.done === true) {
        return inner.result().then((message) => outer.end(message));
      }
      const event = step.value;
      outer.push(
        event.type === "done"
          ? { ...event, message: charge(event.message, amount) }
          : event,
      );
      return pump();
    });
  pump().catch(() => outer.end());
  return outer;
};

/** A provider whose every finished answer costs `amount` more than the provider says (`fauxCost`). */
const pricedProvider = (provider: Provider, amount: number): Provider => ({
  ...provider,
  stream: (model, context, options) =>
    charged(provider.stream(model, context, options), amount),
  streamSimple: (model, context, options) =>
    charged(provider.streamSimple(model, context, options), amount),
});

/** What the provider's catalog says this model's window is, or `0` when it says nothing. */
const windowOf = (models: Models, provider: string, modelId: string): number =>
  models.getModel(provider, modelId)?.contextWindow ?? 0;

/** How a model is named wherever one names another one: `provider/modelId`. */
export const modelKey = (access: ModelAccess): string =>
  `${access.provider}/${access.modelId}`;

/**
 * Every model the access's catalog serves, as `provider/modelId`, sorted (LOB-269): what a replay
 * or a role row may name (`modelAccessFor` resolves against the same registry). Under faux it is
 * the ids the process was booted with; under anthropic, pi-ai's published catalog.
 */
export const catalogModels = (access: ModelAccess): readonly string[] =>
  [
    ...new Set(
      access.models.getModels().map((model) => `${model.provider}/${model.id}`),
    ),
  ].sort();

/**
 * The same access, resolved onto another model of the registry it already holds.
 *
 * A session is given one `ModelAccess` when it opens, which is what pins it to a model; a replay
 * (LOB-198) is the one caller that needs a *different* one for a single session. The registry is the
 * catalog the access was built with, so resolving `provider/modelId` against it is the same lookup
 * the access itself did at boot — and `undefined`, not a substitute, when the catalog has no such
 * model: a replay onto a model the process cannot serve is a refusal, not a silent downgrade.
 */
export const modelAccessFor = (
  access: ModelAccess,
  key: string,
): ModelAccess | undefined => {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return undefined;
  const provider = key.slice(0, slash);
  const modelId = key.slice(slash + 1);
  if (access.models.getModel(provider, modelId) === undefined) return undefined;
  return {
    ...access,
    provider,
    modelId,
    contextWindow: windowOf(access.models, provider, modelId),
  };
};

/** `DEFAULT_MODEL` names a model this process cannot serve, or is not `provider/modelId`. */
export class InvalidDefaultModel extends Schema.TaggedError<InvalidDefaultModel>()(
  "InvalidDefaultModel",
  { message: Schema.String },
) {}

/**
 * The deployment's default model (LOB-274, `DEFAULT_MODEL`): `backend` resolved onto `key` with the
 * lookup a replay and a role row do (`modelAccessFor`), so a deployment changes the model every
 * session with no role row and no model of its own runs without a code change. Blank: the backend's
 * own model (`DEFAULT_ANTHROPIC_MODEL`, or the faux `FAUX_MODEL_ID`). A key the catalog does not
 * hold — another backend's model, a typo, no `/` — fails the boot rather than every session.
 */
export const resolveDefaultModel = (
  backend: ModelAccess,
  key: string,
): Effect.Effect<ModelAccess, InvalidDefaultModel> => {
  const trimmed = key.trim();
  if (trimmed.length === 0) return Effect.succeed(backend);
  const access = modelAccessFor(backend, trimmed);
  return access === undefined
    ? Effect.fail(
        new InvalidDefaultModel({
          message: `DEFAULT_MODEL names model ${trimmed}, which this process does not serve on the ${backend.backend} backend (provider/modelId, one of getServerInfo's models)`,
        }),
      )
    : Effect.succeed(access);
};

/** A faux access and the provider that served it, so a caller can ask what it was asked. */
export type FauxModelAccess = {
  readonly access: ModelAccess;
  /**
   * The scripted provider. Its `state.callCount` is how many requests the access has served, which
   * is what a test asserts "exactly one call" against (LOB-206) rather than trusting the caller.
   */
  readonly faux: FauxProviderHandle;
};

/**
 * The faux backend, with its handle returned: `createModelAccess("faux")` is this, minus the handle.
 *
 * The handle is the only witness a suite has for how many model calls a step made — a count reported
 * by the step itself would be the step grading its own work — so it is part of the access's
 * construction rather than a test-only back door into the closure.
 */
export const createFauxModelAccess = (
  options: ModelAccessOptions = {},
): FauxModelAccess => {
  const models = createModels();
  const fauxCommand = options.fauxCommand ?? FAUX_COMMAND;
  const window =
    options.contextWindow === undefined
      ? {}
      : { contextWindow: options.contextWindow };
  const faux = fauxProvider({
    models: (options.fauxModels?.length
      ? options.fauxModels
      : [FAUX_MODEL_ID]
    ).map((id) => ({ id, ...window })),
  });
  models.setProvider(
    options.fauxCost === undefined || options.fauxCost === 0
      ? faux.provider
      : pricedProvider(faux.provider, options.fauxCost),
  );
  const sleepMs = options.fauxSleepMs ?? 0;
  // pi-ai consumes one queued step per request, so the script re-queues itself and never runs dry.
  // It re-queues before it sleeps: a request that arrives during the nap still finds a step.
  // A request carries the model it was made under, so a model's own script is looked up per
  // request rather than per process (`fauxModelScripts`).
  const repeat: FauxResponseFactory = (
    context,
    streamOptions,
    _state,
    model,
  ) => {
    faux.appendResponses([repeat]);
    const script = options.fauxModelScripts?.get(model.id);
    const answer = () =>
      fauxAnswer(
        context.messages,
        script?.command ?? fauxCommand,
        options.fauxCuration,
        script?.verify ?? options.fauxVerify ?? false,
        options.fauxAsk,
        options.fauxEveryTurn ?? false,
        options.fauxSpec ?? [],
        options.fauxDecomposition,
        options.fauxReview ?? [],
        options.fauxPlanFreshness,
      );
    return sleepMs > 0 && isFauxTurnStep(context.messages)
      ? fauxNap(sleepMs, streamOptions?.signal).then(answer)
      : answer();
  };
  faux.setResponses([repeat]);
  const modelId = faux.models[0].id;
  return {
    access: {
      backend: "faux",
      models,
      provider: "faux",
      modelId,
      contextWindow: windowOf(models, "faux", modelId),
      ...(options.fauxCost === undefined || options.fauxCost === 0
        ? {}
        : { flatCost: options.fauxCost }),
    },
    faux,
  };
};

export const createModelAccess = (
  backend: ModelBackend,
  options: ModelAccessOptions = {},
): ModelAccess => {
  if (backend === "faux") return createFauxModelAccess(options).access;
  const models = createModels(
    options.authContext === undefined
      ? undefined
      : { authContext: options.authContext },
  );
  models.setProvider(anthropicProvider());
  return {
    backend,
    models,
    provider: "anthropic",
    modelId: DEFAULT_ANTHROPIC_MODEL,
    contextWindow: windowOf(models, "anthropic", DEFAULT_ANTHROPIC_MODEL),
  };
};

/**
 * The variables pi-ai's Anthropic provider authenticates from, in the order it tries them (LOB-258).
 *
 * Read from the installed pi-ai 1.0.3 (`providers/anthropic.js`): `ANTHROPIC_AUTH_TOKEN` is sent as
 * `Authorization: Bearer` to api.anthropic.com (no base URL is honoured), `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`
 * are sent as the key, and workload identity federation needs all three of its variables, with the
 * service account and workspace optional beside them. A stored credential would come first, but a
 * process here keeps none: its credential store is pi-ai's in-memory default, empty at boot.
 */
export const ANTHROPIC_AUTH_VARIABLES = {
  tokens: [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
  ],
  federation: [
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
  ],
  federationOptional: [
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
    "ANTHROPIC_WORKSPACE_ID",
  ],
} as const;

/** What authenticated a model access: a label naming its source, never the credential itself. */
export type ModelAuth = {
  /** pi-ai's label: the variable's name (`ANTHROPIC_API_KEY`) or the mode (`workload identity federation`). */
  readonly source: string;
  readonly type: "api_key" | "oauth";
};

/** pi-ai could not tell whether a provider has a credential (its credential store failed). */
export class ModelAuthCheckFailed extends Schema.TaggedError<ModelAuthCheckFailed>()(
  "ModelAuthCheckFailed",
  { provider: Schema.String, message: Schema.String },
) {}

/**
 * Whether an access's provider has a credential, by pi-ai's own resolution (`checkAuth`): the same
 * code a request authenticates through, so a backend chosen on it is one a request can use. `None`
 * when nothing resolves. No credential is refreshed, exchanged or sent anywhere.
 */
export const checkModelAuth = Effect.fn("Models.checkAuth")(function* (
  access: ModelAccess,
) {
  const check = yield* Effect.tryPromise({
    try: () => access.models.checkAuth(access.provider),
    catch: (cause) =>
      new ModelAuthCheckFailed({
        provider: access.provider,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  return Option.map(Option.fromUndefinedOr(check), (found): ModelAuth => ({
    source: found.source ?? access.provider,
    type: found.type,
  }));
});

/** The largest share of the window one of pi-durable's thresholds may take. */
const WINDOW_SHARE = 0.25;

/**
 * The compaction thresholds for one model's window (B4).
 *
 * pi-durable's `DEFAULT_COMPACTION_POLICY` assumes a window of a few hundred thousand tokens: an
 * answer reserve of 16k, 20k of recent context kept verbatim, and 32k of background room are
 * proportions of such a window and nonsense beside a small one. With a 4k window the reserve alone
 * is bigger than the window, so the blocking threshold is negative — every request is over it —
 * while the 20k tail the policy keeps is longer than the whole transcript, so range selection finds
 * nothing to summarize and the session never compacts at all.
 *
 * Each threshold is therefore capped by a quarter of the window and never grows past the pinned
 * default: a large model keeps today's behaviour to the token, and a small one gets thresholds it
 * can reach. Background compaction — summarizing ahead of a request rather than blocking on it —
 * is only worth having when a quarter of the window is still room to work in, so it is off below
 * that.
 */
export const compactionPolicyFor = (
  contextWindow: number,
): CompactionPolicy => {
  if (contextWindow <= 0) {
    // Nothing to derive from: the package's own defaults are the only honest answer.
    return { ...DEFAULT_COMPACTION_POLICY };
  }
  const share = Math.floor(contextWindow * WINDOW_SHARE);
  return {
    enabled: DEFAULT_COMPACTION_POLICY.enabled,
    reserveTokens: Math.min(DEFAULT_COMPACTION_POLICY.reserveTokens, share),
    keepRecentTokens: Math.min(
      DEFAULT_COMPACTION_POLICY.keepRecentTokens,
      share,
    ),
    backgroundTokens:
      contextWindow >= 4 * DEFAULT_COMPACTION_POLICY.reserveTokens
        ? Math.min(DEFAULT_COMPACTION_POLICY.backgroundTokens, share)
        : 0,
  };
};
