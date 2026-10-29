// The sandbox tier on local kind, driven end to end (LOB-89, LOB-91, LOB-90): the Kubernetes
// runtime's lifecycle with the `Sandbox` resource read back after every step, a workspace file that
// survives a pause, a harness session whose command runs inside the pod, and the image's tools.
//
//   bash .pi/skills/verify-sandbox/up.sh && bun .pi/skills/verify-sandbox/drive.ts
//
// Checks:
//   1. create: the resource is Running and Ready for its current generation, its pod is Running on
//      the pinned image, its workspace PVC is Bound; a command runs in the pod (its hostname is the
//      sandbox's name) and writes a file onto the volume
//   2. pause: the resource is Suspended (`PodTerminated`) and not Ready (`SandboxSuspended`), the
//      pod is gone, the PVC is still Bound — the same claim; every operation is refused
//   3. resume: Ready again, a new pod (another uid) over the same PVC (same uid), and the file
//      written before the pause reads back, through the runtime and through `kubectl exec`
//   4. destroy: the resource, the pod and the PVC are gone; a second destroy succeeds and changes
//      nothing
//   5. a harness session opened with the Kubernetes runtime: the scripted model's `bash` command
//      runs in the pod (it prints the pod's hostname), writes a marker read back from the pod and
//      absent from the session's host directory, and sees a host credential's name set and blank —
//      the filter's per-command variables crossed the relay, and the host's value did not; closing
//      the session deletes its sandbox
//   6. the image the pods run contains bun, node, git, gh, ripgrep, Pi Durable and the harness, each
//      printing its version from inside it
//   7. nothing is left in the drive's namespace, which is then deleted
//
// Nothing leaves this machine: the cluster is kind's containers, the model is pi-ai's faux provider,
// and no token exists — the "credential" in check 5 is the drive's own throwaway value.
//
// Env: KIND_CLUSTER (default factory-sandbox), SANDBOX_NAMESPACE (default factory-verify),
// EVIDENCE_DIR (default .verify/sandbox).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BunServices } from "@effect/platform-bun";
import {
  closeSession,
  createModelAccess,
  openSession,
  projectView,
  submitMessage,
} from "@repo/harness";
import {
  Kubernetes,
  kubectlCluster,
  SANDBOX_IMAGE,
} from "@repo/sandbox-kubernetes";
import { Effect, Exit } from "effect";

const ROOT = path.resolve(import.meta.dir, "../../..");
const KIND_CLUSTER = process.env["KIND_CLUSTER"] ?? "factory-sandbox";
const CONTEXT = `kind-${KIND_CLUSTER}`;
const NAMESPACE = process.env["SANDBOX_NAMESPACE"] ?? "factory-verify";
const EVIDENCE_DIR = path.resolve(
  ROOT,
  process.env["EVIDENCE_DIR"] ?? ".verify/sandbox",
);
const TOKEN_NAME = "FACTORY_SANDBOX_DRIVE_TOKEN";

mkdirSync(EVIDENCE_DIR, { recursive: true });

