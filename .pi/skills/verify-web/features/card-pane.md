# Card pane (the board's write path)

**Status: passing.** Clicking a card on `/boards/<id>` opens the card pane beside the lanes
(`?card=<task id>`): the moves the card's column declares and nothing else, the human-gated ones
marked, the service's own refusal when a move is refused, a run start, and the selected run's
transcript, approvals and sandbox as panes (LOB-76, part 2 of LOB-22).

## Sub-features

- **Declared transitions only.** The pane offers `columnTransitions(definition, column)` from
  `@repo/domain/Task` under the definition version the card pinned — what `TaskService` refuses
  against — so a move the API would refuse as undeclared is never offered. A card in the default
  pipeline's `intake` is offered `specifying` and `canceled`, never `done`. Each move is a
  `button[data-move-to=<column>]`.
- **A definition's own moves (LOB-267).** A column declares `transitions: [{ to, gate? }]`; a
  definition with its own column set is offered exactly those, never the default table by name. The
  board read (`boardAtom`) also fetches, through `getDefinition`, any version a card pinned other than
  the board's, so a card's moves are always its own version's.
- **Human gates are marked.** `planning → building` (plan approval) and `review → done` (merge)
  carry `data-human-gate=<gate>`, a person icon, `person · <gate>` beside the column, and an
  accessible name ending `a person's move`. The dashboard's actor is `dashboard`, a person (B5), so
  the gated move is offered — marked, never unmarked.
- **A refusal is the service's words.** A click sends the revision the pane rendered. A refusal is
  rendered as `[data-move-refusal=<tag>]` with a heading per tag and the service's `message`
  verbatim (the same words `factory board move` prints); the card is never moved by the page itself,
  and the board is re-read so the next attempt expects the revision the server holds. The refusal
  is dropped once the card's revision passes the one the server refused at (a CLI move, another
  browser), and after a move lands the buttons stay disabled until the board read shows the
  revision the server answered, so a second click cannot be refused as stale for the person's own
  move.
- **The board follows the server.** `boardAtom` re-reads every 2 s (`BOARD_POLL`) and at once when a
  move from the page lands, so a move made in `factory board move` appears without a reload. A poll
  that fails keeps the last good board (and the open pane) on screen with a `[data-board-stale]`
  "Reconnecting" marker; only a first read that fails, or `BoardNotFound`, replaces the page.
- **Run start.** `button[data-start-run]` opens `form[data-start-form]` (C6): a prompt field,
  `textarea[data-start-prompt]`, pre-filled with the card's default prompt — its title, its body and
  the column's instruction (`runPrompt`, the text `factory board start` sends with no `--prompt`) —
  and **Send** (`[data-start-send]`) is `createSession` with the card named, exactly as `factory board
start` does, then `sendMessage` with the field's text, so the run is busy when the pane opens it.
  **Cancel** (`[data-start-cancel]`) closes the field and opens no run; an empty field cannot be sent
  (`[data-start-unsendable]`). A first message the server refuses leaves the run open and says so in a
  toast. The button is enabled only in a `working` column (B4) and its `title` says why when it is not.
  The card's runs are `listTaskRuns` (new on `TasksRpc`), newest first, as
  `li[data-run=<session id>]`; picking one sets `?run=`. `?run=` opens only a run the card lists: any
  other session id renders `[data-run-foreign=<id>]` and no run panes. Proven end to end, against the
  CLI's twin, by verify-board's `start-prompt.sh`. The form has a **Budget, US$** field
  (`input[data-start-budget]`, C23): blank sends no cap of the run's own, an amount is the `budget` on
  `createSession`, anything else shows `[data-start-budget-invalid]` and makes Send unavailable. A run
  its cap stopped shows a **Raise cap** form (`form[data-raise-cap]`, `input[data-raise-cap-input]`,
  `button[data-raise-cap-submit]`) under the stop in its transcript, opened at twice the stopping cap:
  it sends `setSessionBudget`, refuses a cap the spend already reaches, and goes away once raised.
  Driven by verify-board's `budget.sh`.
- **Run panes.** Transcript (the session pane, composer and steering included), Approvals (the run's
  pending `listApprovals`, each `li[data-approval=<request id>]` with `[data-decide=approved|denied]`
  buttons, disabled while the decision is in flight; the click is `decideApproval` as `dashboard`,
  with `resume: true` since LOB-53 so the run wakes with the answer — the same row component as
  `/approvals` and the session pane, `components/approvals.tsx`)
  and Sandbox (none: runs execute in-process, B12).
  `/sandboxes` and `/approvals` left the rail for these; the routes stay (`/approvals` is every run's
  pending list since LOB-53, see [routing.md](routing.md)).
- **Thread.** The card's question, answers and notes, oldest first and verbatim, with a composer
  that answers a `needs_input` block (LOB-239). See [thread.md](thread.md), driven by `thread.sh`.
- **Where the card came from (LOB-254).** A card filed by a trigger delivery carries its tracker
  issue's ref (`linear:<issue id>`) and link; the header shows the ref as
  `a[data-card-external-link=<url>][data-card-external=<ref>]`, opening in a new tab
  (`rel="noreferrer noopener"`). A ref with no link is shown as text (`[data-card-external]`), a ref
  that is itself a URL is linked, and a card from nowhere shows neither. Only an absolute `http(s)`
  URL is ever an `href` (`isWebLink`; `createTask` refuses any other `externalUrl`). The drive files
  such a card through `createTask` (the fields the Linear card path sets) and requires the link, its
  target and rel, no external ref on the seeded card, and a `javascript:` link refused by the API
  (evidence `card-pane-external-link.png`).
