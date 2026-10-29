/* oxlint-disable effecttsgo/prefer-schema-over-json -- what `kubectl` reads on stdin and in `--patch` is JSON this module writes from its own literals; what it prints is decoded through `Schema.fromJsonString`. */
/**
 * The cluster seam served by `kubectl` (LOB-89): every operation is one `kubectl` process against
 * one context and namespace, so the runtime holds no client library, no token and no cluster
 * credentials of its own — whatever `kubectl` is configured with (locally, kind's context) is what
 * it reaches.
 *
 * Deletion is `--cascade=foreground --wait`: the API server removes the resource only after the pod
 * and the volume it owns are gone, so a `remove` that returns has left nothing running and nothing
 * stored. A pod's relay is `kubectl exec -i` into the sandbox's container, running the image's
 * `factory-env-relay`.
 */
import { Effect, Option, Ref, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ClusterError, type SandboxClusterShape } from "./Cluster";
import { SANDBOX_CONTAINER, SandboxObject } from "./manifest";
import { spawnConnection } from "./relay/connection";

export type KubectlClusterOptions = {
  /** The kubeconfig context, e.g. `kind-factory-sandbox`; never the current one by accident. */
  readonly context: string;
  /** Where the sandboxes live; created on first use when missing. */
  readonly namespace: string;
  /** The `kubectl` to run; `kubectl` on PATH when absent. */
  readonly kubectl?: string;
  /** The directory sandboxes' volumes are mounted under in their pods. */
  readonly workspaceRoot?: string;
  /** The relay's command in the sandbox image. */
  readonly relay?: ReadonlyArray<string>;
  /** How long a deletion may take before it is a failure, as `kubectl --timeout` takes it. */
  readonly removeTimeout?: string;
};

type Run = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

const RESOURCE = "sandboxes.agents.x-k8s.io";

export const kubectlCluster = (
  options: KubectlClusterOptions,
): Effect.Effect<
  SandboxClusterShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const kubectl = options.kubectl ?? "kubectl";
    const workspaceRoot = options.workspaceRoot ?? "/workspace";
    const relay = options.relay ?? ["factory-env-relay"];
    const scope = [
      "--context",
      options.context,
      "--namespace",
      options.namespace,
    ];

    /** One `kubectl` process; a spawn that fails is the exit code `-1` with the platform's message. */
    const run = (
      args: ReadonlyArray<string>,
      input?: string,
    ): Effect.Effect<Run> =>
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(kubectl, [...scope, ...args], {
            stdin:
              input === undefined
                ? "ignore"
                : Stream.make(new TextEncoder().encode(input)),
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode: Number(exitCode) };
      }).pipe(
        Effect.scoped,
        Effect.catch((error) =>
          Effect.succeed({ stdout: "", stderr: String(error), exitCode: -1 }),
        ),
      );

    /** Run, and fail with `operation` named when `kubectl` does. */
    const must = (
      operation: string,
      args: ReadonlyArray<string>,
      input?: string,
    ) =>
      run(args, input).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                new ClusterError({
                  operation,
                  message: `kubectl ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`,
                }),
              ),
        ),
      );

    // Applied until one apply succeeds, then never again: a failed or interrupted first apply (the
    // API server not answering yet) is retried by the next create rather than remembered. Two
    // creates racing before the first success both apply, which `kubectl apply` makes harmless.
    const namespaceApplied = yield* Ref.make(false);
    const namespace = Effect.gen(function* () {
      if (yield* Ref.get(namespaceApplied)) return;
      yield* must(
        "namespace",
        ["apply", "-f", "-"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: options.namespace,
            labels: { "app.kubernetes.io/managed-by": "factory" },
          },
        }),
      );
      yield* Ref.set(namespaceApplied, true);
    });

    const decodeObject = Schema.decodeUnknownEffect(
      Schema.fromJsonString(SandboxObject),
    );

    return {
      name: `${options.context}/${options.namespace}`,
      namespace: options.namespace,
      workdir: (name) => `${workspaceRoot}/${name}`,
      create: (manifest) =>
        namespace.pipe(
          Effect.andThen(
            must("create", ["create", "-f", "-"], JSON.stringify(manifest)),
          ),
          Effect.asVoid,
          Effect.withSpan("SandboxCluster.kubectl.create", {
            attributes: { name: manifest.metadata.name },
          }),
        ),
      read: (name) =>
        must("read", [
          "get",
          RESOURCE,
          name,
          "--ignore-not-found",
          "--output",
          "json",
        ]).pipe(
          Effect.flatMap((stdout) =>
            stdout.trim() === ""
              ? Effect.succeed(Option.none())
              : decodeObject(stdout).pipe(
                  Effect.map(Option.some),
                  Effect.mapError(
                    (error) =>
                      new ClusterError({
                        operation: "read",
                        message: `${name}: ${error.message}`,
                      }),
                  ),
                ),
          ),
        ),
      setMode: (name, mode) =>
        must("setMode", [
          "patch",
          RESOURCE,
          name,
          "--type",
          "merge",
          "--patch",
          JSON.stringify({ spec: { operatingMode: mode } }),
        ]).pipe(
          Effect.asVoid,
          Effect.withSpan("SandboxCluster.kubectl.setMode", {
            attributes: { name, mode },
          }),
        ),
      remove: (name) =>
        must("remove", [
          "delete",
          RESOURCE,
          name,
          "--ignore-not-found",
          "--cascade=foreground",
          "--wait=true",
          `--timeout=${options.removeTimeout ?? "120s"}`,
        ]).pipe(
          // Foreground deletion already waited for the pod and the volume; this says so, or fails.
          Effect.andThen(
            must("remove", [
              "get",
              `pod/${name}`,
              `persistentvolumeclaim/workspace-${name}`,
              "--ignore-not-found",
              "--output",
              "name",
            ]),
          ),
          Effect.flatMap((left) =>
            left.trim() === ""
              ? Effect.void
              : Effect.fail(
                  new ClusterError({
                    operation: "remove",
                    message: `${name} is deleted but left ${left.trim()}`,
                  }),
                ),
          ),
          Effect.withSpan("SandboxCluster.kubectl.remove", {
            attributes: { name },
          }),
        ),
      connect: (name) =>
        spawnConnection(kubectl, [
          ...scope,
          "exec",
          "--stdin",
          name,
          "--container",
          SANDBOX_CONTAINER,
          "--",
          ...relay,
        ]),
    } satisfies SandboxClusterShape;
  });
