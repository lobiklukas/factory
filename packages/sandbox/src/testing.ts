/**
 * The `SandboxRuntime` conformance suite: runner-independent cases every implementation must pass,
 * in the shape of Pi Durable's own suites (LOB-88).
 *
 * `registerSandboxRuntimeConformance` registers two groups against one layer. The runtime's cases
 * cover create, exec, read, write and destroy, and check that pause and resume do what the
 * descriptor says, present or absent. Then Pi Durable's `registerEnvConformance` runs against the
 * environment `executionEnv` returns for a fresh sandbox, so the adapter is held to the same
 * oracle as `NodeExecutionEnv`. Each case builds the layer afresh and releases it afterwards.
 *
 * The rest of a descriptor — persistence, disk limits, and what its `isolation` value lets a
 * command reach — is checked by the runtime's own suite, from the host, where only it can look.
 * That check covers what a test observes and nothing more (R2).
 */
import {
  createExpectAssertions,
  registerEnvConformance,
  type StorageConformanceRunner,
} from "@earendil-works/pi-durable/testing";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Cause,
  Effect,
  Fiber,
  type Layer,
  Schedule,
  Schema,
  type Scope,
} from "effect";
import {
  type Sandbox,
  SandboxCapabilities,
  type SandboxExecError,
  type SandboxFileError,
  SandboxId,
  type SandboxNotFound,
  type SandboxUnsupported,
} from "./Sandbox";
import { SandboxRuntime, type SandboxRuntimeShape } from "./SandboxRuntime";

/** What a case may fail with: an operation's typed failure, or a check that could not finish. */
type CaseError =
  | SandboxNotFound
  | SandboxFileError
  | SandboxExecError
  | SandboxUnsupported
  | Cause.TimeoutError
  | Schema.SchemaError;

export type SandboxConformanceCase = {
  readonly name: string;
  readonly timeoutMs?: number;
  readonly run: () => Promise<void>;
};

const decoder = new TextDecoder();
const text = (bytes: Uint8Array): string => decoder.decode(bytes);

/** The failure's tag, or `"success"`: what a refused operation is asserted with. */
const outcome = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<string, never, R> =>
  effect.pipe(
    Effect.match({
      onSuccess: () => "success",
      onFailure: (error) => error._tag,
    }),
  );

/** The failure an operation must end in; succeeding is the case's own failure. */
const failure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<E, never, R> =>
  effect.pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.die(new Error("the operation succeeded")),
      onFailure: Effect.succeed,
    }),
  );

/** A sandbox that lives until the case's scope closes, destroyed even when the case fails. */
const scopedSandbox = (
  runtime: SandboxRuntimeShape,
): Effect.Effect<Sandbox, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.orDie(runtime.create), (sandbox) =>
    Effect.ignore(runtime.destroy(sandbox)),
  );

/** Wait until a file the command writes exists: the command has started. */
const until = (
  runtime: SandboxRuntimeShape,
  sandbox: Sandbox,
  path: string,
): Effect.Effect<void> =>
  runtime
    .readFile(sandbox, path)
    .pipe(
      Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }),
      Effect.orDie,
      Effect.asVoid,
    );

/**
 * The runtime's cases, for a runner that is not Vitest or for counting them. `layer` is built once
 * per case.
 */
