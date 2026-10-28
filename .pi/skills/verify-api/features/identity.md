# Control-plane identity

**What it is.** Every RPC — every group, the `watchSession` stream included — passes one middleware,
`ControlPlaneAuth` (LOB-20, `packages/domain/src/Auth.ts`, served by `apps/api/src/Rpc/Auth.ts`). With
a token configured, a call needs `Authorization: Bearer <token>`; without one, or with one the table
does not hold, it fails with the typed `Unauthenticated` (`reason: "missing" | "invalid"`) before its
handler runs. The table is `FACTORY_API_TOKEN` (one shared token, authenticating as
`FACTORY_API_ACTOR`, `operator` unless named) plus `FACTORY_API_TOKENS` (`actor=token,…`). A token
shorter than 16 characters, a token claimed by two actors, or an actor that is a session id (a run's)
or `trigger:<source>` (a signed delivery's) fails the boot.

Every write that records an actor records the credential's: `createSession` (and so `board start`),
`forkSession` and `replaySession` (the caller's actor now, not the source's), `decideApproval`, and the
board's `createTask` / `moveTask` / `blockTask` / `unblockTask` / `updateTask` / `commentTask`. A body `actor` is
ignored, so no client can write as someone else or as a run. `sessions.actor`, `factory.actor` and
`listSpend` are unchanged; they just hold the authenticated name. The webhook routes are not behind
the middleware: a delivery is authenticated by its route's signature, and its session's actor is the
`trigger:<source>` the trigger seam mints after that check.

With no token configured the control plane runs with auth off: every call is served and a declared
actor is recorded, as before LOB-20. The boot logs a warning naming the variables.

**How a user reaches it.** Export `FACTORY_API_TOKEN` for the API and the CLI (the CLI sends it on
every call from `apps/cli/src/rpc.ts`); set `VITE_FACTORY_API_TOKEN` for the dashboard
(`apps/web/src/lib/rpc-client.ts`). A CLI call without the token against an API that requires one
prints `error: unauthenticated: … (the CLI reads FACTORY_API_TOKEN)`. The CLI's `--actor` flags
remain, and an API that authenticates ignores them.

**How the skill drives it.** `DATABASE_URL=… API_PORT=… ./identity.sh` boots this skill's API
through `./up.sh` with a per-run shared token (`verify-operator`), a per-run token for `amy`, a
generic trigger rule and its signing secret. `identity.ts` then:

- calls `listSessions` and `watchSession` with no credential and with a wrong one: four
  `Unauthenticated` refusals with the right reason, and the same stream served to a credential;
- as amy, sends `createSession`, `requestApproval` + `decideApproval`, `createBoard` + `createTask` +
  `moveTask` each with `actor: "mallory"`, and moves the card again through the real CLI
  (`factory board move --actor mallory`, `FACTORY_API_TOKEN` = amy's), then reads `sessions.actor`,
  `session_approvals.actor` and `task_events.actor` from Postgres: all `amy`;
- runs `factory ls` with the variable empty: refused, naming `FACTORY_API_TOKEN`;
- (F7) calls `defineBoard` as amy with a body actor `mallory`: the version's `author` is `amy`, read
  back through `getDefinition`, `board definitions` and `board_definitions.author`; an unchanged answer
  and a dry run write no row; the operator's token authors its own version;
- creates a session with the shared token (`verify-operator`), and checks `listSpend` for the repo
  holds exactly `amy:1` and `verify-operator:1`;
- posts a signed generic delivery with no credential: `200`, a session attributed
  `trigger:generic`; the same body unsigned: `401`.

The shell checks the boot line names the bearer-token mode and that neither token's value is in the
API log or the evidence. Evidence: `.verify/evidence/latest/api/identity.json` and `identity-api.log`.

The gate runs the rest: `apps/api/src/Rpc/Auth.test.ts` serves the app's own `SessionRpcLive` with a
two-person table and proves each write path (create, fork, replay — with `factory.actor` refolded by
`rebuildIndexes` — the approval decision, and create / move / block / unblock / comment / start on a
card, including a body naming a run crossing the plan-approval gate as amy), the refusals (unary,
stream, a malformed header), the token-table refusals, auth off keeping a declared actor, and a signed
webhook beside a refusing `/rpc`. `apps/cli/src/rpc.test.ts` proves both CLI clients send the token,
and send nothing when it is unset.

The dashboard half is verify-web's `auth.sh`: a dashboard built with `VITE_FACTORY_API_TOKEN` lists
sessions, sends the bearer on every RPC, and its **New session** is recorded as the token's actor; one
built without it is answered `Unauthenticated` and shows nothing.

**What it does not prove.** The other verify-web drives and verify-board's run-actor gate check run
against an API with auth off, because they declare actors (`dashboard`, a run's session id) that only
an open control plane keeps: each of their scripts unsets `FACTORY_API_TOKEN`, `FACTORY_API_TOKENS`,
`VITE_FACTORY_API_TOKEN` and `FACTORY_API_AUTH` first, so a token exported for everything else does not
turn auth on under them. An open control plane binds loopback (`HOST` defaults to `127.0.0.1`); one
with no token on a `HOST` beyond loopback refuses the boot (`ApiAuthRequired`) unless
`FACTORY_API_AUTH=off` says so, which `apps/api/src/boot.test.ts` proves on the real boot. Per-column move permissions and audit views
(docs/board.md wave-2 item 7) are not built.
