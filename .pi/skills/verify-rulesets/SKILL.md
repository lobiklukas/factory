---
name: verify-rulesets
description: Drive and prove the GitHub rulesets of D15 as reviewed code (LOB-30) — `bun infra/src/rulesets.ts plan|apply|verify|probe` against a loopback GitHub that enforces the rulesets on `git push`. Use when asked to verify, test, or show evidence that `main` is PR-only, that a force-push or deletion of a `factory/**` branch is refused by the forge rather than by a hook, that a deleted or weakened ruleset is caught, or after changing `infra/`.
---

# Verify the rulesets

Proves the boundary half of D15 the way an operator meets it: the real command
(`infra/src/rulesets.ts`), as a child process, against `infra/src/testing/githubFake.ts` — the
rulesets REST routes plus git's smart-HTTP push path, with a `pre-receive` that enforces whatever
rulesets the forge holds. Pushes are plain `git`; no session, no harness, no policy hook is in the
path, so every refusal recorded here is the forge's.

```sh
bun .pi/skills/verify-rulesets/drive.ts   # FORGE_PORT (9521), CANARY_PORT (9522), EVIDENCE_DIR (.verify/rulesets)
```

No API, no database, no model. Nothing leaves loopback: the CLI child runs as `bun --no-env-file`
(Bun otherwise loads the checkout's `.env` into a child even when `env` is given) with
`GITHUB_API_URL` at the fake and only the variables it needs, so no `GITHUB_APP_*` of the caller's
can reach it, and both tokens are the drive's own throwaway values. Every child — the CLI, the git
it spawns, the drive's own pushes — has `HTTP(S)_PROXY` at an egress canary on `CANARY_PORT` and
`NO_PROXY=127.0.0.1`, so a request to any other host lands in the canary instead of the network.

## What it proves

| Check                                                                                         | Why it matters                                           |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `plan` on a bare repo lists two creates and writes nothing; `verify` fails naming both        | the read-back sees an unprotected repo                   |
| `apply` creates both, its own read-back is clean; `verify` passes; a second `apply` writes 0  | the declared policy is what lands, and apply converges   |
| `probe`: seed accepted; force-push and deletion of `factory/ruleset-probe` refused by `GH013` | the force-push is rejected by the forge, not by our hook |
| the forge classified create / force / delete itself (`git merge-base`) and refused the latter | the probe did not tell the forge what it was doing       |
| a fast-forward push straight to `main` is refused (`Changes must be made through a PR`)       | the default branch is PR-only for the factory's pusher   |
| a force-push to `feature/x` is accepted                                                       | the forge refuses only what a ruleset forbids            |
| a `factory/**` ruleset deleted in the UI fails `verify`, naming it                            | deleting a ruleset fails a test                          |
| …and the `probe` then fails because the force-push lands                                      | the refusal was the ruleset's (the control)              |
| `apply` restores it; `verify` and `probe` pass again                                          | drift is repairable from the code                        |
| the factory's App added as a bypass actor fails `verify` and `probe`; `apply` removes it      | "no app bypass" is checked, not assumed                  |
| `GITHUB_RULESETS_TOKEN` equal to `GITHUB_TOKEN` is refused before any request                 | the push credential cannot edit its own boundary         |
| the egress canary saw no request from any child                                               | nothing left loopback                                    |
| …and a control call at a non-loopback API root is caught by it                                | the canary would have seen one                           |

A full run is **17/17 checks** (`drive.json` → `passed: true`). Evidence in `.verify/rulesets/`:
`drive.json` (every check and every CLI invocation with its stdout, stderr and exit code),
`probe-enforced.json` and `probe-ruleset-deleted.json` (the two probe reports), and
`forge-ledger.json` (every REST request, every push decision, and the final rulesets).

## What it cannot prove

That GitHub enforces rulesets the way `infra/src/rulesets/enforce.ts` models them. That is the live
probe's job, run by an operator against a real repository (never in the gate):

```sh
GITHUB_RULESETS_TOKEN=<admin token> bun run rulesets apply  --repo <owner/name>
GITHUB_RULESETS_TOKEN=<admin token> bun run rulesets verify --repo <owner/name>
GITHUB_TOKEN=<the factory's push token> bun run rulesets probe --repo <owner/name>   # or GITHUB_APP_*
```

The scheduled read-back is `.github/workflows/rulesets.yml` (`verify` daily, inert until the
`RULESETS_ADMIN_TOKEN` secret exists). Until then, a ruleset deleted in GitHub's settings fails
only the next hand-run `verify`.

`probe` pushes only to `factory/ruleset-probe` (never to `main`), and leaves that branch behind,
because the deletion rule keeps it.
