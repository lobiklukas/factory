# Card pane (the board's write path)

**Status: passing.** Clicking a card on `/boards/<id>` opens the card pane beside the lanes
(`?card=<task id>`): the moves the card's column declares and nothing else, the human-gated ones
marked, the service's own refusal when a move is refused, a run start, and the selected run's
transcript, approvals and sandbox as panes (LOB-76, part 2 of LOB-22).

## Sub-features

- **Declared transitions only.** The pane offers `declaredTransitions(column)` from
  `@repo/domain/Task` — the table `TaskService` refuses against — so a move the API would refuse as
  undeclared is never offered. A card in `intake` is offered `specifying` and `canceled`, never
  `done`. Each move is a `button[data-move-to=<column>]`.
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
- **Run start.** `button[data-start-run]` is `createSession` with the card named, exactly as
  `factory board start` does; it is enabled only in a `working` column (B4) and its `title` says why
  when it is not. The card's runs are `listTaskRuns` (new on `TasksRpc`), newest first, as
  `li[data-run=<session id>]`; picking one sets `?run=`. `?run=` opens only a run the card lists: any
  other session id renders `[data-run-foreign=<id>]` and no run panes.
- **Run panes.** Transcript (the session pane, composer and steering included), Approvals (the run's
  pending `listApprovals`, each `li[data-approval=<request id>]` with `[data-decide=approved|denied]`
  buttons, disabled while the decision is in flight; the click is `decideApproval` as `dashboard`,
  with `resume: true` since LOB-53 so the run wakes with the answer — the same row component as
  `/approvals` and the session pane, `components/approvals.tsx`)
  and Sandbox (none: runs execute in-process, B12).
  `/sandboxes` and `/approvals` left the rail for these; the routes stay (`/approvals` is every run's
  pending list since LOB-53, see [routing.md](routing.md)).
- Selection is in the URL only; nothing is kept in the browser's storage.

## How to get to it (user POV)

Open the dashboard, click **Boards**, click a board, click a card.

## Driving it with drive.mjs

The block runs after the lane checks, on the card the drive seeded in `intake`. It requires:

1. the card's link to open `aside[data-card-pane=<id>]` with `?card=<id>` in the URL;
2. the offered moves to equal `declaredTransitions("intake")` (read through bun from the domain
   package), and a direct `moveTask` to `done` from the drive to be refused `UndeclaredTransition`
   with the card unchanged;
3. no gated move and a disabled run start in `intake`, its `title` naming the resting column;
4. with the page's `getBoard`/`listTasks` held at the network (`page.route`), a block and an unblock
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
    clicked moves, the one run start and the one decision;
13. `?card=<id>&run=<a session id that is not one of its runs>` to render `[data-run-foreign]` and
    no run tabs.

Evidence: `card-pane-intake.png`, `card-pane-stale.png`, `card-pane-run.png`,
`card-pane-approvals.png`, and
`observed.cardPane`.

## Gotchas

- **The stale move needs the page's reads held.** The board polls every 2 s, so without the hold a
  poll could land between the out-of-band change and the click, and the click would send the fresh
  revision. The hold matches the request body's `"tag":"getBoard"` / `"tag":"listTasks"`; every
  other RPC passes through.
- **The revision bump is a block and an unblock**, not a move, so the card's column is the same
  before and after and "does not visually move" is a claim about one lane, not a race with another.
- **The approval is seeded through the API, not produced by a run.** `up.sh` starts the API ungated,
  so the faux run never asks; `requestApproval` is the contract a gated call uses (LOB-52), and the
  pane is proven against it. The gated run that parks and resumes on a decision is driven from the
  terminal by `.pi/skills/verify-cli/approve.sh` (LOB-53). The CLI half of "a move in `factory board move` appears in the
  browser, and the reverse" is driven here through the real CLI entry point (`apps/cli/src/index.ts`
  over the real API), not in `verify-cli`.
- **The `needs_input` walk is not here.** Answering a block needs LOB-46's spec stage; the parent
  (LOB-22) owns that walk.
