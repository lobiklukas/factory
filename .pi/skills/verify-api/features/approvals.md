# Approvals: request, pending list, decide — and the gate that asks

**Status: passing.** A gated action asks a person first. The request is recorded in the session's
log and listed as pending until a decision settles it, and the pending list still answers after the
session's owner is released (LOB-50, the contract and service; LOB-147, the fold). The agent's own
gated tool calls ask through the same service, and an ask survives the process that made it
without being asked again (LOB-52, `./approval-restart.sh`).

## What it is

- `requestApproval` records an approval request (`action`, `detail`) against a session. A request is
  identified by its `requestId`, so a retried identical request is the same request.
- `listApprovals` returns the requests still waiting for a decision, oldest first. It reads the
  session's approval index and does not open an owner, so it answers for a released session too.
- `decideApproval` settles one request with `approved` or `denied`, naming the `actor` that decided.

## The gate (LOB-52)

- A deployment names the commands that need a person with `APPROVAL_REQUIRED`, a comma-separated
  list of command prefixes (`npm publish,terraform apply`). Empty by default. Each simple command a
  `bash` call runs is compared, with assignments, wrappers (`sudo`, `env`, `timeout`, `xargs`) and
  compound keywords (`if … then`, `{ …; }`) dropped and `sh -c '…'` read into, so
  `cd pkg && npm publish` is the `npm publish` it runs. A gate's first word is a command name
  (`/usr/bin/npm publish` gates `npm publish`), and flags may sit between its words
  (`npm --registry x publish`, `terraform -chdir=infra apply`). A call D11 refuses is refused, never
  asked about.
- **What a gate does not see.** It reads the command's text, so it is a prompt that stops the
  accident, not a boundary (D15): a command spelled through a variable (`$NPM publish`), an alias or
  shell function, `eval`, a script or Makefile that runs it, another interpreter (`node -e`,
  `python -c`), or a wrapper's value-taking flag it does not know (`nice -n 10 npm publish`) runs
  unasked. A deployment that needs the boundary puts it outside the agent.
- On a gated call the policy hook (`hook(ToolTask, { beforeTool })`, `packages/harness/src/policy.ts`)
  asks through `requestApproval` with a request id derived from the call (`ask-bash-<sha256>`), so
  the same call is the same request on every attempt. It memoizes the answer with Pi Durable's
  `api.memo`, then blocks the call with a sentence the model reads. The tool never runs and the hook
  does not wait: the turn ends, and the session parks idle with the approval pending.
- **A retry asks nothing new.** A later turn that retries a call still waiting is a new task; the
  recorder answers it from the request it already holds (the row is keyed by the request id), so the
  log still holds one request, and the model is told the call is still waiting and was not asked for
  again. The check and the record hold the approvals service's write permit, so a decision cannot
  land between them.
- **An approval covers one run.** When a person approves, the next attempt at the same call runs,
  and the answer that let it run spends the approval: a `factory.approval.used` entry in the log and
  `used_at` on the row (`rebuildIndexes` refolds it). The same call after that is a new run and asks
  a person again, under `ask-bash-<sha256>-2` (then `-3`, …), because the agent may have changed
  what the command acts on since the first yes.
- **A denial stands.** Once a person denies a call it is refused, naming who denied it, every time
  the agent tries that exact call again in the session — it is not re-asked, so a denied agent cannot
  wear a person down by retrying. Re-deciding a denial, and a standing grant across runs, are choices
  for the consumers (LOB-53), not part of this contract.
- **The memo.** The settled answer (`approved` or `denied`) is memoized in the tool task's own
  `api.memo`. A recovery that reruns the task's call phase — the process died after the approval was
  spent and before the call's intent to run landed — reads it back and runs the call without asking
  again, so one yes is not spent twice. A `pending` answer is not memoized: a rerun asks again, and
  the recorder answers from its row, which is also how an approval given while the process was down
  takes effect. `policy.approval.test.ts` proves this in a real harness by losing that commit and
  reopening the log; removing the memo read makes it fail.

## How a user reaches it

The approvals RPC group (`ApprovalsRpc`) on the same `/rpc` endpoint as the session group. Its
consumers (LOB-53) are `factory approvals` / `approve` / `deny` (`.pi/skills/verify-cli/approve.sh`)
and the dashboard's `/approvals` pane, session pane and card Approvals tab (`verify-web`).

Two additions came with them, both additive on the contract:

- `listPendingApprovals({ limit? })` — every session's pending requests, oldest first, one page
  (clamped to 1…100, default 100), from the same `session_approvals` index without the session
  filter. The operator's inbox.
- `decideApproval({ …, resume: true })` — after the decision is committed, the session is handed a
  follow-up naming it (``Approved: `<action>` (request <id>) was approved by <actor>. Run it now…`` /
  `Denied: … Do not run it again…`), sent under `approval-resume:<request id>` so a repeated decision
  resumes once; the answer carries `resumedWith`, the follow-up's submission id. Without `resume`
  nothing but the decision happens, which is what `approval-restart.sh` and `drive.ts` rely on.

## What proves it

`drive.ts`, over the real Effect RPC client (`RpcClient.make(ApprovalsRpc)`):

- `requestApproval` is listed as pending, with the request's id and action.
- A second identical request leaves one pending row.
- After the owner is released (the idle sweep), the session reads `historical` and the pending
  request is still listed.
- `decideApproval` returns `approved` with the actor the caller named, and the pending list empties.

The decision's actor (`verify-api operator`) is in `observed.json` under `approvals.decision`.

`./approval-restart.sh` (LOB-52) owns its own API on `:9416` (`APPROVAL_PORT` overrides it) with
`MODEL_BACKEND=faux`, `APPROVAL_REQUIRED=sleep`, `FAUX_COMMAND="sleep 12 && echo gated-ran"` and
`FAUX_EVERY_TURN=true` (the faux agent retries the call on every turn):

- **Arm.** One message; the run parks on one pending approval for the gated command, in the pending
  list and the snapshot. It is idle a few hundred milliseconds after the send, so the 12-second
  command did not run — a gate that failed open would hold the run busy for the whole sleep. The
  tool result is the blocked sentence, without `gated-ran`. The log (`commits`) holds the request
  entry once and the memo write once.
- **Kill.** `SIGKILL` (`KILL_SIGNAL=TERM` for the graceful path) — the process that asked is gone.
- **Verify, from a fresh process.** The session folds `historical`/`idle` with the same approval
  pending, and the log still holds one request. A new turn retries the same call: blocked with "not
  asked for again", and still one request in the log and one row pending. Then `decideApproval`
  approves it and the next turn runs it: busy for the sleep, then `gated-ran`, with the pending list
  empty, the request still asked for once, and the approval spent (one `factory.approval.used`). One
  more turn runs the same call again: blocked, asked for afresh under `<request id>-2`.

The request count is read from the log itself because the fold and the index both key a request by
its id: a duplicate request entry would be invisible to them.

What the script proves is the recorder's half — the request id is the call's identity across a
killed process, and an approval covers one run. It does not prove the memo: the kill lands after the
tool task settled, so nothing reruns a task mid-ask. The memo's property is proven by
`policy.approval.test.ts` alone.

Last run: 2026-10-27, from the `agent/LOB-52` worktree (`APPROVAL_PORT=9501`, faux, the worktree's
own database on 5442): **22/22**, evidence `.verify/evidence/lob-52/api/approval-restart-*`.
