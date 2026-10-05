/**
 * M0 — one live model turn, end to end, locally.
 *
 * Proves the pieces the design depends on, over the same code path the API uses
 * (`packages/harness`):
 *   - a real model turn runs against the Anthropic provider
 *   - tool calls execute in NodeExecutionEnv and round-trip into the transcript
 *   - `viewState()` exposes what the control-plane read model needs (design D8)
 *   - `usage` is attributed per model (design R4)
 *
 * Disposable: delete once the sandbox driver (M4) replaces it. Unlike the tests, this one is *not*
 * hermetic — it needs `ANTHROPIC_API_KEY` and it spends money.
 *
 *   bun run m0
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  closeHarness,
  createModelAccess,
  isBusy,
  openSession,
  projectView,
  submitMessage,
} from "@repo/harness";
import { Config, Data, Effect, Option, Result } from "effect";

const PROMPT =
  "Use the bash tool to run `echo m0-ok`. Then reply with exactly the output of that command and nothing else.";

class M0Error extends Data.TaggedError("M0Error")<{
  readonly reason: string;
}> {}

const program = Effect.gen(function* () {
  const apiKey = yield* Config.option(Config.String("ANTHROPIC_API_KEY"));
  if (Option.isNone(apiKey)) {
    return yield* new M0Error({
      reason:
        "ANTHROPIC_API_KEY is not set.\n\n  cp .env.example .env\n  bun run m0",
    });
  }

  const { harness, root } = yield* openSession({
    storage: new MemoryStorage(),
    model: createModelAccess("anthropic"),
    cwd: process.cwd(),
  });

  yield* Effect.log("submitting turn");
  const submitted = yield* submitMessage(root, {
    content: PROMPT,
    requestId: "m0",
  });
  // A run is in flight from here to the answer; the live document is what says so.
  yield* Effect.log(`busy: ${yield* isBusy(harness, root)}`);
  const settled = yield* Effect.promise(() =>
    submitted.submission.wait(BACKGROUND_CONTEXT),
  );
  yield* Effect.log(`settled: ${settled.status}`);

  const view = yield* Effect.promise(() => root.viewState(BACKGROUND_CONTEXT));
  const projection = projectView(view.value);
  view.dispose();

  yield* Effect.log(`transcript entries: ${projection.entries.length}`);
  for (const entry of projection.entries) {
    yield* Effect.log(`entry kind=${entry.kind}`);
    if (entry.text.length > 0) {
      yield* Effect.log(
        entry.text.length > 300 ? `${entry.text.slice(0, 300)}…` : entry.text,
      );
    }
  }
  yield* Effect.log("usage", projection.usage);

  // The turn only proves the model path if the model really called the tool and the tool's output
  // came back into the transcript.
  const calledBash = projection.entries.some((entry) =>
    entry.toolCalls.some((call) => call.name === "bash"),
  );
  const ranBash = projection.entries.some(
    (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
  );
  if (!calledBash || !ranBash) {
    return yield* new M0Error({
      reason: "transcript has no bash tool call and tool result",
    });
  }

  yield* closeHarness(harness);
});

const outcome = await Effect.runPromise(program.pipe(Effect.result));

if (Result.isFailure(outcome)) {
  await Effect.runPromise(Effect.logError(Result.getFailure(outcome)));
  process.exitCode = 1;
}
