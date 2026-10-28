# Card pane state controls: block, unblock, urgent, title

**Status: passing.** An operator can park a card on a dependency, mark it urgent, or fix its title from
the card pane, and the lane and `factory board show` agree (C11).

**What it is.** Three writes in the card pane, each at the revision on screen and sharing the pane's
write hold with Moves and the Thread (`CardWrites`): `blockTask` / `unblockTask` (which had no caller
in the dashboard) and `updateTask`, new, `{ taskId, expectedRevision, title?, priority?, actor }`.
`TaskService.update` locks the card at the expected revision (`StaleRevision` otherwise), refuses a
blank or over-long (`MAX_TASK_TITLE_CHARS`, 300) title or a call naming neither field
(`InvalidTaskInput`), treats a value the card already has as no edit (no revision, no event), and
otherwise moves the revision on by one and writes one event per changed field (`retitled`,
`priorityChanged`) at the revision the call expected, so `replay` rebuilds the card from its history.
The actor is the credential's, as every board write's (LOB-20).

**How a user reaches it.** Open a card (`?card=<id>`). **State** holds **Block…**; the title has a
pencil; the priority badge beside the revision is a toggle. Selectors: `[data-card-block-open]`,
`form[data-card-block-form]` (`[data-block-reason=<reason>]`, `[data-card-block-note-input]`,
`[data-card-block-submit]`), `[data-card-unblock]`, `[data-card-title-edit]`,
`[data-card-title-input]`, `[data-card-title-save]`, `button[data-card-priority=normal|urgent]`,
`[data-card-edit-refusal=<tag>]`. The CLI twin of the edit is `factory board update --task tsk_… [--title …]
[--priority urgent|normal] [--expect-revision n]`.

**How the skill drives it.** `./card-edit.sh` (own API and dashboard); `card-edit.mjs` makes a board and
two cards over the RPC and drives the pane in Chrome, with `factory board show` and the RPC as oracle.

**What proves it.** Block with `dependency` and a note: the lane's card reads `blocked · waiting on a
dependency`, `board show` prints the block, its column and the note, one revision on. Unblock clears the
label and `board show` prints `blocked -`. The priority toggle puts the `urgent` marker on the lane and
moves the older neighbour behind the card (B9); pressing it again clears it. A title edit with Enter
reaches the lane and `board show`; a blank title leaves Save disabled. With the page's board reads held
at the network, a write made at the server moves the card on; the pane's Block is refused with the
service's `is at revision 7, not 6`, nothing is blocked by it, and once the reads land the pane shows
the other write's block; the next Unblock lands and clears the refusal. `factory board update` is read
back on the lane. The service's side is `TaskService.test.ts` against Postgres on 5442; the pure
wording and send rules are `apps/web/src/lib/card-edit-view.test.ts`.

## Gotchas

- A refusal describes the revision the server held when it refused, so after a stale refusal it stays
  on screen beside the card the pane now shows, until the person's next write or a later change: it is
  the explanation of why their press did nothing.
- `needs_input` is not offered as a reason: a block with no question in the thread has nothing for an
  answer to answer. A `needs_input` card shows Unblock all the same (the server allows it) and says an
  answer in the thread lifts it.
