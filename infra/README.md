# infra

The factory's infrastructure as reviewed code (docs/design.md D5, D15). It holds the GitHub rulesets
the enforcement boundary rests on (LOB-30, R3), and the local sandbox tier (LOB-90): a kind
bootstrap and the sandbox image. Nothing here provisions anything in a cloud.

| File                        | What it is                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `src/rulesets/policy.ts`    | The declared rulesets: default branch PR-only, `factory/**` append-only, no bypass |
| `src/rulesets/github.ts`    | The rulesets REST client (the provider): list, get, create, update, delete         |
| `src/rulesets/reconcile.ts` | Diff, plan, apply, and the read-back that fails on any drift                       |
| `src/rulesets/probe.ts`     | The live check: a force-push and a deletion at `factory/ruleset-probe`             |
| `src/rulesets/enforce.ts`   | GitHub's enforcement as the fakes model it                                         |
| `src/testing/githubFake.ts` | A loopback GitHub: the REST routes and `git push` with the rulesets enforced       |
| `src/rulesets.ts`           | The command                                                                        |

```sh
GITHUB_RULESETS_TOKEN=… bun run rulesets plan   --repo owner/name   # what apply would change
GITHUB_RULESETS_TOKEN=… bun run rulesets apply  --repo owner/name   # make it so, then read back
GITHUB_RULESETS_TOKEN=… bun run rulesets verify --repo owner/name   # read back; non-zero on drift
GITHUB_TOKEN=…          bun run rulesets probe  --repo owner/name   # the forge refuses a force-push
```

`GITHUB_RULESETS_TOKEN` is an operator's token with the repository's Administration permission. It
must not be the factory's `GITHUB_TOKEN` (refused), and the factory's App must not be granted
Administration: an identity that can edit a ruleset can delete the boundary it is held by.
`--approvals` (default 1) shapes the PR-only ruleset. The branch is `~DEFAULT_BRANCH`, never a flag:
every ruleset's name is fixed, so no input can rename one into a prefixed ruleset apply would then
delete. `.github/workflows/rulesets.yml` runs `verify` daily against this repository once the
`RULESETS_ADMIN_TOKEN` secret holds an operator token; without it the job is a no-op notice.

Alchemy (D5) is not a dependency yet: v2 is a prerelease that needs a newer `effect` than this repo
pins. The provider is plain Effect code over `HttpClient`, so an Alchemy resource can wrap
`planRulesets` / `applyPlan` / `verifyRulesets` when `infra/alchemy.run.ts` lands. Proven by
`.pi/skills/verify-rulesets`.

## The local sandbox tier (`kind/`, `sandbox/`)

| File                                     | What it is                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `kind/cluster.yaml`                      | One kind node, `kindest/node:v1.37.0` pinned by digest; local-path provisions the PVCs      |
| `kind/agent-sandbox/sandbox-v1.0.8.yaml` | The agent-sandbox release manifest (CRD + controller), vendored byte for byte               |
| `kind/agent-sandbox/SHA256SUMS`          | Its checksum; `up.sh` and a test refuse a manifest that differs                             |
| `kind/up.sh`                             | The one command: create the cluster (or reuse it), apply the release, wait until it answers |
| `sandbox/Dockerfile`                     | The D13 base: bun, node, git, gh, ripgrep, Pi Durable and the harness, plus the env relay   |
| `sandbox/IMAGE`                          | The pinned tag (`factory-sandbox:0.1.0`); the runtime's `SANDBOX_IMAGE` must equal it       |
| `sandbox/build.sh`                       | Build the image, print every tool's version from inside it, and load it into kind           |

```sh
bash infra/kind/up.sh                                    # cluster + CRD + controller (needs docker, kind, kubectl)
KIND_CLUSTER=factory-sandbox bash infra/sandbox/build.sh # the image, its versions, loaded into kind
kind delete cluster --name factory-sandbox               # everything goes with it
```

Without kind, `up.sh` exits 1 with `infra/kind/up.sh: kind is not installed (not on PATH); the
sandbox tier needs docker, kind and kubectl`. The runtime that uses all this is
`packages/sandbox-kubernetes`; it is proven by `.pi/skills/verify-sandbox`. Isolation is not: kind
has no gVisor (R2).
