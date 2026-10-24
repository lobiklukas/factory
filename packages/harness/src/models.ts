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
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  DEFAULT_COMPACTION_POLICY,
  type CompactionPolicy,
} from "@earendil-works/pi-durable";

export type ModelBackend = "anthropic" | "faux";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

/**
 * The id pi-ai's faux provider publishes its model under, so a session can name it before the
 * provider is registered (`fauxProvider` defaults to it).
 */
const FAUX_MODEL_ID = "faux-1";

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

/** How a compaction task opens the conversation it wants summarized. */
const SUMMARY_PROMPT_PREFIX = "<conversation>";

/**
 * The answer a faux session gives, derived from its own transcript rather than from a queue: the
 * first turn calls `bash`, every later turn replies with exactly what that command printed. Two
 * steps, repeatable for the life of a session, and it exercises the tool path a real turn uses.
 *
 * `command` is scriptable so a verification run can hold a turn open deliberately — a command
 * that sleeps is the only way to observe a session that is genuinely busy (`FAUX_COMMAND`).
 */
export const fauxAnswer = (
  messages: readonly Message[],
  command: string = FAUX_COMMAND,
): AssistantMessage => {
  // A compaction asks for a summary of a transcript rather than for a turn: it has to answer with
  // text, because a tool call there fails the compaction and the run that waited for it.
  if (lastUserText(messages).trimStart().startsWith(SUMMARY_PROMPT_PREFIX)) {
    return fauxAssistantMessage(
      "Summary: the session ran its tools and kept working.",
    );
  }
  const output = toolResultText(messages, "bash");
  if (output === undefined) {
    // `toolUse` is what a real provider reports for a tool-calling answer; without it the
    // generation treats the call as a final answer and never runs the tool.
    return fauxAssistantMessage(fauxToolCall("bash", { command }), {
      stopReason: "toolUse",
    });
  }
  return fauxAssistantMessage(
    `${output.trim()} (re: ${lastUserText(messages).trim()})`,
  );
};

export type ModelAccessOptions = {
  /** The command the faux script runs, for a run that needs a turn to take a known time. */
  readonly fauxCommand?: string | undefined;
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
};

/** What the provider's catalog says this model's window is, or `0` when it says nothing. */
const windowOf = (models: Models, provider: string, modelId: string): number =>
  models.getModel(provider, modelId)?.contextWindow ?? 0;

/** How a model is named wherever one names another one: `provider/modelId`. */
export const modelKey = (access: ModelAccess): string =>
  `${access.provider}/${access.modelId}`;

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

export const createModelAccess = (
  backend: ModelBackend,
  options: ModelAccessOptions = {},
): ModelAccess => {
  const models = createModels();
  const fauxCommand = options.fauxCommand ?? FAUX_COMMAND;

  if (backend === "faux") {
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
    models.setProvider(faux.provider);
    // pi-ai consumes one queued step per request, so the script re-queues itself and never runs dry.
    const repeat: FauxResponseFactory = (context) => {
      faux.appendResponses([repeat]);
      return fauxAnswer(context.messages, fauxCommand);
    };
    faux.setResponses([repeat]);
    const modelId = faux.models[0].id;
    return {
      backend,
      models,
      provider: "faux",
      modelId,
      contextWindow: windowOf(models, "faux", modelId),
    };
  }

  models.setProvider(anthropicProvider());
  return {
    backend,
    models,
    provider: "anthropic",
    modelId: DEFAULT_ANTHROPIC_MODEL,
    contextWindow: windowOf(models, "anthropic", DEFAULT_ANTHROPIC_MODEL),
  };
};

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
