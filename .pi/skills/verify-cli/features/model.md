# `factory run --model` and the deployment's `DEFAULT_MODEL`

**What it is.** The model a session runs on, chosen per task or per deployment (LOB-274).
`createSession` takes an optional `model` (`provider/modelId`, one of `getServerInfo.models`),
resolved against the catalog the server serves and pinned into the session's root; a model it does
not serve is `invalid_input` naming it, before any row or log exists. `DEFAULT_MODEL` changes what a
session with no model of its own and no `ROLE_MODELS` row runs, and one outside the catalog fails
the boot. The precedence is: the session's model > its column role's row > `DEFAULT_MODEL` > the
backend's own.

**How a user reaches it.** `factory run "<task>" --model anthropic/claude-haiku-4-5` prints
`session ses_…` and then `model anthropic/claude-haiku-4-5`, the server's answer for what the session
is pinned to (every `factory run` prints the `model` line). `--model` naming a model the server does
not serve prints `error: invalid_input: model <key> is not one this process serves` and exits 1.

**How the skill drives it.** `./model.sh` owns its API (`MODEL_PORT`, default `:9370`), booted
`MODEL_BACKEND=faux`, `DEFAULT_MODEL=faux/faux-cheap` and `ROLE_MODELS=specifier=faux/faux-spec`,
which publishes both ids with no key. In tmux it runs `factory run` with no `--model`, with
`--model faux/faux-spec`, and with `--model faux/faux-unserved`; then it boots a second API
(`MODEL_BAD_PORT`, default `:9371`) with `DEFAULT_MODEL=anthropic/claude-haiku-4-5` under faux.
`./drive.sh` checks the `model faux/faux-1` line on its own run too (up.sh sets no `DEFAULT_MODEL`).

**What proves it.** The `model` line is the summary's `model`, which the server reads from the
owner's pinned root, not the flag echoed back. Beside it, each session's `usage.models` — the models
its requests went to, folded from its own `pi.usage` — is read over the RPC with `curl`, so the run
itself is the oracle: `faux/faux-cheap` for the default run, `faux/faux-spec` for the picked one. The
refused run prints no session id; the refused boot exits non-zero, its log names
`InvalidDefaultModel` and the model, and it never logs `Listening on`.

**What it does not prove.** A real Anthropic model: the drive is offline. That a created root is
pinned to `anthropic/claude-haiku-4-5` from the real catalog is proven in
`packages/harness/src/roles.test.ts` ("a session's own model", read from `root.agent`) and
`packages/core/src/SessionService.test.ts` ("pins the model a create names", read from the log's
`pi.agent`); the precedence for a card run with both a role row and an explicit model in the same
file ("runs a card run named onto a model on it…"); the boot refusal per backend in
`apps/api/src/boot.test.ts`. `factory board start` has no `--model` yet.
