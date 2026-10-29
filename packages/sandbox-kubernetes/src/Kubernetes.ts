/**
 * The Kubernetes `SandboxRuntime` (LOB-89, LOB-91): each sandbox is an agent-sandbox `Sandbox`
 * resource — one pod, and one PVC mounted at the sandbox's workdir — and its `ExecutionEnv` runs
 * every command and file operation inside that pod, through the relay (`./relay`).
 *
 * The lifecycle is the controller's, driven through the resource and read back from it:
 *
 * - `create` makes the resource and returns once the controller reports it `Ready` (the pod is up
 *   with the volume mounted). A resource that never gets there is deleted before the failure.
 * - `pause` sets `operatingMode: Suspended` and returns once the controller reports the pod
 *   terminated. Whatever ran in the pod is gone; the volume, and every file on it, is kept. While
 *   paused, every operation is refused rather than waking the sandbox.
 * - `resume` sets `Running` and returns once a new pod is `Ready` over the same volume.
 * - `destroy` deletes the resource and returns once the pod and the volume are gone with it.
 *
 * Releasing the runtime destroys every sandbox it still holds, so none outlives the process that is
 * the only way to reach it. It separates nothing from anyone: locally the pod is a container on a
 * kind node with no `RuntimeClass`, and the descriptor says `isolation: "none"` (D4, R2).
 */
import {
  execIn,
  readFileIn,
  type Sandbox,
  type SandboxCapabilities,
  SandboxExecError,
  SandboxExecutionEnv,
  SandboxFileError,
  SandboxId,
  SandboxNotFound,
  SandboxRuntime,
  type SandboxRuntimeShape,
  writeFileIn,
} from "@repo/sandbox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Clock, Duration, Effect, Layer, Option, Random, Ref, type Scope, Semaphore } from "effect";
import { ClusterError, type OperatingMode, type SandboxClusterShape } from "./Cluster";
import { phaseOf, sandboxManifest } from "./manifest";
import { RemoteExecutionEnv } from "./relay/client";

/** What the Kubernetes runtime provides. */
export const capabilities: SandboxCapabilities = {
  runtime: "kubernetes",
  isolation: "none",
  persistence: "volume",
  // The PVC asks for a size; kind's local-path provisioner does not enforce it.
  maxDiskGb: null,
  pauseResume: true,
  requiresKeepaliveForLongTasks: false,
};

export type KubernetesOptions = {
  /** The cluster the sandboxes live in (`./Kubectl` for a real one, `./testing` for the fake). */
  readonly cluster: SandboxClusterShape;
  /** The sandbox image; `SANDBOX_IMAGE` when absent. */
  readonly image?: string;
  /** Each workspace volume's size; `1Gi` when absent. */
  readonly storage?: string;
  /** How long a create, a pause or a resume may wait for the controller; three minutes when absent. */
  readonly settleTimeout?: Duration.Input;
  /** How often the resource is read back while waiting; a quarter second when absent. */
  readonly pollInterval?: Duration.Input;
};

/** `sbx-`, the creation time and forty random bits, base 36: a valid Kubernetes object name. */
const mintSandboxId: Effect.Effect<SandboxId> = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis;
  const high = yield* Random.nextIntBetween(0, 2 ** 20);
  const low = yield* Random.nextIntBetween(0, 2 ** 20);
  return SandboxId.make(
    `sbx-${millis.toString(36)}${high.toString(36).padStart(4, "0")}${low.toString(36).padStart(4, "0")}`,
  );
});

type Live = {
  readonly sandbox: Sandbox;
  readonly remote: RemoteExecutionEnv;
  readonly env: SandboxExecutionEnv;
  /** One lifecycle change at a time per sandbox. */
  readonly lock: Semaphore.Semaphore;
  /** Read by the environment's refusal, outside any fiber, so a plain field. */
  state: { paused: boolean };
};

