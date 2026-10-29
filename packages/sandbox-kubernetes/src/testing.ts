/* oxlint-disable effecttsgo/node-builtin-import -- a test fake: its volumes are host directories the tests read directly. */
/**
 * A fake cluster for the Kubernetes runtime (LOB-89): the agent-sandbox controller's contract,
 * modelled in memory, so the runtime's lifecycle and its `ExecutionEnv` run in the gate without
 * kind, Docker or `kubectl`.
 *
 * What it models, and only that:
 *
 * - A `Sandbox` resource as the API server holds it: its generation (bumped by every mode change),
 *   its `operatingMode`, and the `Ready` and `Suspended` conditions the controller writes, stamped
 *   with the generation they were observed at. Each change is reported one read late — first a
 *   pending condition, then the settled one — because the real controller is asynchronous and a
 *   runtime that reads one stale `Ready` as the answer is wrong.
 * - The pod, as a relay process (`./relay/main.ts`, bundled as the image runs it) started in the
 *   sandbox's volume for each connection. Suspending or deleting the resource kills every one of
 *   them, as deleting a pod kills what runs in it.
 * - The PVC, as a directory under `root` that suspending keeps and deleting removes.
 *
 * It checks the manifest it is given — kind, API version, the workspace claim and its mount at the
 * workdir — and refuses one that the controller would not turn into a sandbox with a workspace.
 * It cannot show that the real controller does any of this; the verify-sandbox drive does.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option } from "effect";
import {
  ClusterError,
  type OperatingMode,
  type SandboxClusterShape,
} from "./Cluster";
import {
  type Condition,
  SANDBOX_API_VERSION,
  type SandboxManifest,
  type SandboxObject,
} from "./manifest";
import { buildRelay } from "./relay/build";
import { type Connection, spawnConnection } from "./relay/connection";

export type FakeControllerBehaviour =
  /** Every resource becomes ready, suspends and resumes. */
  | "healthy"
  /** A resource never becomes ready: its pod is forever pending. */
  | "stuck"
  /** A resource's pod fails, which the controller reports as `PodFailed`. */
  | "failing";

export type FakeClusterOptions = {
  /** A directory the fake owns: its volumes and its relay bundle live under it. Canonical. */
  readonly root: string;
  readonly behaviour?: FakeControllerBehaviour;
  /** A relay bundle already built (`buildRelay`); built under `root` when absent. */
  readonly relay?: string;
};

type Resource = {
  readonly manifest: SandboxManifest;
  generation: number;
  mode: OperatingMode;
  /** Reads left before the current generation settles. */
  settlesIn: number;
};

export type FakeCluster = SandboxClusterShape & {
  /** Every operation the runtime asked for, in order, as `operation name[ detail]`. */
  readonly calls: ReadonlyArray<string>;
  /** The resources the fake holds, by name. */
  readonly resources: () => ReadonlyArray<string>;
  /** Whether sandbox `name` has a pod now. */
  readonly hasPod: (name: string) => boolean;
  /** The host directory standing in for sandbox `name`'s volume. */
  readonly volume: (name: string) => string;
  /** The relay processes running now, across every pod. */
  readonly relays: () => number;
  /** Change how the controller behaves for resources created from now on. */
  readonly setBehaviour: (behaviour: FakeControllerBehaviour) => void;
};

const closedConnection = (reason: string): Connection => ({
  send: () => undefined,
  onLine: () => undefined,
  onClose: (listener) => listener(reason),
  close: () => undefined,
});

