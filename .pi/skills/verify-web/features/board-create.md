# New board (the boards page)

**Status: passing.** On a control plane with no board, an operator makes one in the browser (C5). The
**New board** action sits in the `/boards` header and in its empty state; it is the dashboard's face
for `createBoard` (LOB-208), as `factory board create` is the CLI's
([verify-board's boards.md](../../verify-board/features/boards.md)).

## What is shown

- **The form** (`[data-board-form]`, in `[data-new-board-dialog]`) is open while the URL says
  `/boards?new=board`, so the header's action, the empty state, a reload and any page that links there
  open the same form. Cancel and Escape take `new` out of the URL.
- **Repository.** The registered repositories (`listRepos`) in a select, with **Another repository…**
  last, which shows a slug input; with none registered it is the slug input alone. A board over a
  repository with no checkout is made, and its page carries the server's checkout warning
  (`[data-checkout-warning]`): `createBoard` does not register the repository.
- **Definition and version** (`listDefinitions`). The definition select lists the ids, defaulting to
  `default`; the version select leads with **Newest (vN: name)**, which sends no version so the server
  pins the newest at creation, then every version newest first. Choosing a version pins that one.
- **A refusal is in the dialog.** A slug outside `owner/name` is stopped in the form
  (`[data-board-problem=repo]`) and sends nothing. `BoardExists` and `DefinitionNotFound` are the
  server's message verbatim (`[data-board-refusal=<tag>]`); `BoardExists` also links to the board it
  names (`[data-board-existing=<id>]`). The form keeps what was chosen and nothing is written.
- **Created** navigates to `/boards/brd_…`; the list shows the board from `listBoards`, re-read when
  the create lands.

The rules are pure in `apps/web/src/lib/board-create-view.ts` and unit-tested beside it.

## How to get to it (user POV)

Click **Boards** in the rail, then **New board** (or open `/boards?new=board`), pick or type the
repository, pick the definition and version, and press **Create board**.

## Driving it with board-create.sh

`./board-create.sh` owns its API, dashboard and a throwaway database (`BOARD_CREATE_API_PORT`, default
9561; `BOARD_CREATE_WEB_PORT`, default 3561). `board-create.mjs` requires, in a real browser:

1. **Empty.** `listBoards` is empty and the empty state offers **New board**.
2. **Reach.** The action opens the form and the URL says `?new=board`.
3. **Pickers.** The definition select equals `listDefinitions`' ids and defaults to `default`; the
   version select leads with the newest, then every version newest first; with no repository
   registered the repository is a slug input.
4. **Refused.** `Not A Repo` is stopped in the form quoting the slug, with no `createBoard` request.
5. **Created.** A typed slug on the newest version lands on `/boards/brd_…`, its lanes equal the
   definition's columns in order, `getBoard` pins the newest version, and `factory board list` prints
   the board's line.
6. **Exists.** The same slug again is `BoardExists`, the server's message verbatim, `listBoards`
   unchanged, with a link that opens the existing board.
7. **Picker.** A repository registered over RPC is offered in the select; picking it with version 1
   makes a board pinned to version 1.
8. **Missing.** The page's own `createBoard` is rewritten in flight to name an unknown definition
   (the pickers never offer one); the page shows the server's `DefinitionNotFound` message verbatim,
   nothing is written, and the form keeps its input.
9. **Cancel** closes the form and clears `new`; the list holds exactly the drive's two boards.
10. **No console errors.**

`drive.mjs` makes its own board through this form (version 1) and seeds the card onto it.

Evidence: `.verify/evidence/latest/board-create/` holds `board-create-empty.png`, `-form.png`,
`-created.png`, `-exists.png`, `-definition-missing.png`, `observed.json`, `api.log` and `web.log`.

## Gotchas

- **`DefinitionNotFound` cannot be reached by the pickers** — they offer what `listDefinitions` says
  exists, and definitions are only added. The drive reaches it by rewriting the request in flight; the
  message shown is compared with the server's for the same call.
- **The registry gains no row from `createBoard`.** A board over an unregistered slug has no entry in
  the repository picker afterwards; register it (`/repos`, `factory repo add`) to have it listed.