export const make = (
  options: KubernetesOptions,
): Effect.Effect<SandboxRuntimeShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { cluster } = options;
    const settleTimeout = Duration.toMillis(Duration.fromInputUnsafe(options.settleTimeout ?? "3 minutes"));
    const pollInterval = options.pollInterval ?? "250 millis";
    const live = yield* Ref.make<ReadonlyMap<SandboxId, Live>>(new Map());
    // Sandboxes whose destroy began but did not finish: no operation finds them, and a retried
    // destroy and the runtime's release finish them.
    const dying = yield* Ref.make<ReadonlyMap<SandboxId, Live>>(new Map());

    const find = (sandbox: Sandbox): Effect.Effect<Live, SandboxNotFound> =>
      Ref.get(live).pipe(
        Effect.flatMap((sandboxes) => {
          const found = sandboxes.get(sandbox.id);
          return found === undefined
            ? Effect.fail(new SandboxNotFound({ sandboxId: sandbox.id }))
            : Effect.succeed(found);
        }),
      );

    /** Read the resource back until the controller reports `want`, a failure, or time runs out. */
    const settle = Effect.fn("SandboxRuntime.Kubernetes.settle")(function* (
      name: string,
      want: "running" | "suspended",
    ) {
      const deadline = (yield* Clock.currentTimeMillis) + settleTimeout;
      let last = "the controller has not reported yet";
      for (;;) {
        const found = yield* cluster.read(name);
        if (Option.isNone(found)) {
          return yield* new ClusterError({ operation: want, message: `${name} no longer exists` });
        }
        const phase = phaseOf(found.value);
        if (phase._tag === want) return;
        if (phase._tag === "failed") {
          return yield* new ClusterError({ operation: want, message: `${name}: ${phase.message}` });
        }
        if (phase._tag === "pending") last = phase.message;
        if ((yield* Clock.currentTimeMillis) > deadline) {
          return yield* new ClusterError({
            operation: want,
            message: `${name} was not ${want} after ${Duration.format(Duration.millis(settleTimeout))}: ${last}`,
          });
        }
        yield* Effect.sleep(pollInterval);
      }
    });

    const fileError = (sandbox: Sandbox) => (error: ClusterError) =>
      new SandboxFileError({
        sandboxId: sandbox.id,
        path: sandbox.workdir,
        code: "unknown",
        message: `${error.operation}: ${error.message}`,
      });

    const pausedMessage = (id: SandboxId) => `sandbox ${id} is paused: resume it first`;

    const create = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = yield* mintSandboxId;
        const sandbox: Sandbox = { id, workdir: cluster.workdir(id) };
        const manifest = sandboxManifest({
          name: id,
          namespace: cluster.namespace,
          workdir: sandbox.workdir,
          ...(options.image === undefined ? {} : { image: options.image }),
          ...(options.storage === undefined ? {} : { storage: options.storage }),
        });
        yield* restore(cluster.create(manifest)).pipe(Effect.mapError(fileError(sandbox)));
        // A resource that never became ready, or a create given up on, is not left behind.
        yield* restore(settle(id, "running")).pipe(
          Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : Effect.ignore(cluster.remove(id)))),
          Effect.mapError(fileError(sandbox)),
        );
        const state = { paused: false };
        const remote = new RemoteExecutionEnv({
          id: `kubernetes:${cluster.name}/${id}`,
          cwd: sandbox.workdir,
          connect: () => cluster.connect(id),
          refusal: () => (state.paused ? pausedMessage(id) : undefined),
        });
        const entry: Live = {
          sandbox,
          remote,
          env: new SandboxExecutionEnv(remote, id),
          lock: yield* Semaphore.make(1),
          state,
        };
        yield* Ref.update(live, (sandboxes) => new Map(sandboxes).set(id, entry));
        return sandbox;
      }),
    ).pipe(Effect.withSpan("SandboxRuntime.Kubernetes.create"));

    /** The entry, unless it is paused, in which case `refuse` says why the operation cannot run. */
    const running = <E>(sandbox: Sandbox, refuse: (message: string) => E): Effect.Effect<Live, SandboxNotFound | E> =>
      find(sandbox).pipe(
        Effect.flatMap((entry) =>
          entry.state.paused ? Effect.fail(refuse(pausedMessage(sandbox.id))) : Effect.succeed(entry),
        ),
      );

    const lifecycle = (mode: OperatingMode) =>
      Effect.fn(`SandboxRuntime.Kubernetes.${mode === "Suspended" ? "pause" : "resume"}`)(function* (
        sandbox: Sandbox,
      ) {
        const entry = yield* find(sandbox);
        const pausing = mode === "Suspended";
        yield* entry.lock.withPermit(
          Effect.gen(function* () {
            if (entry.state.paused === pausing) return;
            if (pausing) {
              // Refuse new calls first, then cut the connection: the relay ends, and with it every
              // command still running, before the controller deletes the pod.
              entry.state.paused = true;
              entry.remote.disconnect(`sandbox ${sandbox.id} was paused`);
            }
            yield* cluster.setMode(sandbox.id, mode).pipe(
              Effect.andThen(settle(sandbox.id, pausing ? "suspended" : "running")),
              // A pause that failed leaves the pod running, so calls may run again; a failed resume
              // leaves the sandbox paused.
              Effect.tapError(() =>
                Effect.sync(() => {
                  if (pausing) entry.state.paused = false;
                }),
              ),
              // The shape gives pause and resume no failure of their own: a cluster that cannot
              // suspend or resume is a broken deployment, raised as a defect with its message.
              Effect.orDie,
            );
            entry.state.paused = pausing;
          }),
        );
      });

    /** Destroy one entry; one that fails stays in `dying` for the next attempt. */
    const finish = (entry: Live): Effect.Effect<void, SandboxFileError> =>
      Effect.gen(function* () {
        // The environment ends first: running commands are aborted (a paused sandbox has none) and
        // handles closed. Its temporary files are in the pod, which the deletion takes with it.
        yield* Effect.ignore(Effect.promise(() => entry.env.destroy(BACKGROUND_CONTEXT).catch(() => undefined)));
        entry.remote.disconnect(`sandbox ${entry.sandbox.id} was destroyed`);
        yield* cluster.remove(entry.sandbox.id).pipe(Effect.mapError(fileError(entry.sandbox)));
        yield* Ref.update(dying, (sandboxes) => {
          const next = new Map(sandboxes);
          next.delete(entry.sandbox.id);
          return next;
        });
      });

    const destroy = Effect.fn("SandboxRuntime.Kubernetes.destroy")(function* (sandbox: Sandbox) {
      // Out of `live` first, so no operation can find it while it is being deleted.
      const entry = yield* Ref.modify(live, (sandboxes) => {
        const next = new Map(sandboxes);
        next.delete(sandbox.id);
        return [sandboxes.get(sandbox.id), next] as const;
      });
      if (entry !== undefined) {
        yield* Ref.update(dying, (sandboxes) => new Map(sandboxes).set(sandbox.id, entry));
      }
      const pending = entry ?? (yield* Ref.get(dying)).get(sandbox.id);
      if (pending === undefined) return;
      yield* finish(pending);
    }, Effect.uninterruptible);

    // Releasing the runtime deletes what it still holds, each on its own: one that fails leaves the
    // others to be deleted.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const alive = yield* Ref.getAndSet(live, new Map());
        const all = new Map([...(yield* Ref.get(dying)), ...alive]);
        yield* Ref.set(dying, all);
        yield* Effect.forEach([...all.values()], (entry) => Effect.exit(finish(entry)), {
          concurrency: "unbounded",
          discard: true,
        });
      }),
    );

    return {
      capabilities,
      create,
      exec: (sandbox, command, execOptions) =>
        running(
          sandbox,
          (message) => new SandboxExecError({ sandboxId: sandbox.id, code: "unknown", message }),
        ).pipe(Effect.flatMap(({ env }) => execIn(env, sandbox.id, command, execOptions))),
      readFile: (sandbox, path) =>
        running(
          sandbox,
          (message) => new SandboxFileError({ sandboxId: sandbox.id, path, code: "unknown", message }),
        ).pipe(Effect.flatMap(({ env }) => readFileIn(env, sandbox.id, path))),
      writeFile: (sandbox, path, content) =>
        running(
          sandbox,
          (message) => new SandboxFileError({ sandboxId: sandbox.id, path, code: "unknown", message }),
        ).pipe(Effect.flatMap(({ env }) => writeFileIn(env, sandbox.id, path, content))),
      pause: lifecycle("Suspended"),
      resume: lifecycle("Running"),
      executionEnv: (sandbox) => find(sandbox).pipe(Effect.map(({ env }) => env)),
      destroy,
    } satisfies SandboxRuntimeShape;
  });

/** The Kubernetes runtime as the `SandboxRuntime` service. */
export const layer = (options: KubernetesOptions): Layer.Layer<SandboxRuntime> =>
  Layer.effect(SandboxRuntime, make(options));