- **State controls (C11).** The pane writes the card's state, each at the revision on screen, as a
  move is: **Block** (`[data-card-block-open]`) opens `form[data-card-block-form]` — a reason
  (`dependency`, `capability`, `transient`; `needs_input` is a run's question and `setup_failed` a
  run's, so a person is not offered them, though `factory board block` takes every reason) and an
  optional note — and a blocked card shows what it waits on and **Unblock** (`[data-card-unblock]`);
  the pencil (`[data-card-title-edit]`) turns the title into an input (Enter saves, Escape leaves; a
  blank, over-long or unchanged title cannot be sent); the priority badge
  (`button[data-card-priority=normal|urgent]`) flags the card urgent or clears the flag. They are
  `blockTask`, `unblockTask` and the new `updateTask` (title and/or priority; one revision, one
  `retitled` / `priorityChanged` event per changed field; a value the card already has is no edit).
  A refusal is `[data-card-edit-refusal=<tag>]` in the server's own words, kept while the card is at
  the revision it refused at. They share the pane's write hold with Moves and Thread. The CLI twin is
  `factory board update`. Driven by `card-edit.sh` ([card-edit.md](card-edit.md)).
- Selection is in the URL only; nothing is kept in the browser's storage.

## How to get to it (user POV)

Open the dashboard, click **Boards**, click a board, click a card.

## Driving it with drive.mjs

The block runs after the lane checks, on the card the drive seeded in `intake`. It requires:

1. the card's link to open `aside[data-card-pane=<id>]` with `?card=<id>` in the URL;
2. the offered moves to equal the `exits` of `intake` in the card's own pinned definition version
   as the server describes it (`getTask` for the version, then `getBoardConfig`, or `getDefinition`
   for a version other than the board's; LOB-267), and a direct `moveTask` to `done` from the drive
   to be refused `UndeclaredTransition` with the card unchanged;
3. no gated move and a disabled run start in `intake`, its `title` naming the resting column;
4. with the page's `getBoard`/`listBoardCards` held at the network (`page.route`), a block and an unblock
   through the API (r1 → r3, same column), then a click on `specifying`: the pane shows
   `StaleRevision` with the service's `is at revision 3, not 1`, the card stays in `intake` in the
   DOM and on the server, and once the held reads land the pane is at r3, still in `intake`;
5. `factory board move --to specifying --expect-revision 3` to appear in the page with no reload (a
   `window` marker survives), the stale refusal to be gone, and the pane to re-offer
   `specifying`'s declared moves;
6. a reload, and a fresh browser context, to show the card in `specifying`;
7. a click on `planning` in the pane, then `factory board show` to print `column planning` and
   `revision 5`;
8. out of `planning`, `building` marked `plan approval` and `canceled` unmarked;
9. **Start run** to set `?run=`, list the run (`listTaskRuns` from the drive agrees, column
   `planning`) and open its transcript pane;
10. the rail to have no `/sandboxes` or `/approvals` link, and the run tabs to be Transcript,
    Approvals, Sandbox;
11. a `requestApproval` on the new run, made from the drive, to be listed in the Approvals tab;
    a click on Approve to send one `decideApproval` (`approved`, actor `dashboard`), the pane to
    show `[data-no-approvals]`, and `listApprovals` from the drive to be empty;
12. no button, role-button or draggable in the lanes, and the page's writes to be exactly the two
    clicked moves, the one run start and the one decision (the thread's `listTaskComments` is a
    read; its `commentTask` is not clicked here);
13. `?card=<id>&run=<a session id that is not one of its runs>` to render `[data-run-foreign]` and
    no run tabs;
14. **a definition's own moves (LOB-267)**: `seed-definition.ts` writes a definition row — todo →
    doing → done, a `sign-off` gate on doing → done, `todo` its initial column, and a `review` column
    that declares nothing — and makes a board and a card over it through `TaskService`. The card is
    in `todo` at r1 and `getBoardConfig` names `todo` as the initial column; the lanes are the
    definition's four; the pane offers exactly `doing`, ungated; a direct `moveTask` to `done` is
    `UndeclaredTransition` in the service's words with the card unchanged; a click on `doing` moves
    it (r2) and the pane then offers `done` alone, marked `sign-off` as a person's move; a direct
    `moveTask` to `done` as a run's actor (`ses_…`) is `HumanGateRequired` naming `sign-off`, and
    the card stays in `doing`.

Evidence: `card-pane-intake.png`, `card-pane-stale.png`, `card-pane-run.png`,
`card-pane-approvals.png`, `card-pane-synthetic-todo.png`, `card-pane-synthetic-doing.png`,
`observed.cardPane` and `observed.cardPaneSynthetic`.

## Gotchas

- **The stale move needs the page's reads held.** The board polls every 2 s, so without the hold a
  poll could land between the out-of-band change and the click, and the click would send the fresh
  revision. The hold matches the request body's `"tag":"getBoard"` / `"tag":"listBoardCards"`; every
  other RPC passes through.
- **The revision bump is a block and an unblock**, not a move, so the card's column is the same
  before and after and "does not visually move" is a claim about one lane, not a race with another.
- **The approval is seeded through the API, not produced by a run.** `up.sh` starts the API ungated,
  so the faux run never asks; `requestApproval` is the contract a gated call uses (LOB-52), and the
  pane is proven against it. The gated run that parks and resumes on a decision is driven from the
  terminal by `.pi/skills/verify-cli/approve.sh` (LOB-53). The CLI half of "a move in `factory board move` appears in the
  browser, and the reverse" is driven here through the real CLI entry point (`apps/cli/src/index.ts`
  over the real API), not in `verify-cli`.
- **The `needs_input` walk is not here.** It needs a run that asks (`FAUX_ASK`), which `up.sh`'s
  instance does not run; `thread.sh` drives it on its own instance ([thread.md](thread.md)).
