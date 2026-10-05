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

export type ModelBackend = "anthropic" | "faux";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

/** The command the faux script runs unless a caller scripts another one. */
export const FAUX_COMMAND = "echo faux-ok";

export type ModelAccess = {
  readonly backend: ModelBackend;
  readonly models: Models;
  /** Provider id and model id stored in a conversation's agent. */
  readonly provider: string;
  readonly modelId: string;
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
};

export const createModelAccess = (
  backend: ModelBackend,
  options: ModelAccessOptions = {},
): ModelAccess => {
  const models = createModels();
  const fauxCommand = options.fauxCommand ?? FAUX_COMMAND;

  if (backend === "faux") {
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    // pi-ai consumes one queued step per request, so the script re-queues itself and never runs dry.
    const repeat: FauxResponseFactory = (context) => {
      faux.appendResponses([repeat]);
      return fauxAnswer(context.messages, fauxCommand);
    };
    faux.setResponses([repeat]);
    return {
      backend,
      models,
      provider: "faux",
      modelId: faux.models[0].id,
    };
  }

  models.setProvider(anthropicProvider());
  return {
    backend,
    models,
    provider: "anthropic",
    modelId: DEFAULT_ANTHROPIC_MODEL,
  };
};
