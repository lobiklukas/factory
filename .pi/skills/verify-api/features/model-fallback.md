# A second model provider, and a role's fallback onto it

**What it is.** Two settings beside the model backend (S-model-provider-breadth). An
OpenAI-compatible endpoint — vLLM, Ollama, LiteLLM, OpenRouter, a gateway, OpenAI itself — is
registered as a second provider in the same pi-ai registry, under either backend:
`OPENAI_COMPATIBLE_BASE_URL` (the API's base, before `/chat/completions`) and
`OPENAI_COMPATIBLE_MODELS` (a list of ids, or a JSON array of `{id, contextWindow?, maxTokens?,
cost?: {input, output, cacheRead?, cacheWrite?}}`, US dollars per million tokens). Its models are
`openai-compatible/<id>`, which `ROLE_MODELS`, `DEFAULT_MODEL` and `ROLE_FALLBACKS` may name. Its key,
when it has one, is `OPENAI_COMPATIBLE_API_KEY`, read by pi-ai at request time and never by the
factory; with none set the endpoint is treated as keyless. Half a configuration, a URL that is not
http(s), a repeated id or a negative price fails the boot.

`ROLE_FALLBACKS` is comma-separated `role=provider/modelId|provider/modelId`: the models a role's runs
move onto, in order, when the model they are on answers overloaded or unavailable (a `529`, a `503`,
"overloaded", "service unavailable", "model is at capacity") and pi-ai calls it retryable. Nothing
else moves a run: a refusal, a quota, a rate limit or a bad request is retried (or failed) on its own
model. The move rides Pi Durable's own retry: before Pi Durable classifies the failed answer, a hook
commits — in one commit — the conversation's agent moved onto the next model and a
`factory.model.switched` entry, so the retry goes to the fallback. Each answer is charged to the model
that gave it (Pi Durable keys usage by the answering model). A session's pinned model changes only
this way: the pin is the switch's, a reopened session stays on the fallback, and a run never moves
back up its chain. A chain that names a model the process cannot serve, or the role's own model,
fails the boot. A session created on a model of its own (`createSession`'s `model`) is outside its
role's chain and never falls back.

**How a user reaches it.** The boot log names both:
`second provider: openai-compatible at http://127.0.0.1:8000/v1 serving compat-1 (OPENAI_COMPATIBLE_BASE_URL; auth: OPENAI_COMPATIBLE_API_KEY)`
(the URL without any `user:password@` or query string) and `role fallbacks: builder → … | … (ROLE_FALLBACKS; …)`.
`getServerInfo` lists the endpoint's models in `models` and the chains in `roleFallbacks`. A switch is
a `modelSwitch` line in the transcript (a status marker in the dashboard, `[modelSwitch] …` in the
CLI) naming both models and the provider's error, a warning in the API's log, and the session's
`model` on its summary, snapshot and list row.

**How the skill drives it.** `DATABASE_URL=… ./model-fallback.sh` mints a scratch database, starts
the loopback fake (`openai-compatible-fake.ts`, `@repo/harness/openaiCompatibleFake`: a `bash` call,
then an answer that says what it printed; `GET /__ledger` lists what it was asked), and boots the
API twice on `FALLBACK_PORT` (9448) under `MODEL_BACKEND=faux` with the endpoint priced at $3/$15:

1. `ROLE_MODELS=specifier=openai-compatible/compat-1`: a card's run in `specifying` runs end to end
   on the endpoint — two requests under `compat-1`, each carrying the drive's dummy key — and its spend
   is that model's, at the configured price.
2. `ROLE_MODELS=specifier=faux/primary`, `FAUX_MODEL_SCRIPTS={"primary":{"fail":"overloaded:1"}}`
   (`FAUX_FAIL`'s new `overloaded` kind) and `ROLE_FALLBACKS=specifier=openai-compatible/compat-1`:
   the primary runs the `bash` call and then answers 529; the transcript reads user, assistant, tool
   result, `modelSwitch`, the 529, the fallback's answer; the endpoint is asked once; `faux/primary` is
   charged its `FAUX_COST` and `compat-1` its price; the session's model is the fallback; a second
   message stays there and nothing switches again; `getServerInfo` names the chain.

It also checks the dummy key is in no line the API logged. The gate covers the same ground:
`packages/harness/src/fallback.test.ts` (both directions, including the endpoint's own HTTP 529, a
chain of two, a refusal that does not switch, a session outside its chain), and
`packages/core/src/SessionService.fallback.test.ts` (the session's model and list row follow the
switch, and a switched run is no failed run), `apps/api/src/boot.test.ts` (the boot lines, the
refusals, `getServerInfo`).

**What it does not prove.** That a given vendor's server streams exactly as the fake does, or that a
real provider's outage is worded the way pi-ai's retry pattern expects: Anthropic's `529
overloaded_error` and an HTTP 503 are, by pi-ai's own classification. The fallback waits Pi Durable's
first retry delay (2 s) before the fallback's request. A switched session keeps the compaction
thresholds of the model it opened on until it is reopened.
