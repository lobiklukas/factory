# The model backend and each session's model

**Status: passing.** An operator can tell from the screen whether a transcript came from a real model
(LOB-272). Under the faux backend a scripted answer (`faux-ok (re: …)`) reads exactly like a real one,
and the only other signal was a boot line inside turbo's TUI. It builds on `getServerInfo` and the
session's `model` (LOB-269, [verify-api's server-info.md](../../verify-api/features/server-info.md)).

## What is shown

- **The banner** (`[data-backend-banner]`, `role="alert"`) spans the top of the frame, above the rail,
  so it is on **every route** and a pane's own scroll cannot move it. It says "Scripted model (faux):
  sessions do not reach a real model. Set ANTHROPIC_API_KEY in the repo-root .env and restart." followed
  by the server's own `reason` line (`model backend: faux (selected by MODEL_BACKEND)`). It is shown
  exactly when `getServerInfo.backend` is `faux`: never under anthropic, and never before the first
  answer has landed (a banner that flashed on every load would teach people to ignore it). The rule is
  `apps/web/src/lib/server-info-view.ts#backendBanner`; the markup is `components/backend-banner.tsx`.
  It is not dismissible, on purpose.
- **It follows a restart.** `serverInfoAtom` re-reads `getServerInfo` every 10 s (`SERVER_INFO_POLL`),
  so after the operator sets a key and restarts the API the banner goes without a reload. The call reads
  no database.
- **The pane header** shows the session's `provider/model` (`header [data-session-model]`), beside its
  id and PR link: `faux/faux-1` under faux, `anthropic/claude-sonnet-5-5` under anthropic.
- **Each list row** shows the same (`aside a[href='/sessions/<id>'] [data-session-model]`), read from the
  `listSessions` row's `model`, so a scripted session is recognizable without opening it.
- A session whose row names **no model** (older than the column and not yet refolded) shows no model
  line. The dashboard never falls back to the deployment's default: a replay pinned to another model
  would be shown the wrong one, which is worse than none.

## How a user reaches it

Open any route. The model is on a session's pane (`/sessions/<id>`) and its row in the sidebar.

## How the skill drives it

Two halves, because the two backends need two deployments:

- **Faux**, in `drive.mjs` (the instance `./up.sh` starts, `MODEL_BACKEND=faux`): `getServerInfo` says
  faux; `/sessions`, a board (`/boards/<id>`) and `/spend` each carry the banner as an alert in the
  issue's words; the session the PR block opened shows `faux/faux-1` in its pane header and its list
  row, equal to what `getSession` records. Evidence `backend-banner.png`, `session-model.png`.
- **Anthropic**, in `./backend.sh` (its own API under a _dummy_ `ANTHROPIC_API_KEY` and no
  `MODEL_BACKEND`, so the backend is inferred from the credential, and its own dashboard; ports
  `BACKEND_API_PORT` / `BACKEND_WEB_PORT`): `getServerInfo` says anthropic, chosen by a credential, with
  no warning; the page's **own** `getServerInfo` response is awaited before "no banner" is asserted on
  `/sessions`, a board and `/spend` (so it is not "not loaded yet"); a session created over the RPC
  opens with `anthropic/claude-sonnet-5-5` in its pane header and its row; and `factory status` /
  `factory ls` against it name the backend and carry the model. No message is ever sent to the session,
  so no model request leaves the machine. Evidence `.verify/evidence/latest/backend/`.

**What proves it.** The banner's presence is read from the DOM after the page's own read of the
server; its absence only after that read has been seen to succeed. The model is compared with the
server's `getSession`, not with a constant, in the faux half.

**What it does not prove.** That a real model answers (see
[model-backend.md](../../verify-api/features/model-backend.md)); the banner's look below `md` (it wraps
as text and is not driven at 390 px); the unit-tested empty cases (a row with no model, an unread answer)
which `server-info-view.test.ts` covers.
