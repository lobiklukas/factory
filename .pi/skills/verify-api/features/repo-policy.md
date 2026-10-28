# A repository's policy from `.factory/config` at the base (S-factory-config-as-code)

**What it is.** A repository tightens what its sessions' runs may do in reviewed code: a `policy`
block in its `.factory/config`, beside the commands `install`, `build`, `test` and `verify`.

```json
{
  "install": "bun install",
  "policy": {
    "approvalRequired": ["bun publish"],
    "deny": ["terraform destroy"],
    "allowedHosts": ["github.com"]
  }
}
```

- `approvalRequired` — gates added to the deployment's `APPROVAL_REQUIRED`: a `bash` call that runs
  one parks on an approval (LOB-52's prompt).
- `deny` — command prefixes refused outright, read the way a gate is (flags between the words,
  `sudo` and `sh -c` read through), with no approval that lifts them.
- `allowedHosts` — the session's egress allowlist narrowed to these. Each must be one the deployment
  allows.

The block is read once per session, by its first open, **at the session's base ref** — in the
registered checkout, or the factory's clone of a URL-only repo, with `git cat-file`
(`packages/core/src/repoPolicy.ts`) — never from the worktree. It is merged under the deployment's
policy and over the column's (`withRepoPolicy`, then `withColumnAutonomy`, in
`packages/harness/src/policy.ts`), each tighten-only, and the open commits the result to the log as
the `factory.policy` document (`readPolicyRecord`): where the repository's policy was read (ref,
commit, path, whether a config was found), what it declared, and the effective rules the run met. A
later open of the same session uses the pinned policy, so an agent that rewrites `.factory/config` on
its branch — or a base that relaxes under a running session — changes nothing for that run; the next
session reads the base as it is then.

A config that tries to allow something the deployment denies (a host off its allowlist), whose block
has a key the policy does not know (`allow`, `pushRefPrefixes`) or the wrong shape, or that is not
JSON, is refused at load with a typed `RepoPolicyRejected`; the session does not open and the call
answers `policy_rejected`, naming the repo, the base, the commit and each problem. A refused create
leaves no session behind.

**How a user reaches it.** Commit a `policy` block to `.factory/config` on the repo's base branch;
the next session on that repo runs under it.

**How to drive it.** `./repo-policy.sh` (API on `API_PORT`, default `:9441`; faux, its
`FAUX_COMMAND` is `./bin/bun publish` on every turn). Each fixture commits `bin/bun`, a script that
only echoes a marker, so the gate reads the call as `bun publish` and an ungated run executes the
fixture's script and nothing else. The API is booted twice; the second boot is a fresh process
reopening the first one's logs.

| Phase    | Scenario   | Check                                                                                             |
| -------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `arm`    | `gated`    | the run parks on one approval, action `bun publish`                                               |
| `arm`    | `gated`    | the bash result is the blocked call; the marker is absent                                         |
| `arm`    | `gated`    | `factory.policy` names `main`, the base commit, `.factory/config`, the repo's gate, the effective |
| `arm`    | `bare`     | no config: no approval, and the marker is in the bash result                                      |
| `arm`    | `bare`     | `factory.policy` records `found: false` and no repo gate                                          |
| `arm`    | `denying`  | `deny: ["bun publish"]`: refused outright, no approval asked, no marker                           |
| `arm`    | `widening` | `allowedHosts: ["evil.example"]`: the create fails `policy_rejected`, naming the host             |
| `arm`    | `widening` | the refused create leaves no session row                                                          |
| `verify` | `edited`   | the session's branch holds the `{}` config the "agent" committed in its worktree                  |
| `verify` | `edited`   | on the fresh process the run still meets the gate: one approval, no marker                        |
| `verify` | `edited`   | after `main` itself relaxes, the session still meets the gate; its record keeps `bun publish`     |
| `verify` | `fresh`    | a new session on the repo reads the relaxed base: no approval, the marker                         |

Evidence: `.verify/evidence/latest/api/repo-policy-arm.json`, `repo-policy-verify.json`,
`repo-policy.log` and both API logs.

**What is not built.** Per-repo `roles` model overrides and trigger rules in the same file; showing
the effective policy in the dashboard or CLI; generating LOB-30's rulesets from `factory.policy`.
