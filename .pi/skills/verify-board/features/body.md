# A card's body and base ref, in its runs

**Status: passing.**

## What it is

A card says what it is for (LOB-260, docs/board.md B1). `createTask` takes a markdown `body`, a
`baseRef` and an `externalRef` (the tracker issue the card was filed from); each is stored on the card
and in its `created` event, so the card is derivable from `task_events` alone. A blank one is none.
The refs are trimmed, and a base ref that is not a plain git ref (a shell substitution, an option, a
`..`) or a field over its cap is refused at create as `InvalidTaskInput`, naming the field: every run
on the card hands its base ref to git, which now always gets it as an argv entry, never a shell line.

Every run on the card is told the body verbatim as its `task_body` prompt section, beside
`task_thread`; a card with no body gives its runs no section at all. A run that names no base of its
own cuts its worktree from the card's base ref instead of the repository's default.

## How a user reaches it

```sh
factory board show --task tsk_0123456789abcdefghjkmnpqrs
# …
# title     release notes
# base      release
# external  LOB-260
# body      6 lines
#       ## Goal
#     …
factory board start --task tsk_0123456789abcdefghjkmnpqrs --prompt "work on this card"
```

`factory board add --body/--body-file --base-ref` puts such a card on a board from the terminal
(LOB-261, [add.md](add.md)); a trigger or a client calls `createTask` with the same body and refs.
`start-body.sh`'s `body.ts` still makes its cards over `createTask` on purpose, as one read-back.

## How the skill drives it

`./start-body.sh`, against the instance from `./up.sh` and with `DATABASE_URL` naming its database:

1. Points a `release` branch in the fixture checkout at a new commit one ahead of `main`
   (`git commit-tree`, so the working tree is never touched).
2. `body.ts MODE=create` creates a card with a body (markdown, an em dash, leading spaces and trailing
   blank lines a trim would lose), base ref `release` and external ref `LOB-260`, and a bare card with
   none, over the API's `createTask`; `getTask` reads both back. A third create, with a base ref of
   `$(touch …)`, is refused as `InvalidTaskInput` on `baseRef` and writes no card.
3. `factory board show` prints `base      release`, `external  LOB-260` and the body's six lines (its trailing newlines are not counted),
   indented; on the bare card a `-` for each.
4. `factory board start --prompt` starts a run on each card, the way a person does.
5. `body.ts MODE=told` waits for both runs to take their turn, then reads the body card's run: bound to
   `release` (the session and its workspace), its worktree's `HEAD` is `release`'s commit and not
   `main`'s, and its recorded prompt (`readPromptSections` over the run's own log) holds the
   `task_body` section exactly as `renderBody` renders the body. The bare card's run stands on `main`
   and its prompt has no `task_body`.

Evidence: `start-body.json` (every check), `body-create.json`, `body-told.json` (the recorded section,
both sessions' bindings and `HEAD`s), and `body-*.txt` (the CLI's output).

## What it does not prove

What the run does with the body: the model is faux. Editing a body after the card is made — there is
no such write yet. That the card pane shows the body: the dashboard does not render it yet.
