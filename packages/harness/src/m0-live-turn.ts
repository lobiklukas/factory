/**
 * M0 — one live agent turn, end to end, locally.
 *
 * Proves the pieces the design depends on:
 *   - Pi Durable opens a Harness over storage with a local ExecutionEnv
 *   - a real model turn runs against the Anthropic provider
 *   - tool calls execute in NodeExecutionEnv and round-trip into the transcript
 *   - viewState() exposes what the control-plane read model needs (design D8)
 *   - harness.usage() returns the cost data attribution needs (design R4)
 *
 * Disposable: delete once M1/M2 replace it with real tests.
 *
 *   cp .env.example .env   # add ANTHROPIC_API_KEY
 *   bun run m0
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Config, Data, Effect, Option, Result } from "effect";

const PROMPT =
  "Use the bash tool to run `echo m0-ok`. Then reply with exactly the output of that command and nothing else.";

class M0Error extends Data.TaggedError("M0Error")<{
  readonly reason: string;
}> {}

/** Pi Durable is promise-based; every call crosses into Effect at this boundary. */
const attempt = <A>(thunk: () => Promise<A>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause: unknown): M0Error =>
      new M0Error({ reason: `pi-durable call failed: ${String(cause)}` }),
  });

/** Pull every `text` field out of a transcript entry without asserting a shape. */
const collectText = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, found);
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  const record = value as Record<string, unknown>;
  const text = record["text"];
  if (typeof text === "string") found.push(text);
  for (const item of Object.values(record)) collectText(item, found);
  return found;
};

/** Count nested objects whose `key` equals `value`, without asserting a shape. */
const collectField = (node: unknown, key: string, value: string): number => {
  if (Array.isArray(node)) {
    return node.reduce<number>(
      (total, item) => total + collectField(item, key, value),
      0,
    );
  }
  if (node === null || typeof node !== "object") return 0;
  const record = node as Record<string, unknown>;
  return Object.values(record).reduce<number>(
    (total, item) => total + collectField(item, key, value),
    record[key] === value ? 1 : 0,
  );
};

const program = Effect.gen(function* () {
  const apiKey = yield* Config.option(Config.String("ANTHROPIC_API_KEY"));
  if (Option.isNone(apiKey)) {
    return yield* new M0Error({
      reason:
        "ANTHROPIC_API_KEY is not set.\n\n  cp .env.example .env\n  bun run m0",
    });
  }

  const context = BACKGROUND_CONTEXT;

  const models = createModels();
  models.setProvider(anthropicProvider());

  const registry = createRegistry();
  registry.install(CodingTools);

  const env = ({ cwd }: { cwd?: string }) =>
    new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });

  const harness = yield* attempt(() =>
    Harness.open(new MemoryStorage(), { models, registry, env }, context),
  );

  const root = yield* attempt(() =>
    harness.root(context, {
      agent: {
        model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
        cwd: process.cwd(),
      },
    }),
  );

  yield* Effect.log("submitting turn");

  const submission = yield* attempt(() =>
    root.submit({ type: "input", content: PROMPT, requestId: "m0" }, context),
  );
  yield* attempt(() => submission.wait(context));

  const view = yield* attempt(() => root.viewState(context));
  const entries = view.value?.entries ?? [];

  yield* Effect.log(`transcript entries: ${entries.length}`);
  for (const entry of entries) {
    yield* Effect.log(`entry kind=${String(entry.kind)}`);
    const text = collectText(entry).join(" ").trim();
    if (text.length > 0) {
      yield* Effect.log(text.length > 300 ? `${text.slice(0, 300)}…` : text);
    }
  }

  // The turn only proves the model path if the model actually called the tool and the
  // tool's output came back into the transcript.
  const toolCalls = collectField(entries, "type", "toolCall");
  const toolResults = collectField(entries, "toolName", "bash");
  if (toolCalls === 0 || toolResults === 0) {
    return yield* new M0Error({
      reason: "transcript has no bash tool call and tool result",
    });
  }

  const usage = yield* attempt(() => harness.usage(context));
  yield* Effect.log("usage", usage);

  yield* attempt(() => harness.close(context));
});

const outcome = await Effect.runPromise(program.pipe(Effect.result));

if (Result.isFailure(outcome)) {
  await Effect.runPromise(Effect.logError(Result.getFailure(outcome)));
  process.exitCode = 1;
}
