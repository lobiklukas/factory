/* oxlint-disable effecttsgo/process-env -- a suite run by hand names its cluster in its environment. */
/**
 * The Kubernetes runtime against real kind (LOB-89, LOB-91; LOB-13's proof): the shared
 * `SandboxRuntime` cases — pause and resume keeping the files included — and Pi Durable's
 * `ExecutionEnv` suite, every case over a real `Sandbox`, a real pod and a real PVC, reached through
 * `kubectl exec -i` into the sandbox image's relay.
 *
 * Not in `bun run test`: `bun run test:kind` (or verify-sandbox's `conformance.sh`) runs it, after
 * `up.sh`. `KIND_CLUSTER` names the cluster (default factory-sandbox) and `SANDBOX_NAMESPACE` the
 * namespace (default factory-conformance). Each case makes its own sandbox and deletes it, so a
 * case costs a pod start: the suite takes minutes, and every timeout here is the cluster's.
 */
import { BunServices } from "@effect/platform-bun";
import { registerSandboxRuntimeConformance } from "@repo/sandbox/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Kubernetes, kubectlCluster } from "./index";

const cluster = process.env["KIND_CLUSTER"] ?? "factory-sandbox";
const namespace = process.env["SANDBOX_NAMESPACE"] ?? "factory-conformance";

const layer = Layer.unwrap(
  kubectlCluster({ context: `kind-${cluster}`, namespace }).pipe(
    Effect.map((live) => Kubernetes.layer({ cluster: live })),
  ),
).pipe(Layer.provide(BunServices.layer));

// A case's own timeout is sized for a local process; here each one also starts and deletes a pod.
const slow = (name: string, run: () => Promise<void>, timeoutMs?: number) =>
  it(name, run, Math.max(timeoutMs ?? 0, 180_000));

registerSandboxRuntimeConformance({ describe, expect, it: slow }, `kubernetes runtime (kind-${cluster})`, layer);
