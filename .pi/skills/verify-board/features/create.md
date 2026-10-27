# Create a card

**Status: passing.**

## What it is

A card is a `tasks` row a trigger opens in `intake` at revision 1 (docs/board.md B2): `createTask` on
the RPC surface, with the board instance, a title and the actor who opened it. It is the board's only
way in — no `factory` command creates a card, because the card is the tracker's work item.

## How a user reaches it

A trigger (Linear, GitHub issues, Jira, Slack) or any RPC client:

```ts
const card = await client.createTask({
  boardId,
  title: "verify-board card 3902dd",
  actor: "verify-board",
});
// → { id: "tsk_…", column: "intake", revision: 1, … }
```

## How the skill drives it

`create.ts`, the drive's first phase, calls `createTask` over the same NDJSON RPC client the CLI and
the dashboard build, against the board `./up.sh` seeded, with a title unique to the drive. It asserts:

- the card opens in `intake` at revision 1;
- `getTask` reads back the same id, title, column, revision and board.

The card id lands in `.verify/run/card.json` for the rest of the drive; `create.json` holds the
created card, the read-back and the checks. A fresh card per drive is what keeps the drive's revision
arithmetic true on a second run against one instance.

## What it does not prove

Any trigger's mapping from a tracker item to a card — that is `verify-api`'s `linear.md`,
`github.md`, `jira.md` and `slack.md`.
