# `factory approvals` / `factory approve` / `factory deny`

**What it is.** The operator's half of an approval at a terminal (D11, LOB-53). A gated tool call
asks once and parks its run (LOB-52); `factory approvals` lists what is waiting, and `factory approve`
/ `factory deny` decide it and **resume the session**: the decision is handed to the session as a
follow-up message (`decideApproval` with `resume: true`), so an approved call runs on the turn it
wakes and a denied one is carried on without. The command then follows the session the way
`factory run` does and prints the resumed run's answer.

**How a user reaches it.**

- `factory approvals` — every session's pending requests, newest first (one page of at most 100; a
  cut page adds `showing the newest N of M pending approvals…` on stderr), as
  `request  session  requested  action` rows (the action last, because it may contain spaces);
  `factory approvals --session ses_…` — one session's. `no approvals pending` when there are none.
- `factory approve ses_… [--id <request id>] [--actor <who>]` — prints
  `approved <request id> by <actor>`, then `resumed <session id> with submission <id>`, then the
  session's transcript and `answer: …`. Without `--id` it decides the session's only pending
  request; `factory deny` is the same with `denied`. `--actor` defaults to `cli`, a person.

**Outcomes a script branches on.** A decision exits 0. `error: not_found` and a non-zero exit for an
approval id the session never asked for, an unknown session, and a bare `approve` with nothing
pending. `error: invalid_input` for a bare `approve` with more than one pending — it names the ids to
pass as `--id` rather than guessing which question the person read. A second, different decision on
a settled request is the service's `invalid_input`; repeating the same decision is the same decision
and resumes once (the follow-up is deduplicated on `approval-resume:<request id>`). A decision that
is recorded but whose follow-up could not be sent (`resumeFailed`) prints the decision, then
`error: <code>: the decision is recorded, but <session> was not resumed (…); retry with: factory
approve <session> --id <request>` and exits non-zero — `--id`, because nothing is pending any more.

**How the skill drives it.** `./approve.sh` owns its own API (`APPROVE_PORT`, default `:9330`) with
`MODEL_BACKEND=faux`, `APPROVAL_REQUIRED=sleep`, `FAUX_COMMAND="sleep 1 && echo gated-ran"` and
`FAUX_EVERY_TURN=true` (the faux agent retries the call on every turn), because a gate is a
deployment setting and `./up.sh`'s instance must stay ungated for the plain `run` checks. `drive.sh`
runs it as its last block and fails when it does. In tmux:

1. `factory run "approve probe"` exits 0 with the gated call's blocked sentence ("one has been asked
   for") and no `gated-ran`: the run parked.
2. `factory approvals` lists the request (`ask-bash-<sha256>`, action `sleep`) under the session;
   `--session` lists the same row.
3. `factory approve <session> --id ask-bash-not-a-request` and `factory approve <unknown session>`
   print `error: not_found` and exit non-zero, and the request is still pending after them.
4. `factory approve <session>` prints the decision, the follow-up, ``[user] Approved: `sleep` …``,
   `[tool:bash] gated-ran` and `answer: gated-ran (re: Approved: …)` — the parked session resumed and
   the call ran.
5. The request is gone from `factory approvals`, `--session` says `no approvals pending`, and a
   second bare `approve` is `error: not_found`.
6. A second run parks the same way; `factory deny` prints `denied … by cli`, the resumed run's
   `[user] Denied: …` and the gate's "was denied by cli" refusal, never `gated-ran`; the request
   leaves the list.

**What proves it.** `gated-ran` appears only after `factory approve` and never after `factory deny`
or the first run, and the follow-up entry names the decision, so the resumption is the decision's
and not a message someone typed. A mutation sending `resume: false` failed three checks (the
follow-up, the run, the denied resume).

**What it does not prove.** Two pending requests in one session from the terminal (the faux agent
asks one call); `pickPending`'s refusal is covered by `apps/cli/src/commands/approve.test.ts`, and the
service's resume, its deduplication and the cross-session list by
`packages/core/src/SessionService.test.ts`.

Last run: 2026-10-27 from the `agent/LOB-53` worktree, `APPROVE_PORT=9531`, faux, the worktree's own
database on 5442 — **18/18**, and `drive.sh` (API `:9530`) **21/21** with this block as its last
check. Evidence `.verify/evidence/lob-53/cli/approve-*`.
