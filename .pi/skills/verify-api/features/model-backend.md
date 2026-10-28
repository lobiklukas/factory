# The model backend at boot

**What it is.** Which model the API's sessions talk to, decided once at boot (LOB-258).
`MODEL_BACKEND` wins when set. Unset, pi-ai's own credential resolution (`checkAuth`) decides: the
Anthropic backend when any mode pi-ai accepts resolves, the faux provider when none does. The
accepted modes, in pi-ai 1.0.3's order: `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`),
`ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, then workload identity federation
(`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE`
together). An empty or whitespace-only value is unset. `MODEL_BACKEND=anthropic` with nothing that
resolves fails the boot with `AnthropicCredentialMissing`, which lists the accepted variables.
`CLAUDE_CODE_OAUTH_TOKEN` is not read; when it is set and nothing else is, the boot says so.

**How a user reaches it.** The boot log: `model backend: anthropic (auth: ANTHROPIC_OAUTH_TOKEN)`,
`model backend: faux (selected by MODEL_BACKEND)` or `model backend: faux (no Anthropic credential
resolved)`. The line names the variable, never its value.

**How the skill drives it.** `./backend-boot.sh` boots the real API four times on one port
(`BACKEND_BOOT_PORT`, 9426 when unset), each from an empty environment (`env -i`) with
`bun --no-env-file`, so no shell variable or `.env` lends a credential: `MODEL_BACKEND=faux` (ready,
and the line says `selected by MODEL_BACKEND`); `MODEL_BACKEND=anthropic` with a whitespace-only key
(exits non-zero before it binds, with the typed error naming all six variables); a dummy
`ANTHROPIC_OAUTH_TOKEN` alone (ready on anthropic, the variable named, its value in no line); and a
dummy `ANTHROPIC_AUTH_TOKEN` through `turbo run dev --filter=@repo/api` in Strict Mode, which reaches
the API only because `apps/api/turbo.json` passes it through. The turbo boot is skipped when a
repo-root `.env` exists, because `bun run dev` loads it (the script tests for the file and never
reads it). A boot sends no model request, so a dummy credential reaches nothing.

The same cases run in the gate: `apps/api/src/boot.test.ts` boots the process per mode, and
`apps/api/src/ModelBackend.test.ts` covers the decision against an injected lookup.

**What it does not prove.** That a credential is _valid_: `checkAuth` says one is present, not that
Anthropic accepts it, so a revoked key still boots on anthropic and fails on its first request.
Federation is driven by the unit cases only (it needs an identity token file and an exchange).