type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: unknown;
};
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      ${JSON.stringify(detail)}`);
};

const kubectl = (...args: string[]): string =>
  execFileSync(
    "kubectl",
    ["--context", CONTEXT, "--namespace", NAMESPACE, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

type Condition = {
  type: string;
  status: string;
  reason?: string;
  observedGeneration?: number;
};
type Resource = {
  metadata: { generation: number; uid: string };
  spec: { operatingMode: string };
  status?: { conditions?: Condition[] };
};

/** The `Sandbox` as the API server has it, or `undefined` when it is gone. */
const resource = (name: string): Resource | undefined => {
  const out = kubectl(
    "get",
    "sandboxes.agents.x-k8s.io",
    name,
    "--ignore-not-found",
    "-o",
    "json",
  );
  return out.trim() === "" ? undefined : (JSON.parse(out) as Resource);
};
/** A condition the controller wrote for the resource's current generation. */
const condition = (sandbox: Resource | undefined, type: string) =>
  sandbox?.status?.conditions?.find(
    (each) =>
      each.type === type &&
      each.observedGeneration === sandbox.metadata.generation,
  );
const pod = (name: string) => {
  const out = kubectl("get", "pod", name, "--ignore-not-found", "-o", "json");
  if (out.trim() === "") return undefined;
  const parsed = JSON.parse(out) as {
    metadata: { uid: string };
    status: { phase: string };
    spec: { containers: Array<{ image: string }> };
  };
  return {
    uid: parsed.metadata.uid,
    phase: parsed.status.phase,
    image: parsed.spec.containers[0]?.image,
  };
};
const pvc = (name: string) => {
  const out = kubectl(
    "get",
    "pvc",
    `workspace-${name}`,
    "--ignore-not-found",
    "-o",
    "json",
  );
  if (out.trim() === "") return undefined;
  const parsed = JSON.parse(out) as {
    metadata: { uid: string };
    status: { phase: string };
  };
  return { uid: parsed.metadata.uid, phase: parsed.status.phase };
};
const sandboxesLeft = () =>
  kubectl("get", "sandboxes.agents.x-k8s.io,pods,pvc", "-o", "name")
    .split("\n")
    .filter((line) => line.trim() !== "");

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const program = Effect.gen(function* () {
  const cluster = yield* kubectlCluster({
    context: CONTEXT,
    namespace: NAMESPACE,
  });
  const runtime = yield* Kubernetes.make({ cluster });

  // --- 1. create ---------------------------------------------------------------------------------
  const sandbox = yield* runtime.create;
  const created = resource(sandbox.id);
  const createdPod = pod(sandbox.id);
  const createdPvc = pvc(sandbox.id);
  check(
    "create: the Sandbox is Running and Ready for its generation; pod Running on the pinned image; PVC Bound",
    created?.spec.operatingMode === "Running" &&
      condition(created, "Ready")?.status === "True" &&
      condition(created, "Ready")?.reason === "DependenciesReady" &&
      createdPod?.phase === "Running" &&
      createdPod.image === SANDBOX_IMAGE &&
      createdPvc?.phase === "Bound",
    {
      id: sandbox.id,
      workdir: sandbox.workdir,
      conditions: created?.status?.conditions,
      pod: createdPod,
      pvc: createdPvc,
    },
  );
  const where = yield* runtime.exec(sandbox, "hostname; pwd -P");
  yield* runtime.writeFile(
    sandbox,
    "kept/before-pause.txt",
    "written before the pause",
  );
  check(
    "create: a command runs in the pod, at the workdir on the volume",
    where.exitCode === 0 &&
      where.stdout === `${sandbox.id}\n${sandbox.workdir}\n`,
    where,
  );

  // --- 2. pause ----------------------------------------------------------------------------------
  yield* runtime.pause(sandbox);
  const paused = resource(sandbox.id);
  const pausedPvc = pvc(sandbox.id);
  check(
    "pause: Suspended (PodTerminated), not Ready (SandboxSuspended), no pod, the same PVC still Bound",
    paused?.spec.operatingMode === "Suspended" &&
      condition(paused, "Suspended")?.status === "True" &&
      condition(paused, "Suspended")?.reason === "PodTerminated" &&
      condition(paused, "Ready")?.status === "False" &&
      condition(paused, "Ready")?.reason === "SandboxSuspended" &&
      pod(sandbox.id) === undefined &&
      pausedPvc?.phase === "Bound" &&
      pausedPvc.uid === createdPvc?.uid,
    {
      conditions: paused?.status?.conditions,
      pod: pod(sandbox.id),
      pvc: pausedPvc,
    },
  );
  const refused = yield* Effect.flip(runtime.exec(sandbox, "true"));
  check(
    "pause: an operation on the paused sandbox is refused, not run",
    refused.message.includes("is paused"),
    refused,
  );

  // --- 3. resume ---------------------------------------------------------------------------------
  yield* runtime.resume(sandbox);
  const resumed = resource(sandbox.id);
  const resumedPod = pod(sandbox.id);
  const resumedPvc = pvc(sandbox.id);
  check(
    "resume: Running and Ready again, a new pod over the same PVC",
    resumed?.spec.operatingMode === "Running" &&
      condition(resumed, "Ready")?.status === "True" &&
      resumedPod?.phase === "Running" &&
      resumedPod.uid !== createdPod?.uid &&
      resumedPvc?.uid === createdPvc?.uid,
    {
      conditions: resumed?.status?.conditions,
      pod: resumedPod,
      pvc: resumedPvc,
    },
  );
  const kept = text(yield* runtime.readFile(sandbox, "kept/before-pause.txt"));
  const keptInPod = kubectl(
    "exec",
    sandbox.id,
    "-c",
    "sandbox",
    "--",
    "cat",
    `${sandbox.workdir}/kept/before-pause.txt`,
  );
  check(
    "resume: the file written before the pause is there, through the runtime and through kubectl exec",
    kept === "written before the pause" &&
      keptInPod === "written before the pause",
    { kept, keptInPod },
  );

  // --- 4. destroy --------------------------------------------------------------------------------
  yield* runtime.destroy(sandbox);
  check(
    "destroy: the Sandbox, its pod and its PVC are gone",
    resource(sandbox.id) === undefined &&
      pod(sandbox.id) === undefined &&
      pvc(sandbox.id) === undefined,
    { left: sandboxesLeft() },
  );
  const again = yield* Effect.exit(runtime.destroy(sandbox));
  check(
    "destroy: destroying it again succeeds and changes nothing",
    Exit.isSuccess(again) && sandboxesLeft().length === 0,
    {
      exit: Exit.isSuccess(again) ? "success" : String(again.cause),
      left: sandboxesLeft(),
    },
  );

  // --- 5. a harness session over the runtime -----------------------------------------------------
  const host = mkdtempSync(path.join(tmpdir(), "verify-sandbox-session-"));
  process.env[TOKEN_NAME] = "drive-throwaway-not-a-credential";
  // `-unset` tells the two apart: the pod's own environment never has the name (kubectl exec carries
  // nothing of the host's), so `token=[unset]` means the filter's per-command variables did not
  // arrive over the relay, and `token=[]` means they did, blank.
  const command = `printf in-the-pod > marker.txt; hostname; printf "token=[%s]" "\${${TOKEN_NAME}-unset}"`;
  const session = yield* openSession({
    storage: new MemoryStorage(),
    model: createModelAccess("faux", {
      fauxCommand: command,
      fauxEveryTurn: true,
    }),
    cwd: host,
    sandbox: runtime,
  });
  const submitted = yield* submitMessage(session.root, {
    content: "mark the pod",
    requestId: "verify-sandbox-1",
  });
  const settled = yield* Effect.promise(() =>
    submitted.submission.wait(BACKGROUND_CONTEXT),
  );
  const view = yield* Effect.promise(() =>
    session.root.viewState(BACKGROUND_CONTEXT),
  );
  const bash = projectView(view.value).entries.filter(
    (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
  );
  view.dispose();
  const output = bash[0]?.kind === "toolResult" ? bash[0].text : "";
  const names = kubectl(
    "get",
    "sandboxes.agents.x-k8s.io",
    "-o",
    "jsonpath={.items[*].metadata.name}",
  )
    .trim()
    .split(" ");
  const name = names[0] ?? "";
  const marker =
    name === ""
      ? ""
      : kubectl(
          "exec",
          name,
          "-c",
          "sandbox",
          "--",
          "cat",
          `${cluster.workdir(name)}/marker.txt`,
        );
  check(
    "session: its bash command ran in the pod — hostname is the sandbox, the marker is on its volume and not on the host",
    settled.status === "done" &&
      names.length === 1 &&
      output.includes(name) &&
      marker === "in-the-pod" &&
      !existsSync(path.join(host, "marker.txt")),
    {
      status: settled.status,
      sandboxes: names,
      output,
      marker,
      hostMarker: existsSync(path.join(host, "marker.txt")),
    },
  );
  check(
    "session: a host credential's name reaches the pod's command set and blank — the filter's per-command variables arrive over the relay, the host's value does not",
    output.includes("token=[]"),
    { output },
  );
  yield* closeSession(session);
  delete process.env[TOKEN_NAME];
  rmSync(host, { recursive: true, force: true });
  check(
    "session: closing the session deletes its sandbox, pod and PVC",
    sandboxesLeft().length === 0,
    {
      left: sandboxesLeft(),
    },
  );
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const exit = await Effect.runPromiseExit(program);
if (Exit.isFailure(exit))
  check("the drive ran to the end", false, String(exit.cause));

// --- 6. the image ----------------------------------------------------------------------------------
try {
  const versions = execFileSync(
    "docker",
    ["run", "--rm", SANDBOX_IMAGE, "factory-sandbox-versions"],
    {
      encoding: "utf8",
    },
  );
  const wanted = [
    /^bun \d/m,
    /^node v\d/m,
    /^git version \d/m,
    /^gh version \d/m,
    /^ripgrep \d/m,
    /^pi-durable \d/m,
    /^harness loads/m,
  ];
  check(
    `image: ${SANDBOX_IMAGE} prints bun, node, git, gh, ripgrep, Pi Durable and the harness`,
    !SANDBOX_IMAGE.endsWith(":latest") &&
      wanted.every((pattern) => pattern.test(versions)),
    versions.trim().split("\n"),
  );
} catch (error) {
  check(`image: ${SANDBOX_IMAGE} runs its version check`, false, String(error));
}

// --- 7. nothing left ---------------------------------------------------------------------------------
const left = sandboxesLeft();
check("nothing of the drive is left in its namespace", left.length === 0, {
  left,
});
execFileSync(
  "kubectl",
  [
    "--context",
    CONTEXT,
    "delete",
    "namespace",
    NAMESPACE,
    "--ignore-not-found",
    "--wait=true",
  ],
  {
    stdio: "ignore",
  },
);

const passed = checks.every((each) => each.ok);
writeFileSync(
  path.join(EVIDENCE_DIR, "drive.json"),
  `${JSON.stringify({ passed, cluster: CONTEXT, namespace: NAMESPACE, image: SANDBOX_IMAGE, checks }, null, 2)}\n`,
);
console.log(
  `\n${checks.filter((each) => each.ok).length}/${checks.length} checks — ${passed ? "PASSED" : "FAILED"}`,
);
process.exit(passed ? 0 : 1);
