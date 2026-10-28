# First run (the front door and the checklist)

**Status: passing.** A new operator lands on a page with something to do (C9). The owner's report was
"when I open UI I can't do anything": the root redirected to an empty session list, the logo linked
there too, and the other sections were empty states with no next action. The board is the primary
surface ([board.md](board.md)), so the dashboard now opens on it.

## What is shown

- **`/` and the logo** open `/boards/<id>` when exactly one board exists, and `/boards` otherwise: with
  none a board is made there, with several the choice is the operator's. The logo links to `/`, so both
  mean the same; the page that decides reads `listBoards` afresh on every visit (a board made from the CLI
  is counted), and a list that fails to load lands on `/boards`, which shows the failure. The rule is
  `soleBoard` in `apps/web/src/lib/first-run-view.ts`.
- **The getting-started checklist** (`[data-getting-started]`, one `li[data-step=repo|board|card|run]`
  per step with `data-done` and `data-next`) is: register a repository → create a board → add a card →
  start a run. A step is ticked when `listRepos`, `listBoards`, `listTasks` (on each board) and
  `listTaskRuns` (on the first few cards) answer with something, so a step made from the CLI, a trigger
  or another browser ticks it too; it re-reads every 4 s and when this page writes. The first two steps
  link to their forms (`/repos`, `/boards?new=board`); the card step links to `?new=card` on the first
  board and the run step to the first card's pane, and until there is a board or a card each says
  `Once a board exists` / `Once a card exists` instead of linking to a form that cannot work.
- **Where it is shown:** `/boards` with no board (under the empty state, which keeps its **New board**
  action), `/boards` above the list while any step is unticked, and a board's page while it has no card.
  With all four ticked it is not shown, and a run ticks all four (a run implies the card, the board and the
  repository it runs from), so a control plane whose boards were made over a slug nobody registered is not
  nagged once it runs. Nothing is shown before the first read lands or when a read fails: a step ticked on a
  guess is worse than no list. Until a run exists a board made over an unregistered slug leaves step 1 honestly
  unticked (`createBoard` does not register the repository). The reads stop at the first run found (every card
  is asked about, in batches, so a run on any card counts) and a refresh after that reads nothing, so an open
  /boards tab on a control plane in use costs no requests. On a board's own page "Add a card" opens that board's
  form (`unit: first-run-view.test.ts`, `first-run-read.test.ts`).
- **Every empty state names a press.** `/attention`, `/approvals`, `/sandboxes` link to the boards
  (`[data-empty-action]`), `/spend` to the sessions, `/sessions`' empty pane to the boards beside the
  sidebar's **New session**. Each also links the step of the getting-started guide it is about (G1,
  `[data-guide-link]`, `GuideLink`; `docs/getting-started.md`): `/boards` (empty) and `/repos` (empty) the
  board and repository steps, the four checklist steps their own (3 to 6), the rest the run step or, for
  `/approvals`, plan approval. The href is the guide at the step's heading, and
  `apps/web/src/lib/guide-links.test.ts` fails when a heading is renamed. `apps/web/src/empty-states.test.ts` fails on a `factory <command>` in any route
  or component's copy.

## How to get to it (user POV)

Open the dashboard root on a database with nothing in it. Press the first unticked step, finish its form,
and come back to Boards: the step is ticked.

## Driving it with first-run.sh

`./first-run.sh` owns its API, dashboard and a throwaway database (`FIRST_RUN_API_PORT`, default 9562;
`FIRST_RUN_WEB_PORT`, default 3562). `first-run.mjs` requires, in a real browser, with the RPC only as the
oracle (the one board made over RPC is the routing case's second):

1. **Empty.** The database holds no repository, board or session; `/` opens `/boards`; the checklist
   lists the four steps with nothing ticked, the first next, the first two linking to their forms and the
   other two naming what they wait for; the page has no `factory <command>`; it links the guide's board
   step and one guide step per checklist step (texts "Getting started, step N: …").
2. **States.** Each of the five empty routes names a press and links one step of the guide; none gives a
   command.
3. **Repo.** The first step's link opens `/repos`; registering a throwaway checkout there ticks step 1 only
   (`x---`), equal to `listRepos`.
4. **Board.** The second step's link opens the New board form; creating on the registered repository ticks
   step 2 (`xx--`), and the new board's own page carries the checklist with the card step linked.
5. **Card.** The card step opens the New card form; creating a card puts it on the board and the board's
   page drops the checklist; `/boards` shows `xxx-`, the run step linking to the card.
6. **Run.** The run step opens the card; moving it out of intake, **Start run** then **Send** ticks step 4,
   and `/boards` shows no checklist.
7. **Routing.** With one board `/` and the logo open its lanes; with a second board both open the list.
8. **No console errors.**

Evidence: `.verify/evidence/latest/first-run/` holds `first-run-{empty,empty-spend,after-repo,after-board,
after-card-board,after-card,done,several}.png`, `observed.json`, `api.log` and `web.log`.

## Gotchas

- **A card rests in `intake`.** Nothing runs there until a person moves it on, so the run step's detail says
  to move the card first and the drive does it with the pane's move control.
- **The checklist is a read, not a record.** It keeps nothing in the browser: deleting the only card
  un-ticks step 3. That is the point, and why a reload and another browser agree.
- **`drive.mjs` makes its own boards,** so its `/` check computes the expected landing from `listBoards`
  rather than assuming a count.
