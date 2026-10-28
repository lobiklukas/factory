# `factory discard`

**What it is.** An operator's terminal event for a session (LOB-268). A session's worktree and its
branch `factory/<id>` outlive its owner — the idle sweep and an API restart keep them for the next
run — so they are removed only when the work is finished: the card reaches `done` or `canceled`, the
PR merges, or an operator discards the session. `factory discard <session-id>` is that last one. A
run still going is interrupted first, the worktree and branch are removed, and the session takes no
new run afterwards. Its transcript stays readable.

**How a user reaches it.** `factory discard ses_…` prints
`discarded ses_…: its worktree and branch are removed`. A repeat exits 0 and prints
`ses_… was already released (<reason> at <time>)`, naming the first release, whichever terminal
event it was. `factory send` to a discarded session is `error: invalid_input`, and an unknown id is
`error: not_found`, both non-zero.

**How the skill drives it.** `./discard.sh` owns its own API (`DISCARD_PORT`, default `:9340`),
because the session needs a linked worktree to remove: it creates a repository under
`.verify/run/cli-discard/checkout`, registers it with its checkout over the `registerRepo` RPC, and
runs `factory run --repo` on it in a tmux window. Then it runs `factory discard` twice, `factory send`
once, and `factory discard` on an unknown id, reading the checkout with `git` between each.

**What proves it.** That the run's worktree directory and its branch existed in the checkout before
the discard, and that afterwards the directory is gone, `git rev-parse` no longer resolves the branch,
and `git worktree list` no longer names the session. The refused `send` leaves both gone, so a
refusal cuts nothing back. Evidence: `.verify/evidence/latest/cli/discard-*.txt` and `discard.json`.

**What it does not prove.** The other terminal events. The card's `done`/`canceled` and the PR's
merge are `packages/core`'s claims (`SessionService.test.ts`, "a session's workspace outlives its
owner"), and the merge's route wiring is `apps/api/src/Api/GitHubWebhook.test.ts`'s. That the work
survives the idle sweep and a restart is verify-api's `./sigterm.sh` and the same core cases.
