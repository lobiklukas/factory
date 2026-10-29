/**
 * The `Sandbox` resource the runtime makes, and the pins it rests on (LOB-89, LOB-90): the image
 * tag is the one `infra/sandbox/IMAGE` builds and never `latest`, the vendored agent-sandbox release
 * is byte for byte the one its checksum names, and the CRD it installs serves the API version and
 * the `operatingMode` values the runtime writes. Then how status is read: only the conditions of the
 * current generation count.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { phaseOf, SANDBOX_API_VERSION, SANDBOX_IMAGE, type SandboxObject, sandboxManifest } from "./manifest";

const ROOT = join(import.meta.dirname, "../../..");
const RELEASE = join(ROOT, "infra/kind/agent-sandbox/sandbox-v1.0.8.yaml");

describe("sandbox manifest", () => {
  it("pins the image infra/sandbox/IMAGE builds, never latest", () => {
    const built = readFileSync(join(ROOT, "infra/sandbox/IMAGE"), "utf8").trim();
    expect(SANDBOX_IMAGE).toBe(built);
    expect(SANDBOX_IMAGE).toMatch(/^[a-z0-9./-]+:[0-9][\w.-]*$/);
    expect(SANDBOX_IMAGE.endsWith(":latest")).toBe(false);
    const manifest = sandboxManifest({ name: "sbx-a", namespace: "ns", workdir: "/workspace/sbx-a" });
    expect(manifest.spec.podTemplate.spec.containers[0]?.image).toBe(SANDBOX_IMAGE);
  });

  it("mounts one workspace claim at the workdir, asks for little, and mounts no service-account token", () => {
    const manifest = sandboxManifest({ name: "sbx-a", namespace: "ns", workdir: "/workspace/sbx-a" });
    expect(manifest).toMatchObject({
      apiVersion: "agents.x-k8s.io/v1beta1",
      kind: "Sandbox",
      metadata: { name: "sbx-a", namespace: "ns", labels: { "app.kubernetes.io/managed-by": "factory" } },
      spec: { operatingMode: "Running" },
    });
    const pod = manifest.spec.podTemplate.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod).not.toHaveProperty("runtimeClassName");
    expect(pod.containers).toHaveLength(1);
    expect(pod.containers[0]).toMatchObject({
      name: "sandbox",
      workingDir: "/workspace/sbx-a",
      volumeMounts: [{ name: "workspace", mountPath: "/workspace/sbx-a" }],
      resources: { requests: { cpu: "50m", memory: "64Mi" } },
    });
    expect(manifest.spec.volumeClaimTemplates).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ name: "workspace" }),
        spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } },
      }),
    ]);
  });

  it("vendors the agent-sandbox v1.0.8 release byte for byte, with its controller pinned", () => {
    const sums = readFileSync(join(ROOT, "infra/kind/agent-sandbox/SHA256SUMS"), "utf8");
    const digest = createHash("sha256").update(readFileSync(RELEASE)).digest("hex");
    expect(sums.trim()).toBe(`${digest}  sandbox-v1.0.8.yaml`);
    const release = readFileSync(RELEASE, "utf8");
    expect(release).toContain("image: registry.k8s.io/agent-sandbox/agent-sandbox-controller:v1.0.8");
  });

  it("writes only what the vendored CRD serves: its API version and its operating modes", () => {
    const release = readFileSync(RELEASE, "utf8");
    const [group, version] = SANDBOX_API_VERSION.split("/");
    expect(release).toContain(`group: ${group}`);
    expect(release).toMatch(new RegExp(`name: ${version}\\n\\s+schema:`));
    expect(release).toMatch(/operatingMode:\n\s+default: Running\n\s+enum:\n\s+- Running\n\s+- Suspended/);
  });

  it("pins kind's node image by digest", () => {
    const cluster = readFileSync(join(ROOT, "infra/kind/cluster.yaml"), "utf8");
    expect(cluster).toMatch(/image: kindest\/node:v[\d.]+@sha256:[0-9a-f]{64}/);
    expect(cluster).toContain("name: factory-sandbox");
  });
});

const object = (
  mode: string,
  generation: number,
  conditions: NonNullable<NonNullable<SandboxObject["status"]>["conditions"]>,
): SandboxObject => ({
  metadata: { name: "sbx-a", generation },
  spec: { operatingMode: mode },
  status: { conditions },
});

describe("sandbox phase", () => {
  it("is running only when Ready is True for the current generation", () => {
    const ready = { type: "Ready", status: "True", reason: "DependenciesReady" };
    expect(phaseOf(object("Running", 3, [{ ...ready, observedGeneration: 3 }]))._tag).toBe("running");
    // A Ready left from before the resume is not this generation's answer.
    expect(phaseOf(object("Running", 3, [{ ...ready, observedGeneration: 2 }]))._tag).toBe("pending");
  });

  it("is suspended only once the pod is terminated, not while it is terminating", () => {
    const suspended = (reason: string) =>
      object("Suspended", 2, [{ type: "Suspended", status: "True", reason, observedGeneration: 2 }]);
    expect(phaseOf(suspended("PodTerminated"))._tag).toBe("suspended");
    expect(phaseOf(suspended("PodTerminating"))._tag).toBe("pending");
  });

  it("is failed when the controller says the pod failed or the resource is invalid", () => {
    for (const reason of ["PodFailed", "InvalidConfiguration"]) {
      expect(
        phaseOf(object("Running", 1, [{ type: "Ready", status: "False", reason, message: "no", observedGeneration: 1 }])),
      ).toEqual({ _tag: "failed", message: "no" });
    }
  });

  it("is pending with the controller's message otherwise", () => {
    expect(
      phaseOf(
        object("Running", 1, [
          {
            type: "Ready",
            status: "False",
            reason: "DependenciesNotReady",
            message: 'Container "sandbox" is waiting: ErrImageNeverPull',
            observedGeneration: 1,
          },
        ]),
      ),
    ).toEqual({ _tag: "pending", message: 'Container "sandbox" is waiting: ErrImageNeverPull' });
    expect(phaseOf(object("Running", 1, []))._tag).toBe("pending");
  });
});
