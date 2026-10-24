# Approvals: request, pending list, decide

**Status: passing.** A gated action asks a person first. The request is recorded in the session's
log and listed as pending until a decision settles it, and the pending list still answers after the
session's owner is released (LOB-50, the contract and service; LOB-147, the fold).

## What it is

- `requestApproval` records an approval request (`action`, `detail`) against a session. A request is
  identified by its `requestId`, so a retried identical request is the same request.
- `listApprovals` returns the requests still waiting for a decision, oldest first. It reads the
  session's approval index and does not open an owner, so it answers for a released session too.
- `decideApproval` settles one request with `approved` or `denied`, naming the `actor` that decided.

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
