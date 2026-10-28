# The New session model picker

**What it is.** The **Model** select in the **New session** form (LOB-274, folded into the form by
E6, [session-new.md](session-new.md)): which model the session runs on. Its options are the server's default, then exactly what `getServerInfo.models`
answers — the catalog `createSession` resolves a model against — so it never offers a model the
server would refuse. The first option reads `Server default (<defaultModel>)` and sends no `model`
at all, so the server decides (the column role's model, else `DEFAULT_MODEL`, else the backend's
own); a model a `ROLE_MODELS` row runs names its role, and the deployment's default says `default`.
Before `getServerInfo` answers, or if it fails, only the server's default is offered and a session
still starts.

**How a user reaches it.** `/sessions` (or any session's page): press **New session**, type the
prompt, pick a model, press **Start session**.

**How the skill drives it.** `./model.sh` starts its own API (`MODEL_API_PORT`, default `:9451`) with
`MODEL_BACKEND=faux`, `DEFAULT_MODEL=faux/faux-cheap` and `ROLE_MODELS=specifier=faux/faux-spec`, and
its own dashboard (`MODEL_WEB_PORT`, default `:3451`). `model.mjs` opens the form, reads the picker's
options, picks `faux/faux-spec` and starts a session on its own prompt, then starts another on the
server's default.

**What proves it.** The options equal `["", ...getServerInfo.models]` read over the RPC from the
drive's own process. Each session is judged by the server, not the page: its summary's `model`, and
its `usage.models` — the models its requests went to, folded from its own `pi.usage` — are
`faux/faux-spec` for the picked session and `faux/faux-cheap` (the `DEFAULT_MODEL`, not the backend's
`faux/faux-1`) for the default one, whose payload carried no `model`. Evidence:
`model-picker.png`, `model-picked-session.png`, `observed.json`.

**What it does not prove.** A refused model: the picker cannot offer an unserved one, and the
refusal is the server's (`verify-cli/model.sh`, `verify-api/server-info.sh`).
The rules for labels and the payload are unit cases in `apps/web/src/lib/model-picker-view.test.ts`.
A card run started from the card pane uses the server's choice; it has no picker yet.
