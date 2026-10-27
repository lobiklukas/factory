# The PR step over RPC (LOB-213)

**What it is.** `SessionRpc.openPullRequest` — `{sessionId, title}` → the PR step's
answer (`{number, url, outcome: "opened" | "already-open"}`, or the `over-cap` / `no-change` outcomes
that open nothing) — and its handler in `apps/api/src/Rpc/Session.ts`, which hands
`SessionService.openPullRequest` the forge client and the credential provider the process wired
(`CredentialProviderLive` and `FetchHttpClient`, in `apps/api/src/index.ts`). Before it, the step had
no caller outside tests and in-process scripts: a client asking for it answered
`Unknown request tag`, and `sessions.pr_url` was written only by seeds.

The branches are not the client's: the server publishes the session's own branch (`factory/<id>`,
or the one it was created on) onto the base it was cut from, and a raw payload's `head` or `base`
is dropped by the decode. Both are checked with `isSafeBranchName` before they reach git, and the
step's `git diff --numstat` passes `--end-of-options`, so no client string is read as a git option.

The failures cross the wire typed: `SessionError` (no such session, a session bound to no repo),
`PrError` (the forge refused or failed) and `CredentialError` (no token for the repo). The schemas
live in `@repo/domain/PullRequest`, and `@repo/core` re-exports them, so the step and its clients
decode one set of classes.

**How a user reaches it.** Through any RPC client — the CLI and the dashboard build the same one.
`factory pr <session-id>` (LOB-86) is the CLI's caller, proven in a terminal by
`.pi/skills/verify-board/drive.sh`'s build phase; no dashboard button calls it yet. This drive is a
client of its own.

**How the skill drives it.** `./pr-rpc.sh` starts its own loopback GitHub fake (`./github-fake.ts`,
ledger on disk) and its own API with `GITHUB_API_URL` pointing at it and a `GITHUB_TOKEN` the fake
never reads, then runs `pr-rpc.ts`, which speaks NDJSON RPC to that API:

1. A session bound to a fresh slug; `openPullRequest` answers `outcome: "opened"` with the fake's
   page link (`https://github.com/<repo>/pull/<n>`).
2. `getSession` and `listSessions` read the same link back — written by the RPC caller.
3. The same call again answers the same PR tagged `already-open`.
4. A session bound to no repo is refused as `SessionError{invalid_input}`; an unknown id as
   `SessionError{not_found}`.
5. The shell reads the ledger: one `POST` for the two calls, one PR for the repo, no other request,
   and the `POST` published `factory/<session-id>` onto `main` — branches the client never named.

**What proves it works.** `.verify/evidence/lob-213/api/`: `pr-rpc.json` (both answers and the
refusals as the client decoded them), `pr-rpc-ledger.json` (`requests: 1`, `pulls: 1`),
`pr-rpc-process.json`, `pr-rpc-api.log`.

**Non-vacuity.** With the `openPullRequest` handler deleted from `apps/api/src/Rpc/Session.ts`, the
drive's first call fails (`entry.handler is not a function`) and the ledger checks read `posts=0`:
the script exits non-zero (`.verify/evidence/lob-213/mutation-no-handler/`). The gate's own
regression is `apps/api/src/Rpc/Session.test.ts`, which serves the app's `SessionRpcLive` through
`HttpRouter.toWebHandler` with an in-memory forge and fails the same way without the handler; it
also covers `PrError` and `CredentialError` on the wire, which this drive's fake cannot produce.

**What it does not prove.** That GitHub accepts the request as the fake does (`pr.test.ts` asserts
the shape), the cap and the empty-branch outcomes over the wire (this drive's session has no checkout
of its own, so there is nothing to measure — see [pr-once.md](pr-once.md) for where they are
covered), or a kill inside the call (that is `./pr-once.sh`).
