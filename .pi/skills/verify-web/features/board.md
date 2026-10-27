# Board lanes

**Status: passing.** `/boards` lists the boards this control plane holds, and `/boards/<id>` renders
one board as lanes: one lane per column of the definition version the board binds, in definition
order, with the cards the server lists in each (LOB-75, part 1 of LOB-22).

## Sub-features

- The rail's first entry is **Boards** (`/boards`): `listBoards`, newest first, each row a link
  carrying the repository, the definition and version, and the board id. No boards reads
  `No boards yet`.
- `/boards/<id>` reads `getBoard` and `listTasks` together (`boardAtom`), so the lane order is the
  pinned version's and the cards are the server's, urgent first then FIFO (docs/board.md B2, B9).
- Each lane is a `section[data-lane=<column>]` with the column's kind and role; an empty lane reads
  `No cards` rather than disappearing.
- Each card is an `li[data-card=<task id>]`: title, `urgent` when it is, the block reason when it is
  blocked (B4 — blocked is a card state, so the card says it), then the id and revision a
  `factory board move` needs.
- A card in a column the definition does not declare is listed apart, never dropped.
- No control in the lanes acts on a card: a card is a link that opens the card pane (LOB-76,
  [card-pane.md](card-pane.md)), which is where moves, gates and the run start live.
- An open board re-reads the server every 2 s, so a move made elsewhere arrives without a reload.
- Nothing is kept in the browser. There is no storage layer in the atom runtime; the theme toggle's
  `factory.theme` is the only key the page may hold.
- `/boards/not-a-board` is refused by the route's decode; a well-formed id the server does not hold
  reads `No such board`.

## How to get to it (user POV)

Open the dashboard, click **Boards** in the rail, click a board. Each `node drive.mjs` run seeds its
own board with one card in `intake` through the board skill's seed (`.pi/skills/verify-board/seed.ts`),
so a rerun against the same `./up.sh` instance moves a fresh card rather than the last run's.

## Driving it with drive.mjs

The block runs after the session checks. The oracle for the lane order is `getBoard`, asked from the
drive process rather than the page. It requires:

1. the seed to print `brd_…`, `tsk_…` at revision 1, and the API's `getBoard` to hold that board (a
   miss means the drive's `DATABASE_URL` is not the API's);
2. the rail's **Boards** link, then the board's own link, to reach `/boards/<id>`;
3. the rendered lane names, left to right, to equal the definition's column names exactly;
4. the seeded card to be in `intake` and nowhere else, carrying its title;
5. `sessionStorage` empty and `localStorage` holding nothing but `factory.theme`;
6. the card pane's walk ([card-pane.md](card-pane.md)), which includes a `factory board move` to
   `specifying` (the real CLI over the API, run from the drive process) and `getTask` agreeing;
7. a reload to show the card in `specifying` only, and a **fresh browser context** — no storage, no
   cache — to show the same;
8. no button, role-button or draggable in the lanes, and the page's only writes to be the card
   pane's clicked moves and run start; the tags are read off the requests;
9. `/boards/not-a-board` to be refused locally.

Evidence: `boards.png`, `board.png`, `board-after-move.png`, and `observed.board`.

## Gotchas

- **The lanes never write.** The moves the drive makes in the page are the card pane's
  ([card-pane.md](card-pane.md)); the final check counts the page's writes against what was clicked.
- **The drive runs the board skill's seed by path** (`bun run .pi/skills/verify-board/seed.ts`), as
  `verify-board/up.sh` does. bun's isolated linker links a workspace package only into the packages
  that declare it, so this works because the root `package.json` declares `@repo/core` and
  `@repo/storage-postgres` (LOB-175); a driver that imports a workspace package the root does not
  declare needs it added there, not a resolution workaround.
- **`/boards` lists every board in the database**, test boards included, capped at the 100 newest
  (`LIST_BOARDS_LIMIT`); at the cap the page says older boards are not listed. The seeded board is
  first because it is newest. The `listBoards` test dates its rows a day ahead to be the newest, and
  deletes any such rows an earlier killed run left before it inserts, so they cannot push the seed
  off the page for long.