export const createSandboxRuntimeConformance = <E>(
  runner: Pick<StorageConformanceRunner, "expect">,
  layer: Layer.Layer<SandboxRuntime, E>,
): ReadonlyArray<SandboxConformanceCase> => {
  const assert = createExpectAssertions(runner.expect);
  const createCase = (
    name: string,
    body: (
      runtime: SandboxRuntimeShape,
    ) => Effect.Effect<void, CaseError, Scope.Scope>,
    timeoutMs?: number,
  ): SandboxConformanceCase => ({
    name,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    run: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* SandboxRuntime;
          yield* body(runtime);
        }).pipe(Effect.scoped, Effect.provide(layer)),
      ),
  });

  return [
    createCase("its descriptor decodes as a capability descriptor", (runtime) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeEffect(SandboxCapabilities)(
          runtime.capabilities,
        );
        assert.deepEqual(decoded, runtime.capabilities);
      }),
    ),

    createCase(
      "create gives each sandbox its own fresh, empty workdir",
      (runtime) =>
        Effect.gen(function* () {
          const first = yield* scopedSandbox(runtime);
          const second = yield* scopedSandbox(runtime);
          assert.ok(first.id !== second.id, "the ids differ");
          assert.ok(first.workdir !== second.workdir, "the workdirs differ");
          assert.ok(Schema.is(SandboxId)(first.id), "the id is a SandboxId");
          for (const sandbox of [first, second]) {
            assert.ok(
              sandbox.workdir.startsWith("/"),
              "the workdir is absolute",
            );
            const listing = yield* runtime.exec(sandbox, ["ls", "-A"]);
            assert.deepEqual(listing, {
              exitCode: 0,
              stdout: "",
              stderr: "",
              truncated: false,
            });
            // Canonical: the directory a command starts in is the one the handle names.
            const pwd = yield* runtime.exec(sandbox, "pwd -P");
            assert.strictEqual(pwd.stdout.trim(), sandbox.workdir);
          }
        }),
    ),

    createCase(
      "write then read returns the same bytes, creating parents",
      (runtime) =>
        Effect.gen(function* () {
          const sandbox = yield* scopedSandbox(runtime);
          const bytes = Uint8Array.from([0x00, 0xff, 0x0a, 0xc3, 0xa9, 0xfe]);
          yield* runtime.writeFile(sandbox, "deep/er/data.bin", bytes);
          assert.deepEqual(
            Array.from(yield* runtime.readFile(sandbox, "deep/er/data.bin")),
            Array.from(bytes),
          );
          yield* runtime.writeFile(sandbox, "note.txt", "first");
          yield* runtime.writeFile(sandbox, "note.txt", "second");
          assert.strictEqual(
            text(yield* runtime.readFile(sandbox, "note.txt")),
            "second",
          );
        }),
    ),

    createCase("reading a missing file fails with not_found", (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* scopedSandbox(runtime);
        const error = yield* failure(runtime.readFile(sandbox, "missing.txt"));
        assert.partialDeepEqual(error, {
          _tag: "SandboxFileError",
          sandboxId: sandbox.id,
          code: "not_found",
        });
      }),
    ),

    createCase("exec and the file operations see the same workdir", (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* scopedSandbox(runtime);
        yield* runtime.writeFile(sandbox, "given.txt", "from the runtime");
        const read = yield* runtime.exec(sandbox, "cat given.txt");
        assert.strictEqual(read.stdout, "from the runtime");
        const made = yield* runtime.exec(sandbox, "printf marker > made.txt");
        assert.strictEqual(made.exitCode, 0);
        assert.strictEqual(
          text(yield* runtime.readFile(sandbox, "made.txt")),
          "marker",
        );
      }),
    ),

    createCase(
      "exec returns non-zero exits as results and keeps the streams apart",
      (runtime) =>
        Effect.gen(function* () {
          const sandbox = yield* scopedSandbox(runtime);
          const result = yield* runtime.exec(
            sandbox,
            "printf out; printf err >&2; exit 7",
          );
          assert.deepEqual(result, {
            exitCode: 7,
            stdout: "out",
            stderr: "err",
            truncated: false,
          });
        }),
    ),

    createCase("argv exec passes its arguments unparsed", (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* scopedSandbox(runtime);
        const hostile = "$(touch pwned) `touch pwned` *; touch pwned";
        const result = yield* runtime.exec(sandbox, [
          "sh",
          "-c",
          'printf "%s" "$1"',
          "argv0",
          hostile,
        ]);
        assert.strictEqual(result.stdout, hostile);
        assert.strictEqual(
          yield* outcome(runtime.readFile(sandbox, "pwned")),
          "SandboxFileError",
        );
      }),
    ),

    createCase("exec honours cwd and env", (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* scopedSandbox(runtime);
        yield* runtime.writeFile(sandbox, "sub/.keep", "");
        const where = yield* runtime.exec(sandbox, "pwd -P", { cwd: "sub" });
        assert.strictEqual(where.stdout.trim(), `${sandbox.workdir}/sub`);
        const variable = yield* runtime.exec(
          sandbox,
          'printf "%s" "$SANDBOX_PROBE"',
          {
            env: { SANDBOX_PROBE: "probe-value" },
          },
        );
        assert.strictEqual(variable.stdout, "probe-value");
      }),
    ),

    createCase(
      "exec keeps output up to maxOutputBytes and says it dropped the rest",
      (runtime) =>
        Effect.gen(function* () {
          const sandbox = yield* scopedSandbox(runtime);
          // Two-byte characters: the cap falls inside one, which is dropped whole.
          const capped = yield* runtime.exec(sandbox, "printf 'éééééééééé'", {
            maxOutputBytes: 7,
          });
          assert.deepEqual(capped, {
            exitCode: 0,
            stdout: "ééé",
            stderr: "",
            truncated: true,
          });
          const fits = yield* runtime.exec(sandbox, "printf 'éé'", {
            maxOutputBytes: 4,
          });
          assert.deepEqual(fits, {
            exitCode: 0,
            stdout: "éé",
            stderr: "",
            truncated: false,
          });
        }),
    ),

    createCase("a missing program fails with spawn_error", (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* scopedSandbox(runtime);
        const error = yield* failure(
          runtime.exec(sandbox, [
            "factory-sandbox-conformance-missing-program",
          ]),
        );
        assert.partialDeepEqual(error, {
          _tag: "SandboxExecError",
          sandboxId: sandbox.id,
          code: "spawn_error",
        });
      }),
    ),

    createCase("exec past its timeout fails with timeout", (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* scopedSandbox(runtime);
        const error = yield* failure(
          runtime.exec(sandbox, "sleep 5", { timeout: 0.2 }),
        );
        assert.partialDeepEqual(error, {
          _tag: "SandboxExecError",
          code: "timeout",
        });
      }),
    ),

    createCase(
      "interrupting exec kills the command",
      (runtime) =>
        Effect.gen(function* () {
          const sandbox = yield* scopedSandbox(runtime);
          // The command writes its marker only once the case lets it, not after a fixed nap: a nap
          // a loaded machine outlasted between `started` and the interrupt let a command the
          // interrupt did kill write `survived` first.
          const running = yield* Effect.forkChild(
            runtime.exec(
              sandbox,
              "printf s > started; until [ -e release ]; do sleep 0.02; done; printf s > survived",
            ),
          );
          yield* until(runtime, sandbox, "started");
          yield* Fiber.interrupt(running);
          yield* runtime.writeFile(sandbox, "release", "");
          // Far longer than a surviving command needs to see `release` and write the marker.
          yield* Effect.sleep("1500 millis");
          assert.strictEqual(
            yield* outcome(runtime.readFile(sandbox, "survived")),
            "SandboxFileError",
          );
        }),
      10_000,
    ),

    createCase(
      "destroy stops a command still running",
      (runtime) =>
        Effect.gen(function* () {
          const sandbox = yield* Effect.orDie(runtime.create);
          const running = yield* Effect.forkChild(
            runtime.exec(sandbox, "printf s > started; sleep 30"),
          );
          yield* until(runtime, sandbox, "started");
          yield* runtime.destroy(sandbox);
          // Within the case's timeout, far short of the command's thirty seconds.
          const error = yield* failure(Fiber.join(running));
          assert.partialDeepEqual(error, {
            _tag: "SandboxExecError",
            sandboxId: sandbox.id,
            code: "aborted",
          });
        }),
      10_000,
    ),

    createCase(
      "after destroy every operation fails with SandboxNotFound",
      (runtime) =>
        Effect.gen(function* () {
          const sandbox = yield* Effect.orDie(runtime.create);
          yield* runtime.writeFile(sandbox, "kept.txt", "x");
          yield* runtime.destroy(sandbox);
          const errors = yield* Effect.all([
            failure(runtime.exec(sandbox, "true")),
            failure(runtime.readFile(sandbox, "kept.txt")),
            failure(runtime.writeFile(sandbox, "new.txt", "x")),
            failure(runtime.executionEnv(sandbox)),
            failure(runtime.pause(sandbox)),
            failure(runtime.resume(sandbox)),
          ]);
          for (const error of errors) {
            assert.partialDeepEqual(error, {
              _tag: "SandboxNotFound",
              sandboxId: sandbox.id,
            });
          }
        }),
    ),

    createCase("destroy is idempotent", (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* Effect.orDie(runtime.create);
        yield* runtime.destroy(sandbox);
        yield* runtime.destroy(sandbox);
        assert.strictEqual(
          yield* outcome(runtime.exec(sandbox, "true")),
          "SandboxNotFound",
        );
      }),
    ),

    createCase("destroying one sandbox leaves the others working", (runtime) =>
      Effect.gen(function* () {
        const doomed = yield* Effect.orDie(runtime.create);
        const kept = yield* scopedSandbox(runtime);
        yield* runtime.writeFile(kept, "kept.txt", "still here");
        yield* runtime.destroy(doomed);
        assert.strictEqual(
          text(yield* runtime.readFile(kept, "kept.txt")),
          "still here",
        );
        assert.strictEqual((yield* runtime.exec(kept, "true")).exitCode, 0);
      }),
    ),

    createCase("a sandbox this runtime never created is not found", (runtime) =>
      Effect.gen(function* () {
        const stranger: Sandbox = {
          id: SandboxId.make("sbx-neverminted"),
          workdir: "/nonexistent",
        };
        const outcomes = yield* Effect.all([
          outcome(runtime.exec(stranger, "true")),
          outcome(runtime.readFile(stranger, "x")),
          outcome(runtime.writeFile(stranger, "x", "x")),
          outcome(runtime.executionEnv(stranger)),
        ]);
        assert.deepEqual(
          outcomes,
          Array.from(outcomes, () => "SandboxNotFound"),
        );
      }),
    ),

    createCase("pause and resume do what the descriptor says", (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* scopedSandbox(runtime);
        yield* runtime.writeFile(sandbox, "before.txt", "kept across a pause");
        if (runtime.capabilities.pauseResume) {
          yield* runtime.pause(sandbox);
          yield* runtime.resume(sandbox);
          assert.strictEqual(
            text(yield* runtime.readFile(sandbox, "before.txt")),
            "kept across a pause",
          );
          return;
        }
        for (const [operation, effect] of [
          ["pause", runtime.pause(sandbox)],
          ["resume", runtime.resume(sandbox)],
        ] as const) {
          const error = yield* failure(effect);
          assert.partialDeepEqual(error, {
            _tag: "SandboxUnsupported",
            runtime: runtime.capabilities.runtime,
            operation,
          });
        }
        // Refusing is all it does: the sandbox is untouched.
        assert.strictEqual(
          text(yield* runtime.readFile(sandbox, "before.txt")),
          "kept across a pause",
        );
      }),
    ),

    createCase(
      "the execution env is the sandbox's, and stops with it",
      (runtime) =>
        Effect.gen(function* () {
          const sandbox = yield* Effect.orDie(runtime.create);
          const env = yield* runtime.executionEnv(sandbox);
          const context = BACKGROUND_CONTEXT;
          assert.strictEqual(env.cwd, sandbox.workdir);
          yield* runtime.writeFile(sandbox, "shared.txt", "one view");
          const read = yield* Effect.promise(() =>
            env.readTextFile("shared.txt", context),
          );
          assert.deepEqual(read, { ok: true, value: "one view" });
          yield* runtime.destroy(sandbox);
          const exec = yield* Effect.promise(() =>
            env.exec("true", undefined, context),
          );
          assert.strictEqual(exec.ok ? "ran" : exec.error.code, "aborted");
          const after = yield* Effect.promise(() =>
            env.readTextFile("shared.txt", context),
          );
          assert.strictEqual(after.ok ? "read" : after.error.code, "aborted");
        }),
    ),
  ];
};

/**
 * Register the runtime's cases and Pi Durable's `ExecutionEnv` cases with a Vitest/Jest-compatible
 * runner, as `registerEnvConformance` does for an environment.
 */
export const registerSandboxRuntimeConformance = <E>(
  runner: StorageConformanceRunner,
  name: string,
  layer: Layer.Layer<SandboxRuntime, E>,
): void => {
  const cases = createSandboxRuntimeConformance(runner, layer);
  runner.describe(name, () => {
    for (const testCase of cases)
      runner.it(testCase.name, testCase.run, testCase.timeoutMs);
  });
  registerEnvConformance(runner, `${name}: ExecutionEnv`, (use) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SandboxRuntime;
        const sandbox = yield* scopedSandbox(runtime);
        const env: ExecutionEnv = yield* Effect.orDie(
          runtime.executionEnv(sandbox),
        );
        // A failed assertion rejects `use`; it reaches the runner as the case's own error.
        yield* Effect.promise(() => use(env));
      }).pipe(Effect.scoped, Effect.provide(layer)),
    ),
  );
};
