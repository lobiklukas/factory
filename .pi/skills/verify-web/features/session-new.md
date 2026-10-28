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
  (`[data-session-refusal]`), and everything typed is kept. A refused worktree cut leaves no session
  behind: `SessionService.create` removes the index row (and a card's run row) it wrote before the
  cut, so there is no untitled session in the list and a retry adds none.
- **An answer to a closed form is a toast.** An answer lands in the form only while the opening that
  sent it is still on screen. Closed first, a refusal is a "No session was created" toast in the
  server's words, and a session is a "Session started" toast whose **Open** opens it; a later opening
  the person is typing into is neither closed nor navigated away from.
- **A refused first message is not a refused create.** If `createSession` lands and `sendMessage` is
  refused, the session exists: the form opens it and a toast says the prompt was not sent.
- **The cost line predicts the typed prompt** on the model and repo picked, once the prompt has rested
  for 400 ms, and asks nothing while it is blank. Changing the model or the repo unticks "Cap at
  predicted high" (`editSessionForm`): either is another range, whose high the person has not seen.

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
own `createSession` requests as the network oracle, `getSession` / `listSessions` read over the
RPC, and the `sessions` table read over TCP for what a refusal left (`listSessions` pages at 100 and
lists only sessions with activity, so it cannot see a stray row). The late cases hold the page's
`createSession` for 2.5 s (`page.route`) so the close lands while it is pending:

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
| the refused create left no session row behind                                  | no `sessions` row on that repo (the table)      |
| a refusal answered after the form was closed is a toast in the server's words  | a refusal is never dropped with its form        |
| a session landing on a later opening leaves that form open with its text, …    | an answer never closes a form being typed into  |
| the toast's Open opens the session it names, which ran the prompt it was sent  | the late session is reachable, and is the one   |

`drive.mjs`'s session-stream case ([session-stream.md](session-stream.md)) opens the same form and
types its own prompt; `cost.mjs`, `model.mjs`, `spend.mjs` and `auth.mjs` do too. The faux model runs
`FAUX_COMMAND` whatever the prompt says, so every drive still ends on `faux-ok (re: …)`.

Evidence: `.verify/evidence/latest/session-new/` — `session-new-open.png`, `session-new-empty.png`,
`session-new-scratch.png`, `session-new-repo.png`, `session-new-refused.png`,
`session-new-late-refused.png`, `session-new-late-session.png`, `observed.json` (every
`createSession` body the page sent).

Last passed **16/16** on 2026-10-28 from the `agent/E6` worktree, API `:9501` / web `:3501`.

## Gotchas

- The dialog is local state, not a URL: a reload closes it. The board's New card is `?new=card`
  because empty states will link to it (C9); nothing links to a New session form yet.
- Counting `listSessions` cannot prove a refused create left nothing: it is capped at the page size
  and joins `session_activity`, which a create only writes once its owner is open. The drive reads
  the `sessions` table for rows on its own broken slug instead (`sessionRowsOn`).
- A create whose process dies between the index row and the owner's open still leaves the row; a
  retry under the same request id repairs it. Only a refusal the server answers is cleaned up.
- The RPC client posts to `<api>/rpc/` (trailing slash): match the path's prefix, not its end.