export const fakeCluster = (options: FakeClusterOptions): FakeCluster => {
  const volumes = join(options.root, "volumes");
  mkdirSync(volumes, { recursive: true });
  const relay = options.relay ?? buildRelay(join(options.root, "relay.mjs"));
  const resources = new Map<string, Resource>();
  const behaviours = new Map<string, FakeControllerBehaviour>();
  const connections = new Map<string, Set<Connection>>();
  const calls: string[] = [];
  let behaviour: FakeControllerBehaviour = options.behaviour ?? "healthy";

  const volume = (name: string) => join(volumes, name);
  const settled = (resource: Resource) => resource.settlesIn <= 0;
  const hasPod = (name: string) => {
    const resource = resources.get(name);
    return (
      resource !== undefined &&
      resource.mode === "Running" &&
      settled(resource) &&
      behaviours.get(name) === "healthy"
    );
  };

  /** Delete the pod: every relay in it dies, and what it ran with it. */
  const killPod = (name: string) => {
    for (const connection of connections.get(name) ?? []) connection.close();
    connections.delete(name);
  };

  const refuse = (operation: string, message: string) =>
    Effect.fail(new ClusterError({ operation, message }));

  const conditionsOf = (
    name: string,
    resource: Resource,
  ): ReadonlyArray<Condition> => {
    const observedGeneration = resource.generation;
    const stamp = (
      type: string,
      status: string,
      reason: string,
      message = "",
    ) => ({
      type,
      status,
      reason,
      message,
      observedGeneration,
    });
    if (!settled(resource)) {
      // The controller has not caught up: what it last wrote is for the previous generation.
      return [stamp("Ready", "True", "DependenciesReady", "stale")].map(
        (condition) => ({
          ...condition,
          observedGeneration: observedGeneration - 1,
        }),
      );
    }
    if (resource.mode === "Suspended") {
      return [
        stamp("Suspended", "True", "PodTerminated", "Pod terminated"),
        stamp("Ready", "False", "SandboxSuspended", "Sandbox is suspended"),
      ];
    }
    switch (behaviours.get(name)) {
      case "stuck":
        return [
          stamp("Ready", "False", "DependenciesNotReady", "Pod is pending"),
        ];
      case "failing":
        return [stamp("Ready", "False", "PodFailed", "Pod failed")];
      default:
        return [
          stamp("Suspended", "False", "NotSuspended"),
          stamp("Ready", "True", "DependenciesReady", "Pod is Ready"),
        ];
    }
  };

  const validate = (manifest: SandboxManifest): string | undefined => {
    if (
      manifest.apiVersion !== SANDBOX_API_VERSION ||
      manifest.kind !== "Sandbox"
    ) {
      return `not an ${SANDBOX_API_VERSION} Sandbox`;
    }
    const claim = manifest.spec.volumeClaimTemplates.find(
      (template) => template.metadata.name === "workspace",
    );
    if (claim === undefined) return "no workspace volume claim";
    const container = manifest.spec.podTemplate.spec.containers[0];
    const mount = container?.volumeMounts.find(
      (each) => each.name === "workspace",
    );
    if (mount?.mountPath !== volume(manifest.metadata.name)) {
      return `the workspace is mounted at ${mount?.mountPath ?? "nothing"}, not the workdir`;
    }
    if (
      container?.image === undefined ||
      container.image.endsWith(":latest") ||
      !container.image.includes(":")
    ) {
      return `the image ${container?.image ?? "(none)"} is not pinned`;
    }
    return undefined;
  };

  return {
    name: "fake",
    namespace: "factory-sandboxes",
    workdir: volume,
    calls,
    resources: () => [...resources.keys()],
    hasPod,
    volume,
    relays: () =>
      [...connections.values()].reduce((count, each) => count + each.size, 0),
    setBehaviour: (next) => {
      behaviour = next;
    },
    create: (manifest) =>
      Effect.suspend(() => {
        const name = manifest.metadata.name;
        calls.push(`create ${name}`);
        if (resources.has(name))
          return refuse("create", `sandboxes "${name}" already exists`);
        const invalid = validate(manifest);
        if (invalid !== undefined)
          return refuse("create", `${name}: ${invalid}`);
        // The claim's volume: kept across suspends, removed with the resource.
        mkdirSync(volume(name), { recursive: true });
        resources.set(name, {
          manifest,
          generation: 1,
          mode: "Running",
          settlesIn: 1,
        });
        behaviours.set(name, behaviour);
        return Effect.void;
      }),
    read: (name) =>
      Effect.sync(() => {
        calls.push(`read ${name}`);
        const resource = resources.get(name);
        if (resource === undefined) return Option.none<SandboxObject>();
        const object: SandboxObject = {
          metadata: { name, generation: resource.generation },
          spec: { operatingMode: resource.mode },
          status: { conditions: conditionsOf(name, resource) },
        };
        resource.settlesIn -= 1;
        return Option.some(object);
      }),
    setMode: (name, mode) =>
      Effect.suspend(() => {
        calls.push(`setMode ${name} ${mode}`);
        const resource = resources.get(name);
        if (resource === undefined)
          return refuse("setMode", `sandboxes "${name}" not found`);
        if (resource.mode !== mode) {
          resource.mode = mode;
          resource.generation += 1;
          resource.settlesIn = 1;
          if (mode === "Suspended") killPod(name);
        }
        return Effect.void;
      }),
    remove: (name) =>
      Effect.sync(() => {
        calls.push(`remove ${name}`);
        if (!resources.delete(name)) return;
        behaviours.delete(name);
        killPod(name);
        rmSync(volume(name), { recursive: true, force: true });
      }),
    connect: (name) => {
      calls.push(`connect ${name}`);
      if (!hasPod(name))
        return closedConnection(`error: pod "${name}" not found`);
      const connection = spawnConnection("node", [relay], {
        cwd: volume(name),
      });
      const held = connections.get(name) ?? new Set();
      held.add(connection);
      connections.set(name, held);
      connection.onClose(() => held.delete(connection));
      return connection;
    },
  };
};
