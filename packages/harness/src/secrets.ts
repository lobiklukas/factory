/**
 * Secrets in a session's commands (S-agent-secrets): the values the control plane injects into the
 * repository's own declared commands — the setup's `install` and `build`, the `verify` tool's runs —
 * and the masking that keeps every one of them out of the log.
 *
 * **Injected per command, never into the shell.** A secret reaches a command as one more variable of
 * that command's own environment (`./verify`'s `execToExit`), so the agent's `bash` — which gets the
 * session's environment and nothing else (`sessionShellEnv`) — never holds it, and `env` in it never
 * shows it.
 *
 * **Masked before it is committed.** Whatever an injected command prints passes through a masker
 * before it reaches anything that is written down: the running tool output a person watches, the
 * output tail a verify or setup record keeps, and the excerpt a PR body quotes all start from that
 * stream, so each holds `[secret:NAME]` where the value was. A value split across two chunks is
 * still masked: the masker holds back the end of a chunk while it could be the start of a value, and
 * lets it go once the next chunk (or the end of the command) says it is not. Beside that, a session
 * given any value masks every command its tools run (`maskingEnv`, the agent's `bash` too, so its
 * running output is masked before a progress commit) and every tool's settled result
 * (`secretMaskExtension`, an `afterTool` hook), so a value the agent came to hold some other way —
 * a file an injected command wrote — is not committed by any tool either.
 *
 * What masking is not: a defence against code that means to leak. The repository's commands are
 * code the agent's branch can change, and a command that prints a value reversed or encoded prints
 * something no literal match recognizes. The push's secret scan (`@repo/core`'s `secretScan`) is the
 * second guard, for the value that reaches a commit.
 */
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { secretPlaceholder } from "@repo/domain/Secret";
import { Redacted } from "effect";

/** One value the control plane injects into a command: the variable it is read as, and the value. */
export type InjectedSecret = {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
};

/** The values one command, or one session, is given. */
export type InjectedSecrets = ReadonlyArray<InjectedSecret>;

/** The extension `secretMaskExtension` installs; one per session that was given any value. */
export const SECRET_MASK_EXTENSION = "factory.secrets";

type Plain = { readonly placeholder: string; readonly value: string };

/**
 * The values to mask, longest first, so a value that contains another is replaced whole rather than
 * around the shorter one. An empty value masks nothing (the store refuses one; this does not trust it).
 */
const plainOf = (secrets: InjectedSecrets): ReadonlyArray<Plain> =>
  secrets
    .map((secret) => ({
      placeholder: secretPlaceholder(secret.name),
      value: Redacted.value(secret.value),
    }))
    .filter((secret) => secret.value !== "")
    .sort((a, b) => b.value.length - a.value.length);

const maskPlain = (text: string, plain: ReadonlyArray<Plain>): string =>
  plain.reduce(
    (masked, secret) =>
      masked.includes(secret.value)
        ? masked.split(secret.value).join(secret.placeholder)
        : masked,
    text,
  );

/** `text` with every injected value replaced by its placeholder. */
export const maskSecrets = (text: string, secrets: InjectedSecrets): string =>
  secrets.length === 0 ? text : maskPlain(text, plainOf(secrets));

/** The variables a command is given for `secrets`: each value under its name. */
export const secretVariables = (
  secrets: InjectedSecrets,
): Record<string, string> =>
  Object.fromEntries(
    secrets.map((secret) => [secret.name, Redacted.value(secret.value)]),
  );

/**
 * A masker for one output stream: `push` answers the part of what has arrived that is safe to pass
 * on, masked, and `flush` the rest once the stream has ended.
 *
 * What it holds back is the longest end of the masked text that is the start of some value — never
 * more than the longest value less one character — so a value split across chunks meets the next
 * chunk whole, and output that is no value's start passes at once.
 */
export const secretMasker = (
  secrets: InjectedSecrets,
): {
  readonly push: (chunk: string) => string;
  readonly flush: () => string;
} => {
  const plain = plainOf(secrets);
  if (plain.length === 0) return { push: (chunk) => chunk, flush: () => "" };
  const longest = plain[0]?.value.length ?? 0;
  let pending = "";
  return {
    push: (chunk) => {
      const masked = maskPlain(pending + chunk, plain);
      let hold = Math.min(longest - 1, masked.length);
      while (
        hold > 0 &&
        !plain.some((secret) => secret.value.startsWith(masked.slice(-hold)))
      ) {
        hold -= 1;
      }
      pending = hold === 0 ? "" : masked.slice(-hold);
      return hold === 0 ? masked : masked.slice(0, -hold);
    },
    flush: () => {
      const rest = pending;
      pending = "";
      return rest;
    },
  };
};

/** Every string in a JSON value masked: a tool's `details` record, whatever its shape. */
export const maskJson = (
  value: JsonValue,
  secrets: InjectedSecrets,
): JsonValue => {
  if (secrets.length === 0) return value;
  const plain = plainOf(secrets);
  const walk = (node: JsonValue): JsonValue => {
    if (typeof node === "string") return maskPlain(node, plain);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => [key, walk(child)]),
      );
    }
    return node;
  };
  return walk(value);
};

/** A settled tool result with every injected value masked in its text content and its details. */
export const maskToolResult = (
  result: ToolExecutionResult,
  secrets: InjectedSecrets,
): ToolExecutionResult => {
  if (secrets.length === 0) return result;
  return {
    ...result,
    ...(result.content === undefined
      ? {}
      : {
          content: result.content.map((part) =>
            part.type === "text"
              ? { ...part, text: maskSecrets(part.text, secrets) }
              : part,
          ),
        }),
    ...(result.details === undefined
      ? {}
      : { details: maskJson(result.details, secrets) }),
  };
};

/**
 * The hook that masks every tool's settled result before Pi Durable appends it to the log: the
 * second guard beside the masking at the source (the module doc). Installed at `openSession` for a
 * session that was given any value; a session given none installs nothing.
 */
export const secretMaskExtension = (secrets: InjectedSecrets): Extension =>
  defineExtension({
    name: SECRET_MASK_EXTENSION,
    hooks: [
      hook(ToolTask, {
        afterTool: (_call, result) => maskToolResult(result, secrets),
      }),
    ],
  });

/**
 * `env` with every command's output masked before its caller sees it: the session's own environment,
 * as its tools and the control plane's setup get it, for a session given any value. Every other
 * operation is `env`'s own. A chunk after output the environment omitted (`info.skipped`) drops what
 * the masker held back, since it may be the start of a value whose end was omitted with it.
 */
export const maskingEnv = (
  env: ExecutionEnv,
  secrets: InjectedSecrets,
): ExecutionEnv => {
  if (secrets.length === 0) return env;
  const exec: ExecutionEnv["exec"] = async (command, options, context) => {
    const onOutput = options?.onOutput;
    if (onOutput === undefined) return env.exec(command, options, context);
    const maskers = {
      stdout: secretMasker(secrets),
      stderr: secretMasker(secrets),
    };
    try {
      return await env.exec(
        command,
        {
          ...options,
          onOutput: (text, chunkContext, info) => {
            const masker = maskers[info.stream];
            if (info.skipped !== undefined) masker.flush();
            const masked = masker.push(text);
            if (masked !== "") onOutput(masked, chunkContext, info);
          },
        },
        context,
      );
    } finally {
      for (const stream of ["stdout", "stderr"] as const) {
        const rest = maskers[stream].flush();
        if (rest !== "") onOutput(rest, context, { stream });
      }
    }
  };
  return new Proxy(env, {
    get: (target, property) => {
      if (property === "exec") return exec;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
