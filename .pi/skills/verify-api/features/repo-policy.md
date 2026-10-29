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
- `mcp` — the MCP servers the deployment registers (`MCP_SERVERS`) that its runs may call, and which
  of their tools; each server must be one the deployment registers. See
  [mcp-tools.md](mcp-tools.md) (S-agent-mcp-tools).

The block is read once per session, by its first open and before its worktree is cut, **at the
session's base ref** — in the registered checkout, or the factory's clone of a URL-only repo (at its
`refs/remotes/origin/<base>`), with `git cat-file` (`packages/core/src/repoPolicy.ts`) — never from
the worktree. A review run is read at its pull request's base, never at the head under review — fetched
first into the mirror, or into the checkout's `refs/remotes/factory/<base>` when the repo has a forge
URL (`reviewBaseStartFor`), because the worktree's own fetch is of the head — and a session based at
any other commit id at the repo's default base: the commit a run was cut at may be the change whose
rules are in question. It is merged under the deployment's
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
answers `policy_rejected`, naming the repo, the base, the commit and each problem. A base git cannot
read — the lookup of the ref, or the listing or read of the config at its commit, failing or timing
out (a loaded machine, a lock, a missing object) — is never read as "no policy" either: it is a typed
`RepoPolicyUnavailable` and the call answers `policy_unreadable`, which is transient — retry once git
answers. A refused create leaves no session, worktree or branch behind. Only a base git answers names
no commit (`rev-parse --verify` exiting 1) is warned about, and the run meets the deployment's policy
alone, recording no source, so a later open reads it; a mission's checks are refused instead. A
released session's open runs no work (it takes approvals, pages and its close), so there a config
that cannot be loaded or read is a warning and no repository policy rather than a refusal. A pinned
policy whose hosts the deployment has since dropped still opens, with a warning, and reaches none of
them.

**A limit: a review base the forge fetch cannot reach.** A reviewer's base fetch that fails is logged
and the base is read where the checkout or mirror already holds it — a stale tip reads that tip's
policy, and a branch neither holds is warned about and the reviewer runs read-only under the
deployment's policy and its column's alone. A session already in flight when this shipped has no
`factory.policy` record, so its next open reads the base and is held to it like a new one.

**A limit: a repo with no remote.** Its base is the registered checkout's local branch, and every
session worktree shares that checkout's refs. D11 guards `git push`, `git remote` and remote config,
not local ref writes, so an agent could `git update-ref refs/heads/main` in its worktree to a commit
with a relaxed `.factory/config`; its own run stays pinned, but the next session on the repo would
read it. With a forge URL a fresh session's open reads the fetched `refs/remotes/factory/<base>`
(C17) — unless that fetch failed, when it falls back to the local branch — and a URL-only repo's
reads its mirror's, both of which the fetch rewrites. Refusing local writes outside
`refs/heads/factory/<id>` is a follow-up.

**How a user reaches it.** Commit a `policy` block to `.factory/config` on the repo's base branch;
the next session on that repo runs under it.

**How to drive it.** `./repo-policy.sh` (API on `API_PORT`, default `:9444`; faux, its
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
| `arm`    | `widening` | the refused create leaves no worktree or `factory/<id>` branch in the checkout                    |
| `verify` | `edited`   | the session's branch holds the `{}` config the "agent" committed in its worktree                  |
| `verify` | `edited`   | on the fresh process the run still meets the gate: one approval, no marker                        |
| `verify` | `edited`   | after `main` itself relaxes, the session still meets the gate; its record keeps `bun publish`     |
| `verify` | `fresh`    | a new session on the repo reads the relaxed base: no approval, the marker                         |

Evidence: `.verify/evidence/latest/api/repo-policy-arm.json`, `repo-policy-verify.json`,
`repo-policy.log` and both API logs.

**What is not built.** Per-repo `roles` model overrides and trigger rules in the same file; showing
the effective policy in the dashboard or CLI; generating LOB-30's rulesets from `factory.policy`.
