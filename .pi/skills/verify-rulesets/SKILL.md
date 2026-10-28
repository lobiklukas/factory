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
bun .pi/skills/verify-rulesets/drive.ts          # FORGE_PORT (default 9521), EVIDENCE_DIR (.verify/rulesets)
```

No API, no database, no model. Nothing leaves loopback: the CLI child gets `GITHUB_API_URL` at the
fake and only the variables it needs (no `GITHUB_APP_*` of the caller's can reach it), and both
tokens are the drive's own throwaway values.

## What it proves

| Check                                                                                         | Why it matters                                           |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `plan` on a bare repo lists two creates and writes nothing; `verify` fails naming both        | the read-back sees an unprotected repo                   |
| `apply` creates both, its own read-back is clean; `verify` passes; a second `apply` writes 0  | the declared policy is what lands, and apply converges   |
| `probe`: seed accepted; force-push and deletion of `factory/ruleset-probe` refused by `GH013` | the force-push is rejected by the forge, not by our hook |
| the forge classified create / force / delete itself (`git merge-base`) and refused the latter | the probe did not tell the forge what it was doing       |
| a fast-forward push straight to `main` is refused (`Changes must be made through a PR`)       | `main` is PR-only for the factory's own pusher           |
| a force-push to `feature/x` is accepted                                                       | the forge refuses only what a ruleset forbids            |
| a `factory/**` ruleset deleted in the UI fails `verify`, naming it                            | deleting a ruleset fails a test                          |
| …and the `probe` then fails because the force-push lands                                      | the refusal was the ruleset's (the control)              |
| `apply` restores it; `verify` and `probe` pass again                                          | drift is repairable from the code                        |
| the factory's App added as a bypass actor fails `verify` and `probe`; `apply` removes it      | "no app bypass" is checked, not assumed                  |
| `GITHUB_RULESETS_TOKEN` equal to `GITHUB_TOKEN` is refused before any request                 | the push credential cannot edit its own boundary         |
| every request went to the loopback forge                                                      | isolation                                                |

A full run is **16/16 checks** (`drive.json` → `passed: true`). Evidence in `.verify/rulesets/`:
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

`probe` pushes only to `factory/ruleset-probe` (never to `main`), and leaves that branch behind,
because the deletion rule keeps it.
