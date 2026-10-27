/**
 * The in-process `SandboxRuntime`: each sandbox is a fresh directory on the host and its commands
 * are the host's own processes, run through Pi Durable's `NodeExecutionEnv` (LOB-88).
 *
 * It needs no cluster, no network and no credentials, which is what makes it the default and the
 * runtime every local suite runs against. It separates nothing from the host — a command or an
 * absolute path reaches everything the server's user can — and its descriptor says so
 * (`isolation: "none"`).
 *
 * Sandboxes live under one root directory: the caller's, or a temporary one this layer creates and
 * removes. Releasing the layer destroys every sandbox still alive, so none outlives the runtime
 * that is the only way to reach it (`persistence: "ephemeral"`).
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FileError, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Clock, Effect, Layer, Random, Ref, type Scope } from "effect";
import {
  execIn,
  fileIn,
  readFileIn,
  SandboxExecutionEnv,
  writeFileIn,
} from "./env";
import {
  type Sandbox,
  type SandboxCapabilities,
  SandboxFileError,
  SandboxId,
  SandboxNotFound,
  SandboxUnsupported,
} from "./Sandbox";
import { SandboxRuntime, type SandboxRuntimeShape } from "./SandboxRuntime";

/** What the in-process runtime provides, and by omission what it does not. */
export const capabilities: SandboxCapabilities = {
  runtime: "in-process",
  isolation: "none",
  persistence: "ephemeral",
  maxDiskGb: null,
  pauseResume: false,
  requiresKeepaliveForLongTasks: false,
};

export type InProcessOptions = {
  /**
   * The directory sandboxes are created under; it must exist, and it is left in place. Absent: a
   * temporary directory created with the layer and removed with it.
   */
  readonly root?: string;
  /** The environment commands start with, as `NodeExecutionEnv` takes it; the server's when absent. */
  readonly shellEnv?: NodeJS.ProcessEnv;
};

/** `sbx-`, the creation time and forty random bits, base 36. */
const mintSandboxId: Effect.Effect<SandboxId> = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis;
  const high = yield* Random.nextIntBetween(0, 2 ** 20);
  const low = yield* Random.nextIntBetween(0, 2 ** 20);
  return SandboxId.make(
    `sbx-${millis.toString(36)}${high.toString(36).padStart(4, "0")}${low.toString(36).padStart(4, "0")}`,
  );
});

/** A host operation the runtime cannot go on without: its failure is a defect. */
const onHost = <T>(
  operation: (context: Context) => Promise<Result<T, FileError>>,
): Effect.Effect<T> =>
  Effect.promise(() => operation(BACKGROUND_CONTEXT)).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.die(result.error),
    ),
  );

type Live = { readonly sandbox: Sandbox; readonly env: SandboxExecutionEnv };

