# The branch pushed before the PR, the base fetched before the cut (C17)

**What it is.** The PR step publishes the branch it names. `SessionService.openPullRequest` hands
`prStep.ts`'s `openPullRequest` a push — `RepoRemote.push`, `git.ts`'s `pushBranch` with the
deployment's `CredentialProvider` — and the step runs it after the branch is measured and before
GitHub is called. A remote `factory/<id>` that moved past the session's branch is the
`non-fast-forward` outcome (`factory pr` prints `non_fast_forward`): no PR, no record, never a force.
Any other push failure is a `PrError` on `pushBranch`.

Before a session's worktree is cut from a registered checkout, the base is fetched from the forge
into the checkout's `refs/remotes/factory/<base>` and the worktree is cut there; the operator's own
branches and `origin` are not touched. The PR step measures the branch against that tracking ref. A
fetch that fails is logged and the worktree is cut from the checkout's local base, as before.

`registerRepo` with no base ref records the repo's default branch: what the forge's `HEAD` names
(`git ls-remote --symref`), else what the checkout says (`origin/HEAD`, `main`, `master`, the branch
checked out), else `main`.

All three use the registry's `url` only, and only when `resolveForgeUrl` would send a token to it
(GitHub over `https`, or a loopback host). A repo registered with no such URL is cut and its PR opened
as before, and the API logs that it pushed nothing.

**How a user reaches it.** `factory repo add <slug> --path <checkout> --url <https url>`, then
`factory run … --repo <slug>` and `factory pr <session-id>`.

**How the skill drives it.** `./pr-push.sh` starts two loopback fakes that are one forge:
`git-forge-fake.ts` serves bare repositories with the real `git http-backend`, refusing any request
without the token, and `github-fake.ts` runs with `GITHUB_FAKE_GIT_ROOT` at the same repositories, so
it refuses a PR whose head the git side does not have (`422`, as GitHub does) and records the head's
sha when it opens one. The API is started against both with a throwaway token. The repo's default
branch is `trunk`, and the forge's `trunk` moves on after the operator's checkout is cloned.

1. `factory repo add` with no `--base-ref` prints `base-ref trunk`.
2. `factory run` cuts the worktree at the forge's moved `trunk`; the checkout's own `trunk` is
   unchanged and `refs/remotes/factory/trunk` holds the forge's tip.
3. After a commit in the worktree, `factory pr` answers `opened`; the forge holds `factory/<id>` at
   the worktree's commit, the fake's PR names that head onto `trunk` with that sha, and every
   credential the forge saw was the token.
4. A second session whose `factory/<id>` someone else pushed to answers `non_fast_forward`, exits
   non-zero, asks GitHub nothing, and the forge's branch keeps their commit.
5. No line of the API log or the CLI output carries the token.

With the push removed from the step, checks 3–4 fail: `factory pr` prints `pr_error: GitHub answered
HTTP 422`, which is the bug this item fixes.

**What proves it works.** `.verify/evidence/latest/api/pr-push.json` (every check),
`pr-push-github.json` and `pr-push-git.json` (both fakes' ledgers), `pr-push-*.txt` (each CLI call's
output), `pr-push-api.log`. The cases in code: `packages/core/src/prStep.test.ts` (push, order,
token count, non-fast-forward, no URL, fetch, failed fetch, default branch) and
`packages/core/src/git.test.ts` (`remoteDefaultBranch`).

**What it cannot prove.** That GitHub accepts the push and the PR as the fakes do: the git side is
real git over smart HTTP, but no ruleset, protected branch or GitHub-specific refusal is staged. SSH
remotes are not exercised, and neither is a GitHub Enterprise host, which `resolveForgeUrl` refuses.
