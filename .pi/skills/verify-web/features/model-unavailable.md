# A session pinned to a model the server no longer serves

**Status: passing** (E9, an unfiled draft under LOB-246).

**What it is.** A session's model is pinned into its log when it first opens (LOB-269), and the pin
outlives the backend that chose it: a session created under faux is still `faux/faux-1` after the API
restarts on anthropic. Before E9 its next message failed inside pi-ai with an untyped
`Unknown provider: faux`. Now:

- `sendMessage` (and the deferred send a trigger uses) on a session whose pinned model this process
  does not serve is refused as `SessionError` `model_unavailable`, naming the session and the model,
  before an owner is acquired or anything is written, so no run starts;
- `getSession` and `listSessions` report `modelAvailable` (`false` for such a session, `true` for a
  served pin, absent when the session names no model);
- the pane disables the composer and Send, explains which model the session is pinned to and which
  one **Replay on `<default model>`** would run (`data-model-unavailable`, `data-replay-session`), and
  that action calls `replaySession` and navigates to the new session.

**How a user reaches it.** Open a session whose pin the server no longer serves, from the sidebar or
a card's run.

**How the skill drives it.** `./model-unavailable.sh` owns two boots of one API over one session root
and database (`MODELGONE_API_PORT`, `MODELGONE_WEB_PORT`): boot 1 with `DEFAULT_MODEL=faux/faux-cheap`
seeds a repo-bound session pinned to `faux/faux-cheap` and a control session on `faux/faux-1`; boot 2
serves `faux/faux-1` alone, so the pin is to a model nobody serves. Faux, not anthropic: a replay onto
anthropic would call api.anthropic.com. `model-unavailable.mjs` reads the oracle over RPC (`modelAvailable`,
the typed refusal, an unchanged transcript), then the pane (composer and Send disabled, the words), the
control session (composer enabled, no notice) and the Replay action (one new session, on `faux/faux-1`,
which answers, its composer enabled, the source untouched).

**What proves it.** `packages/core/src/SessionService.test.ts` (E9) is the literal case: a session
created under faux, reopened by a service built over the anthropic catalog on the same database, is
refused `model_unavailable` naming `faux/faux-1` for `send` and `sendDeferringSetup`, with its transcript
unchanged and `modelAvailable: false` on the summary and the list. `apps/web/src/lib/model-unavailable-view.test.ts`
holds the words. Evidence: `.verify/evidence/latest/model-unavailable/` (`observed.json`,
`model-unavailable-pane.png`, `model-unavailable-replayed.png`).

Last verified 2026-10-28 from `agent/C7b-E9` (API `:9582`, web `:3582`): 13/13.

**What it does not prove.** A replay onto a real anthropic model (it would call the provider); a row
with no `model` in the index (a session never opened, or older than the column) is not checked, since
its first open pins the model this process serves.