export const make = (
  options: InProcessOptions = {},
): Effect.Effect<SandboxRuntimeShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    // The host's own view, for the directories the runtime manages; never handed to a caller.
    const host = new NodeExecutionEnv({ cwd: options.root ?? "/" });
    const given = options.root;
    // A root that cannot be made or found is a misconfigured server, not a failure to handle.
    const root = yield* Effect.acquireRelease(
      (given === undefined
        ? onHost((context) => host.createTempDir("factory-sandboxes-", context))
        : Effect.succeed(given)
      ).pipe(
        Effect.flatMap((path) =>
          onHost((context) => host.canonicalPath(path, context)),
        ),
      ),
      (path) =>
        given === undefined
          ? onHost((context) =>
              host.remove(path, { recursive: true, force: true }, context),
            )
          : Effect.void,
    );

    const live = yield* Ref.make<ReadonlyMap<SandboxId, Live>>(new Map());

    const find = (sandbox: Sandbox): Effect.Effect<Live, SandboxNotFound> =>
      Ref.get(live).pipe(
        Effect.flatMap((sandboxes) => {
          const found = sandboxes.get(sandbox.id);
          return found === undefined
            ? Effect.fail(new SandboxNotFound({ sandboxId: sandbox.id }))
            : Effect.succeed(found);
        }),
      );

    // Sandboxes whose destroy began but did not finish: no operation finds them, a retried
    // destroy and the layer's release finish them.
    const dying = yield* Ref.make<ReadonlyMap<SandboxId, Live>>(new Map());

    const destroyLive = (
      entry: Live,
      context: Context,
    ): Effect.Effect<void, SandboxFileError> =>
      Effect.tryPromise({
        try: () => entry.env.destroy(context),
        catch: (cause) =>
          new SandboxFileError({
            sandboxId: entry.sandbox.id,
            path: cause instanceof FileError ? (cause.path ?? "") : "",
            code: cause instanceof FileError ? cause.code : "unknown",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }).pipe(
        Effect.andThen(
          fileIn(entry.sandbox.id, entry.sandbox.workdir, (removeContext) =>
            host.remove(
              entry.sandbox.workdir,
              { recursive: true, force: true },
              removeContext,
            ),
          ),
        ),
      );

    /** Destroy one entry; one that fails stays in `dying` for the next attempt. */
    const finish = (entry: Live): Effect.Effect<void, SandboxFileError> =>
      destroyLive(entry, BACKGROUND_CONTEXT).pipe(
        Effect.tap(() =>
          Ref.update(dying, (sandboxes) => {
            const next = new Map(sandboxes);
            next.delete(entry.sandbox.id);
            return next;
          }),
        ),
      );

    const create = Effect.gen(function* () {
      const id = yield* mintSandboxId;
      const path = yield* fileIn(id, root, (context) =>
        host.joinPath([root, id], context),
      );
      yield* fileIn(id, path, (context) =>
        host.createDir(path, undefined, context),
      );
      const workdir = yield* fileIn(id, path, (context) =>
        host.canonicalPath(path, context),
      );
      const sandbox: Sandbox = { id, workdir };
      const env = new SandboxExecutionEnv(
        new NodeExecutionEnv({
          cwd: workdir,
          ...(options.shellEnv === undefined
            ? {}
            : { shellEnv: options.shellEnv }),
        }),
        id,
      );
      yield* Ref.update(live, (sandboxes) =>
        new Map(sandboxes).set(id, { sandbox, env }),
      );
      return sandbox;
    }).pipe(Effect.withSpan("SandboxRuntime.InProcess.create"));

    const destroy = Effect.fn("SandboxRuntime.InProcess.destroy")(function* (
      sandbox: Sandbox,
    ) {
      // Move it out of `live` first, so no operation can find it while its files are being removed.
      const entry = yield* Ref.modify(live, (sandboxes) => {
        const next = new Map(sandboxes);
        next.delete(sandbox.id);
        return [sandboxes.get(sandbox.id), next] as const;
      });
      if (entry !== undefined) {
        yield* Ref.update(dying, (sandboxes) =>
          new Map(sandboxes).set(sandbox.id, entry),
        );
      }
      const pending = entry ?? (yield* Ref.get(dying)).get(sandbox.id);
      if (pending === undefined) return;
      yield* finish(pending);
    }, Effect.uninterruptible);

    // Releasing the runtime destroys what is still alive or half destroyed, before the root is
    // removed. Each one on its own: a failure or a defect in one leaves the others to run.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const alive = yield* Ref.getAndSet(live, new Map());
        const dyingNow = yield* Ref.get(dying);
        const all = new Map([...dyingNow, ...alive]);
        yield* Ref.set(dying, all);
        yield* Effect.forEach(
          [...all.values()],
          (entry) => Effect.exit(finish(entry)),
          { discard: true },
        );
      }),
    );

    const unsupported = (operation: "pause" | "resume") => (sandbox: Sandbox) =>
      find(sandbox).pipe(
        Effect.andThen(
          Effect.fail(
            new SandboxUnsupported({
              runtime: capabilities.runtime,
              operation,
            }),
          ),
        ),
      );

    return {
      capabilities,
      create,
      exec: (sandbox, command, execOptions) =>
        find(sandbox).pipe(
          Effect.flatMap(({ env }) =>
            execIn(env, sandbox.id, command, execOptions),
          ),
        ),
      readFile: (sandbox, path) =>
        find(sandbox).pipe(
          Effect.flatMap(({ env }) => readFileIn(env, sandbox.id, path)),
        ),
      writeFile: (sandbox, path, content) =>
        find(sandbox).pipe(
          Effect.flatMap(({ env }) =>
            writeFileIn(env, sandbox.id, path, content),
          ),
        ),
      pause: unsupported("pause"),
      resume: unsupported("resume"),
      executionEnv: (sandbox) =>
        find(sandbox).pipe(Effect.map(({ env }) => env)),
      destroy,
    } satisfies SandboxRuntimeShape;
  });

/** The in-process runtime as the `SandboxRuntime` service. */
export const layer = (
  options: InProcessOptions = {},
): Layer.Layer<SandboxRuntime> => Layer.effect(SandboxRuntime, make(options));
