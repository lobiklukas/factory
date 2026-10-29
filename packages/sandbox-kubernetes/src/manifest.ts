/**
 * The `Sandbox` custom resource a Kubernetes sandbox is (LOB-89), and how its status is read.
 *
 * One `agents.x-k8s.io/v1beta1` `Sandbox` per sandbox, from the released agent-sandbox controller
 * pinned in `infra/kind/agent-sandbox/` (v1.0.8). The controller turns it into one pod and one PVC:
 * the pod runs the sandbox image doing nothing until a command arrives, and the PVC
 * (`workspace-<name>`, from the resource's `volumeClaimTemplates`) is mounted at the sandbox's
 * workdir, so the files outlive the pod. Pausing is the resource's `operatingMode: Suspended`: the
 * controller deletes the pod and keeps the PVC; `Running` brings a new pod over the same volume.
 *
 * Requests are small on purpose — this runs on a laptop's one kind node beside everything else —
 * and there is no `runtimeClassName`: locally nothing isolates a sandbox (D4's caveat, R2).
 */
import { Schema } from "effect";

export const SANDBOX_API_VERSION = "agents.x-k8s.io/v1beta1";

/**
 * The sandbox image (infra/sandbox/Dockerfile, D13), pinned: `infra/sandbox/IMAGE` holds the same
 * tag, and a test fails when the two disagree or either says `latest`.
 */
export const SANDBOX_IMAGE = "factory-sandbox:0.1.0";

/** The container the sandbox's commands run in; `kubectl exec -c` names it. */
export const SANDBOX_CONTAINER = "sandbox";

/** What a sandbox's resource is made from. */
export type SandboxManifestOptions = {
  readonly name: string;
  readonly namespace: string;
  /** Where the workspace volume is mounted, which is the sandbox's workdir. */
  readonly workdir: string;
  readonly image?: string;
  /** The workspace volume's size, as a Kubernetes quantity. */
  readonly storage?: string;
};

export type SandboxManifest = ReturnType<typeof sandboxManifest>;

/** The label every resource the runtime makes carries, so an operator can find (and delete) them. */
export const MANAGED_BY = { "app.kubernetes.io/managed-by": "factory" };

export const sandboxManifest = (options: SandboxManifestOptions) => ({
  apiVersion: SANDBOX_API_VERSION,
  kind: "Sandbox",
  metadata: {
    name: options.name,
    namespace: options.namespace,
    labels: { ...MANAGED_BY, "factory.dev/sandbox": options.name },
  },
  spec: {
    operatingMode: "Running",
    podTemplate: {
      metadata: {
        labels: { ...MANAGED_BY, "factory.dev/sandbox": options.name },
      },
      spec: {
        // A sandbox talks to nothing in the cluster: no service-account token in its filesystem.
        automountServiceAccountToken: false,
        // The container's main process only waits, so a pause need not wait out the default 30 s.
        terminationGracePeriodSeconds: 2,
        containers: [
          {
            name: SANDBOX_CONTAINER,
            image: options.image ?? SANDBOX_IMAGE,
            // Loaded into kind's node (`kind load docker-image`), never pulled.
            imagePullPolicy: "IfNotPresent",
            command: ["sh", "-c", "trap 'exit 0' TERM; sleep infinity & wait"],
            workingDir: options.workdir,
            resources: {
              requests: { cpu: "50m", memory: "64Mi" },
              limits: { memory: "1Gi" },
            },
            volumeMounts: [{ name: "workspace", mountPath: options.workdir }],
          },
        ],
      },
    },
    volumeClaimTemplates: [
      {
        metadata: { name: "workspace", labels: { ...MANAGED_BY } },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: options.storage ?? "1Gi" } },
        },
      },
    ],
  },
});

const Condition = Schema.Struct({
  type: Schema.String,
  status: Schema.String,
  reason: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  observedGeneration: Schema.optional(Schema.Int),
});
export type Condition = typeof Condition.Type;

/** The part of a `Sandbox` the runtime reads back: its mode, its generation and its conditions. */
export const SandboxObject = Schema.Struct({
  metadata: Schema.Struct({
    name: Schema.String,
    generation: Schema.optional(Schema.Int),
  }),
  spec: Schema.Struct({
    operatingMode: Schema.optional(Schema.String),
  }),
  status: Schema.optional(
    Schema.Struct({
      conditions: Schema.optional(Schema.Array(Condition)),
    }),
  ),
});
export type SandboxObject = typeof SandboxObject.Type;

/**
 * Where a sandbox is, judged only from conditions the controller wrote for its current generation:
 * right after a mode change the old `Ready` is still there, and it must not be read as the answer.
 *
 * - `running`: `Ready` is `True` — the pod is up with the volume mounted.
 * - `suspended`: `Suspended` is `True` with `PodTerminated` — the pod is gone, the volume is kept.
 * - `failed`: the controller says it cannot get there (`PodFailed`, `InvalidConfiguration`).
 * - `pending`: anything else, for now.
 */
export type SandboxPhase =
  | { readonly _tag: "running" }
  | { readonly _tag: "suspended" }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "pending"; readonly message: string };

const FAILED_REASONS = new Set(["PodFailed", "InvalidConfiguration"]);

export const phaseOf = (sandbox: SandboxObject): SandboxPhase => {
  const generation = sandbox.metadata.generation;
  const current = (sandbox.status?.conditions ?? []).filter(
    (condition) =>
      generation === undefined ||
      condition.observedGeneration === undefined ||
      condition.observedGeneration === generation,
  );
  const named = (type: string) =>
    current.find((condition) => condition.type === type);
  const ready = named("Ready");
  const suspended = named("Suspended");
  if (sandbox.spec.operatingMode === "Suspended") {
    return suspended?.status === "True" && suspended.reason === "PodTerminated"
      ? { _tag: "suspended" }
      : {
          _tag: "pending",
          message: suspended?.message ?? "the pod is still being deleted",
        };
  }
  if (ready?.status === "True") return { _tag: "running" };
  if (ready?.reason !== undefined && FAILED_REASONS.has(ready.reason)) {
    return { _tag: "failed", message: ready.message ?? ready.reason };
  }
  return {
    _tag: "pending",
    message:
      ready?.message || ready?.reason || "the controller has not reported yet",
  };
};
