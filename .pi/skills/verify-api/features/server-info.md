# What the server runs, and each session's model

**What it is.** `getServerInfo` (LOB-269, `ServerRpc` in `packages/domain/src/Rpc.ts`) answers what
the control plane is running: the model backend and what chose it (`selectedBy`: `MODEL_BACKEND`,
`credential` or `no_credential`, with the boot's own line as `reason` and its faux warnings), the
default model, the `ROLE_MODELS` rows as the boot resolved them, every model the catalog serves,
the approval gate, the default budget, the credential mode of the model backend, the forge and the
reviewer, every webhook route and whether it is armed, whether the Linear write-back is on, and the
sandbox runtime. A credential is reported as the _mode_ that authenticated (`ANTHROPIC_API_KEY`,
`static-token`), never its value, and as absent when nothing authenticates (`model: null` under
faux, `forge: "none"` with neither `GITHUB_TOKEN` nor a GitHub App, `reviewer: "none"`); a webhook route as armed or not, naming its variable. The answer
is computed once from the facts the boot resolved (`apps/api/src/ServerInfo.ts`), touches no
database, and so answers while Postgres is down.

Every session also names the model its root conversation is pinned to: `model` (`provider/modelId`)
on the summary `createSession`, `getSession` and every mutation answer, and on each `listSessions`
row. It is read from the log's `pi.agent`, so a replay names the model it was replayed onto and a
run in a column whose role has a `ROLE_MODELS` row names that row's model. The list reads the
`sessions.model` column (migration 0027), which the owner's open writes and `rebuildIndexes`
refolds; a fold falls back to the log when the column is blank. Rows older than the column are
filled once the API has applied its migrations (`backfillSessionModels`, from each log's
`pi.agent`), so an existing deployment's list names every session's model without a rebuild.

**How a user reaches it.** Any RPC client: `client.getServerInfo({})`. The dashboard and the CLI
surfaces are LOB-272.

**How the skill drives it.** `DATABASE_URL=… API_PORT=… ./server-info.sh` boots this skill's API
through `./up.sh` with `MODEL_BACKEND=faux`, `ROLE_MODELS=specifier=faux/faux-spec` (up.sh adds its
`replay-target=faux/faux-2` row), `APPROVAL_REQUIRED="npm publish"`, `SESSION_BUDGET=3`, a dummy
`ANTHROPIC_API_KEY` and dummy GitHub and Linear webhook secrets. `server-info.ts` then asks
`getServerInfo` with the real RPC client and checks backend, selection, default model, role rows,
catalog, gate, budget, the absent model credential mode, the two armed routes and the faux warning;
creates a session and checks `faux/faux-1` on `createSession`, `getSession` and its `listSessions`
row; creates one with `model: faux/faux-spec` and checks it names that (LOB-274), and one with
`model: faux/faux-unserved` and a fresh request id, which must be `SessionError` `invalid_input`
naming it, with no listed session carrying its title and a later create under the same request id
answered with that create's own title rather than by a row the refusal left behind; and sends the same request as raw NDJSON, checking that no dummy's value is in the
body. The shell checks the API's log for the same dummies.

`defaultModel` is `DEFAULT_MODEL` when the deployment sets it (LOB-274), resolved against the catalog
at boot; one outside it fails the boot. `apps/api/src/boot.test.ts` boots both backends with a valid
one and three invalid ones, and `.pi/skills/verify-cli/model.sh` drives it through `factory run`.

The gate runs the rest: `apps/api/src/boot.test.ts` boots the real `index.ts` under
`MODEL_BACKEND=faux` with a role table, with no forge credential (`forge: "none"`), and under an
inferred anthropic with a dummy key, and asks
over `/rpc`; `apps/api/src/Rpc/Server.test.ts` covers the three backend choices and the secret
check through the RPC client; `packages/core/src/SessionService.test.ts` ("the model a session runs
on", and the role-model block) covers faux, a replay, a role row, a blanked column, a rebuild and
the boot's backfill.

**What it does not prove.** That the credential the answer names is valid (see
[model-backend.md](model-backend.md)). The anthropic catalog in `models` is pi-ai's published list,
not what the account can use.
