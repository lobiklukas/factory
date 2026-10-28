# New card (the board page)

**Status: passing** (2026-10-28, `agent/LOB-275`, API `:9600` / web `:3600`: verify-board's
`card-create.sh` **8/8** with `card-create.mjs`'s **10/10** folded in, inside `./drive.sh` exit 0, 66/66;
and once against LOB-261's `factory board add` from its worktree, the twin made through it, 8/8 and
10/10).

An operator delegates work from the browser (LOB-275): the board page's **New card** puts a card on
the board through `createTask`, as the dashboard, exactly as `factory board add` (LOB-261) and a
trigger do. The form is the board's only create surface; the empty states and the getting-started
path that link to it are C9's (planned), the New session form E6's (planned).

## What is shown

- **The action** is `header [data-new-card]` on `/boards/<id>`: a link, not a button, to
  `/boards/<id>?new=card` (keeping any open card). `new=card` is the stable URL that opens the form, so
  any page can link to it, a reload keeps it open, and a fresh tab at that URL opens with the title
  focused. Closing it (Cancel, Escape, the close button) takes `new` out of the URL. The search rule is
  `validateSearch` in `apps/web/src/routes/boards.$boardId.tsx`: any other value reads as closed.
- **The form** (`form[data-card-form]` in `[data-new-card-dialog]`, `components/new-card.tsx`) takes a
  title (required), a body in markdown (optional), a priority (`normal`, or `urgent`: first in its
  lane, B9) and a base ref (optional; blank is the repository's default). The repository is the
  board's (LOB-255) and the column the definition's initial one (LOB-267); the dialog says both and
  asks for neither.
- **The payload** is `createCardInput` (`lib/card-create-view.ts`): title trimmed, body sent exactly as
  typed and left out when blank, base ref trimmed and left out when blank, the priority chosen, actor
  `dashboard`, no repo — the same input `factory board add` sends for the same flags, so the server's
  defaults are the same whichever door the card came through.
- **An empty title is refused inline**: `[data-card-problem=title]` reads `A card needs a title.`, the
  title is `aria-invalid`, and no request is sent. A body over 32,000 characters or a base ref over
  1,024 is refused the same way (the payload schema's caps; the client's own encode would fail).
- **A server refusal is a toast in the server's words**: `The card was not created`, with
  `createTask`'s message verbatim as its description (`createRefusal`). A base ref no run can start
  from (`main..release`) is `InvalidTaskInput`, judged by the server's `isSafeBranchName`, not a copy of
  the rule in the form. The form stays open and keeps everything typed.
- **A created card** closes the form and opens the card's pane (`?card=<id>`) at once; the lanes show
  it in intake when the board read the create invalidated (`BOARD_KEY`) answers, without a reload.
  Until that read lands the pane says `Opening the new card` (`[data-card-pane-opening]`), never
  `No such card on this board`.

## How to get to it (user POV)

Open a board from **Boards** in the rail, then **New card** in its header. Or open
`/boards/<id>?new=card`.

## How it is driven

By verify-board, not here: the form is half of the board's CLI ⇄ browser equivalence, so it is driven
in that skill's both-ways phase, against a board and a CLI of its own —
[`card-create.sh`](../../verify-board/card-create.sh) (the terminal) and
[`card-create.mjs`](../../verify-board/card-create.mjs) (one page, never reloaded). `drive.sh` runs it;
it also runs alone against an instance `./up.sh` started:

```sh
cd .pi/skills/verify-board
DATABASE_URL=… API_PORT=9600 WEB_PORT=3600 GITHUB_PORT=9603 ./up.sh
API_PORT=9600 WEB_PORT=3600 ./card-create.sh
./down.sh
```

The page requires, in order:

1. **Reach.** The header's **New card** opens the form; the link and the URL carry `new=card`.
2. **Empty.** A title of spaces is refused inline on the title, with zero `createTask` requests.
3. **Refused.** Title, a multi-line markdown body with an em dash, `urgent`, base ref `main..release`:
   the toast's description equals `createTask`'s own message for the same payload (the oracle makes
   the call from the drive process; it is refused too, so it writes nothing), the page sent one
   request, and the form keeps all four fields.
4. **Created.** Base ref `main`: the page's second `createTask` is exactly
   `{ boardId, title, priority: urgent, body, baseRef: main, actor: dashboard }` with no repo; the form
   closes, the card's pane opens, the card is in `intake` and a `window` marker set at load survives.
5. **Followed.** After the terminal makes the twin, the same page shows it in `intake`, marker intact.
6. **Same.** `listTasks` holds the two with equal title, body, repo (the board's, per `getBoard`),
   priority, base ref, column and revision.
7. **Link.** A fresh page at `?new=card` opens the form with the title focused; Escape closes it and
   removes `new` from the URL.
8. **No console errors.**

The terminal half requires `factory board ls` to list the browser's card under `intake`, `factory board
show` to print it as filed (column, revision 1, `urgent`, the board's repo, the title, `base main`, every
body line indented), the twin to be made with the same inputs, and its `show` to print the same lines
but the id. The twin is `factory board add` when the CLI offers it (read off `factory board --help`'s
subcommand list); on a tree without LOB-261 it is `createTask` with the same inputs as the CLI's actor,
and the check naming the door says which one ran.

Evidence (`.verify/evidence/latest/board/`): `card-create.json` (the terminal's checks, both ids, the
door), `card-create-web.json` (the page's checks, what it sent, the oracle's reads),
`card-create-{form,refused,created,followed,link}.png`, `card-create-{ls,show-browser,add,show-cli}.txt`.

## Gotchas

- **The server does not refuse an empty title.** `TaskService.create` stores what it is given; the
  form and `factory board add` both refuse a blank one before any request. A trigger always has one.
- **The form judges no ref.** Whether a base ref names a commit in the checkout is learned when a run
  is cut from it; the server refuses only refs no run could pass to git.
