# The card's thread (question, answer, notes)

**Status: passing.** The card pane's **Thread** section shows a card's thread — the question a parked
run asked, a person's answer, and every note — and its composer posts to it, so a person answers a
parked card from the browser (LOB-239, the `needs_input` walk of LOB-22). Before it, only
`factory board comment` could.

## What it shows

- **The thread is `listTaskComments`** (`taskCommentsAtom`), oldest first, polled with the board
  (`BOARD_POLL`, 2 s) because most of it is written off the page: a run's question is its `ask`
  tool's, in-process, and an answer can come from the CLI. Each comment is
  `li[data-comment-kind=question|answer|note]` with `data-comment-actor` and
  `data-comment-revision`; its header names the kind (`Question`, `Answer`, `Note`), the actor (a
  run's session id, `dashboard`, `cli`, …), the revision and the time (`time[datetime]`, UTC to the
  second); its body (`[data-comment-body]`) is the text verbatim, `white-space: pre-wrap`, because
  the next run on the card is quoted the same bytes. No comment: `[data-thread-empty]`.
- **The kind is the server's.** `TaskService.comment` records it under the row lock: a person's
  comment on a card blocked `needs_input` is the `answer` and lifts the block in the same
  transaction; anything else — including a run's comment on its own parked card — is a `note`.
- **The composer says which it will be.** `form[data-thread-intent=answer|note]`: on a card blocked
  `needs_input` the button reads **Answer** and the hint names the column it blocked from; anywhere
  else **Comment**, and the hint says the card does not change. A whitespace-only draft or one longer
  than `MAX_COMMENT_CHARS` is not sendable, and says why (`[data-thread-unsendable]`). Cmd/Ctrl+Enter
  sends.
- **The send is `commentTask` at the revision the pane rendered**, as `dashboard` (a person). When it
  lifts a block the pane says so (`[data-thread-lifted=<reason>]`: the card is no longer blocked, and
  the next run reads the answer), the card header's `blocked · needs input` badge goes, and the board
  and the attention view re-read (`BOARD_KEY`).
- **A stale send is refused, re-read, and kept.** If the card changed while the person typed — a run
  added a note, someone else answered — the server refuses `StaleRevision`; the pane shows
  `[data-comment-refusal=StaleRevision]` with the service's words, re-reads the card and its thread,
  and leaves the draft in the composer. It never resends on its own: if another answer already lifted
  the block, the same words would now be a note, and that is the person's call.
- **The attention view links straight to it.** A question row's link is
  `/boards/<id>?card=<task>#thread`; the pane scrolls the section (`section#thread`) into view and
  focuses the composer.

## How to get to it (user POV)

Open a card on its board, or click a row under **Answer a run's question** in **Needs a person**.

## Driving it with thread.sh

```sh
THREAD_API_PORT=9431 THREAD_WEB_PORT=3431 ./thread.sh   # its own instance; leaves nothing running
```

`thread.sh` starts its own API with `FAUX_ASK` (the question the faux run asks once its `bash` turn is
done, when its prompt carries no thread) and its own dashboard, runs `thread.mjs`, and stops both.
`FAUX_ASK` is API-wide, so it cannot run on `up.sh`'s instance: every card run in `drive.mjs` would
ask. The drive requires:

1. a fresh card in `specifying` (moved there through the API as a person) to show
   `[data-thread-empty]` and a disabled **Comment**;
2. **Start run** in the pane and a message in the run's composer to park the card: `getTask` says
   `needs_input` from `specifying`, `getSession` says the run is idle, and — with no reload — the pane
   shows the question verbatim with kind `Question`, the run's session id as actor and the server's
   `createdAt`, the composer turned into **Answer**, and the card marked blocked;
3. the attention view's question row to link `?card=<task>#thread`, and a click on it to land with the
   section in view and the composer focused;
4. with the page's `getBoard`/`listTasks`/`listTaskComments` held at the network, a note from the run
   (`commentTask` from the drive, the run's session id as actor: revision +1, still blocked); the
   answer typed and sent from the stale pane to be refused `StaleRevision` with the service's `is at
revision N, not M`, the card still blocked on the server, and the typed text still in the
   composer; the page to issue `getBoard` and `listTaskComments` within 500 ms of the refused send,
   sent at a moment neither poll was due for a second, so the re-read is the refusal's and not the
   poll's; once the reads are let through, the pane at the server's revision with the note in its
   thread and the draft unchanged;
5. a second click to land: `[data-thread-lifted=needs_input]`, the pane and `getTask` unblocked, no
   reload, the thread ending with an `answer` by `dashboard` whose body is the typed text byte for
   byte (two lines, the second indented, an em dash) and renders with `pre-wrap`; the page sent
   exactly two `commentTask`s, the second at the server's revision;
6. `factory board show` to print `blocked   -`, `thread    3`, and the answer's lines indented
   verbatim under `[answer] dashboard`;
7. **Start run** again and a message: `../verify-board/ask.ts MODE=told` reads the new run's
   committed prompt from Postgres and finds the answer verbatim after the question, and the run did
   not ask again; the pane lists both runs and the thread has one question;
8. no console error.

Evidence: `.verify/evidence/latest/thread/` — `thread-question.png`, `thread-from-attention.png`,
`thread-stale.png`, `thread-answered.png`, `thread-next-run.png`, `board-show.txt`,
`thread-told.json`, `observed.json`, `api.log`, `web.log`.

## Gotchas

- **The pane's reads are held for the stale send**, as the card pane's stale move holds them: the
  board and thread poll every 2 s, and a poll landing between the run's note and the click would make
  the click send the fresh revision.
- **The refusal's re-read is timed, not inferred from the result.** The poll alone would bring the
  pane to the server's revision once the reads are released, so "the pane caught up" proves nothing
  about the refusal handler. The drive records when the page issued each read, sends when both polls
  are at least 1 s off, and requires both reads inside 500 ms of the send.
- **Moves and the Thread share one write hold** (`CardWrites` in `card-pane.tsx`): an answer lands at
  R+2, so after either write both the moves and the composer wait for the board read to show it.
  Text typed while a send is in flight is kept; only the sent text is cleared (`draftAfterSend`).
- **The run's note is a note, not an answer**, because its actor is a session id (B7: only a person
  answers). That is what lets the drive bump the revision without lifting the block it then answers.
