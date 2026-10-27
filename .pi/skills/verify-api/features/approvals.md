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
  `bash` call runs is compared, with assignments and wrappers (`sudo`, `env`) dropped, so
  `cd pkg && npm publish` is the `npm publish` it runs. A call D11 refuses is refused, never asked
  about.
- On a gated call the policy hook (`hook(ToolTask, { beforeTool })`, `packages/harness/src/policy.ts`)
  asks through `requestApproval` with a request id derived from the call (`ask-bash-<sha256>`), so
  the same call is the same request on every attempt. It memoizes the answer with Pi Durable's
  `api.memo`, then blocks the call with a sentence the model reads. The tool never runs and the hook
  does not wait: the turn ends, and the session parks idle with the approval pending.
- The memo is the tool task's own. A recovery that reruns the task — the process died after the ask
  and before the blocked result landed — reads it back and does not ask again
  (`policy.approval.test.ts`, which loses that commit in a real harness and reopens the log). A later
  turn that retries the same call is a new task; the recorder answers it from the request it already
  holds, so the log still holds one request.
- Once a person approves, the same call runs; once they deny it, it is refused naming who denied it.

## How a user reaches it

The approvals RPC group (`ApprovalsRpc`) on the same `/rpc` endpoint as the session group. The CLI
decide command and the dashboard approvals pane are LOB-53; this feature is the contract they call.

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
  pending, and the log still holds one request. A new turn retries the same call: blocked, and still
  one request in the log and one row pending. Then `decideApproval` approves it and the next turn
  runs it: busy for the sleep, then `gated-ran`, with the pending list empty and the request still
  asked for once.

The request count is read from the log itself because the fold and the index both key a request by
its id: a duplicate request entry would be invisible to them.

Last run: 2026-10-27, from the `agent/LOB-52` worktree (`APPROVAL_PORT=9501`, faux, the worktree's
own database on 5442): **20/20**, evidence `.verify/evidence/lob-52/api/approval-restart-*`.
