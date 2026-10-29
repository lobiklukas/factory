---
name: verify-sandbox
description: Bring up the local Kubernetes sandbox tier (kind + the pinned agent-sandbox controller + the sandbox image) and prove the Kubernetes SandboxRuntime on it (LOB-89, LOB-91, LOB-90) — create → pause → resume → destroy with the Sandbox resource read back after each step, a workspace file surviving the pause on its PVC, a harness session whose command runs inside the pod, the image's tool versions, and the SandboxRuntime + Pi Durable ExecutionEnv conformance suites over real pods. Use when asked to verify the kind tier, packages/sandbox-kubernetes, infra/kind or infra/sandbox, or after changing any of them.
---

# Verify the sandbox tier

Proves the Kubernetes runtime the way a session meets it: real `Sandbox` resources on a one-node kind
cluster, a real pod per sandbox, a real PVC per workspace, and every command and file operation run
inside the pod through the environment relay (`kubectl exec --stdin … factory-env-relay`). Nothing
here runs in `bun run test`: the gate holds the same runtime to the same suites against a fake
cluster, and this is the live half.

```sh
bash .pi/skills/verify-sandbox/up.sh            # cluster + CRD + controller, the image built and loaded, doctor
bash .pi/skills/verify-sandbox/doctor.sh        # read-only: READY or NOT READY (exit 1), never a skip
bun  .pi/skills/verify-sandbox/drive.ts         # the lifecycle drive: 13 checks → .verify/sandbox/drive.json
bash .pi/skills/verify-sandbox/conformance.sh   # 40 cases over real pods, ~6 min → .verify/sandbox/conformance.log
bash .pi/skills/verify-sandbox/down.sh          # delete the cluster; fails if a node container survives
```

Env: `KIND_CLUSTER` (default `factory-sandbox`, context `kind-factory-sandbox`), `SANDBOX_NAMESPACE`
(the drive's `factory-verify`, the suite's `factory-conformance`), `EVIDENCE_DIR` (`.verify/sandbox`).
No port is bound on the host and no credential is read: kind's API server is reached through its own
kubeconfig context, the model is pi-ai's faux provider, and the "credential" the session check
blanks is the drive's throwaway value. Keep the cluster small — other gates share this machine — and
run `./down.sh` when done; nothing should be left running.

Needs `docker` (a daemon that answers), `kind` and `kubectl` on PATH. Without kind, `up.sh` stops at
`infra/kind/up.sh: kind is not installed (not on PATH)…` and `doctor.sh` at
`doctor: NOT READY — kind is required and missing; install it, then run ./up.sh`; both exit 1.

## What it proves

| Check (drive.ts)                                                                                                                  | Why it matters                                                       |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| create: the `Sandbox` is `Running` and `Ready` for its current generation; pod `Running` on the pinned image; PVC `Bound`         | the controller made what the manifest asked for                      |
| create: a command's `hostname` is the sandbox's name and its `pwd -P` is the workdir on the volume                                | commands run inside the pod, not on the host                         |
| pause: `Suspended`/`PodTerminated`, `Ready` `False`/`SandboxSuspended`, no pod, the same PVC still `Bound`                        | a pause stops compute and keeps the files                            |
| pause: an operation on the paused sandbox is refused                                                                              | nothing silently wakes or waits on a paused sandbox                  |
| resume: `Ready` again, a new pod (another uid) over the same PVC (same uid)                                                       | a resume is a new pod on the old volume                              |
| resume: the file written before the pause reads back, through the runtime and through `kubectl exec`                              | PVC persistence across pause/resume (LOB-91)                         |
| destroy: the `Sandbox`, its pod and its PVC are gone                                                                              | a destroyed sandbox leaves nothing running or stored                 |
| destroy: a second destroy succeeds and changes nothing                                                                            | destroy is idempotent                                                |
| session: the faux model's `bash` command prints the pod's hostname and writes a marker read back from the pod, absent on the host | a harness session opened with the runtime runs in the pod            |
| session: a host credential's name reaches the pod's command set and blank (`${NAME-unset}` prints empty, not `unset`)             | the filter's per-command variables reach the pod; no host value does |
| session: closing the session deletes its sandbox, pod and PVC                                                                     | a session's sandbox ends with it                                     |
| image: `factory-sandbox-versions` prints bun, node, git, gh, ripgrep, Pi Durable and the harness                                  | the D13 base is what the pods run (LOB-90)                           |
| nothing is left in the drive's namespace                                                                                          | no leak across runs                                                  |

`conformance.sh` adds the shared `SandboxRuntime` cases (19, pause/resume keeping a file included)
and Pi Durable's `registerEnvConformance` (21) — each over its own real sandbox.

## What it cannot prove

Isolation. Kind nodes are containers and there is no `RuntimeClass` or gVisor here, so a sandbox is
separated from nothing and the runtime's descriptor says `isolation: "none"` (D4, R2); that waits for
M7. Also out of reach locally: the volume's size limit (local-path does not enforce the `1Gi`
request), warm pools and claims (the agent-sandbox extensions are not installed), and GKE's storage
and networking. The image is built for this machine's architecture only.
