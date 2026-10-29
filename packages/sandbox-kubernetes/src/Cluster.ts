/**
 * What the Kubernetes runtime needs of a cluster (LOB-89): five operations on `Sandbox` resources
 * and one way into a sandbox's pod. `./Kubectl` serves them with `kubectl` against a real cluster
 * (local kind); `./testing` serves them with a fake one — resources in memory, a directory per
 * volume, a local relay process per pod — so the runtime's logic runs in the gate without kind.
 *
 * The seam is the resource, not the CLI: what the fake models is the controller's contract (a
 * `Sandbox` becomes `Ready`, a suspended one loses its pod and keeps its volume, a deleted one takes
 * both with it), and what only the real controller can show is left to the verify-sandbox drive.
 */
import { type Effect, type Option, Schema } from "effect";
import type { SandboxManifest, SandboxObject } from "./manifest";
import type { Connection } from "./relay/connection";

/** A cluster operation failed: `kubectl` could not run, or the API server refused it. */
export class ClusterError extends Schema.TaggedError<ClusterError>()(
  "ClusterError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export type OperatingMode = "Running" | "Suspended";

export type SandboxClusterShape = {
  /** The cluster and namespace, for the environment's file namespace and for messages. */
  readonly name: string;
  /** The namespace every sandbox's resources live in. */
  readonly namespace: string;
  /** Where sandbox `name`'s volume is mounted in its pod: the sandbox's workdir. */
  readonly workdir: (name: string) => string;
  /** Create the resource; one that already exists is a failure, not an update. */
  readonly create: (manifest: SandboxManifest) => Effect.Effect<void, ClusterError>;
  /** The resource as the API server has it now, or `None` when there is none. */
  readonly read: (name: string) => Effect.Effect<Option.Option<SandboxObject>, ClusterError>;
  /** Set `spec.operatingMode`: `Suspended` pauses, `Running` resumes. */
  readonly setMode: (name: string, mode: OperatingMode) => Effect.Effect<void, ClusterError>;
  /**
   * Delete the resource and wait until it, its pod and its volume are gone. A resource that does not
   * exist is already deleted.
   */
  readonly remove: (name: string) => Effect.Effect<void, ClusterError>;
  /**
   * A connection to the relay in sandbox `name`'s pod (`factory-env-relay`, started by the call), for
   * its `ExecutionEnv`. It fails as a closed connection when there is no pod to reach.
   */
  readonly connect: (name: string) => Connection;
};
