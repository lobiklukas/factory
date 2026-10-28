# New session

**Status: passing.** The sidebar's **New session** opens a form for the operator's own task (E6): a
required prompt, a repository picked from `listRepos` (or none), an optional base ref, the model
(LOB-274), and an optional budget or the cap at the predicted high (LOB-38). Nothing is created until
the form is submitted; the submit sends `createSession` with exactly those fields, then the prompt as
the first message, and opens the session.

It replaced a button that always sent one fixed sample prompt on no repo: every press made the same
scratch session, which could never cut a worktree or produce a pull request, even on a real model.

## Sub-features

- **Open creates nothing.** A press opens the dialog; no `createSession` leaves the page and
  `listSessions` is unchanged until a submit.
- **The prompt is required.** An empty prompt, or one of whitespace, marks the field
  (`[data-session-problem='prompt']`, `aria-invalid`) and sends nothing. A budget that is not a
  positive amount, or a cap with no range to cap at, is refused the same way.
- **The prompt is sent verbatim.** Its lines and indentation are the session's first user entry; the
  control plane names the session from it, so no title is sent.
- **Repo and base ref.** The select is the registry's rows (a repo that cannot cut a worktree is
  labelled so, `runnability`), first "No repo (scratch session)". The base ref is sent only with a
  repo, trimmed, and left out when blank so the registry's default applies (the placeholder names it).
- **The server's refusal is inline.** A create the server refuses (a base ref the checkout lacks, a
  model it does not serve, `at_capacity`) is shown under the form in the server's words
  (`[data-session-refusal]`), and everything typed is kept.
- **A refused first message is not a refused create.** If `createSession` lands and `sendMessage` is
  refused, the session exists: the form opens it and a toast says the prompt was not sent.
- **The cost line predicts the typed prompt** on the model and repo picked, once the prompt has rested
  for 400 ms, and asks nothing while it is blank.

The rules are pure and unit-tested in `apps/web/src/lib/session-create-view.test.ts`; the page is
`apps/web/src/components/new-session.tsx`.

## How a user reaches it

`/sessions` (or any session's page): **New session** in the sidebar. **Start session** submits;
**Cancel**, Escape or the close button discards the form.

## Driving it

```sh
SESSION_NEW_API_PORT=9461 SESSION_NEW_WEB_PORT=3461 ./session-new.sh   # its own instance and checkouts; leaves nothing running
```

`session-new.mjs` registers two throwaway checkouts over the RPC (one with a `release/1.2` branch a
commit ahead of `main`; one whose default base ref `trunk` it lacks), then requires, with the page's
own `createSession` requests as the network oracle and `getSession` / `listSessions` read over the
RPC:

| Check                                                                          | Proves                                          |
| ------------------------------------------------------------------------------ | ----------------------------------------------- |
| pressing New session opens the form and creates nothing                        | no create on open                               |
| an empty prompt cannot be submitted, and no createSession request is sent      | the prompt is required (network assertion)      |
| the session's first user entry is the typed prompt verbatim                    | a multi-line, indented prompt arrives intact    |
| a session on no repo is listed with no repo                                    | the scratch default                             |
| the form predicts the typed prompt's cost on the picked repo once it rests     | equal to `predictCost` for that prompt and repo |
| the page sent createSession with exactly the form's fields                     | `{ repo, baseRef, actor }` and nothing else     |
| choosing repo R lists the session with repo R and the base ref typed           | the `listSessions` row                          |
| its snapshot workspace.path is a git worktree of R on factory/<session-id>     | the run can produce a PR                        |
| the worktree was cut from the base ref typed, not the repo's default           | the base ref reached the cut                    |
| an invalid repo shows the server's error inline, and the form keeps the prompt | the refusal, character for character            |

`drive.mjs`'s session-stream case ([session-stream.md](session-stream.md)) opens the same form and
types its own prompt; `cost.mjs`, `model.mjs`, `spend.mjs` and `auth.mjs` do too. The faux model runs
`FAUX_COMMAND` whatever the prompt says, so every drive still ends on `faux-ok (re: …)`.

Evidence: `.verify/evidence/latest/session-new/` — `session-new-open.png`, `session-new-empty.png`,
`session-new-scratch.png`, `session-new-repo.png`, `session-new-refused.png`, `observed.json` (every
`createSession` body the page sent).

Last passed **12/12** on 2026-10-28 from the `agent/E6` worktree, API `:9501` / web `:3501`.

## Gotchas

- The dialog is local state, not a URL: a reload closes it. The board's New card is `?new=card`
  because empty states will link to it (C9); nothing links to a New session form yet.
- A create the server refuses after writing the index row (the worktree cut fails inside
  `SessionService.create`) is the server's behavior: the drive records `listedDelta` beside the
  refusal rather than asserting on it.
- The RPC client posts to `<api>/rpc/` (trailing slash): match the path's prefix, not its end.
