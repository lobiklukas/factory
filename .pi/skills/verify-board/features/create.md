# Create a card

**Status: passing.**

## What it is

A card is a `tasks` row a trigger opens in `intake` at revision 1 (docs/board.md B2): `createTask` on
the RPC surface, with the board instance, a title and the actor who opened it. It is the board's only
way in — no `factory` command creates a card, because the card is the tracker's work item.

A card's repository is its board's (LOB-255): `createTask` with no `repo` stores the board
instance's, so every run on the card — `factory board start --task` and the card pane pass the
card's repo, and the server binds a card's run that names none to it too — is a worktree on
`factory/<session-id>` with a branch the PR step can publish. A `repo` other than the board's is
refused as `BoardRepoMismatch`, naming both, and writes nothing.

## How a user reaches it

A trigger (Linear, GitHub issues, Jira, Slack) or any RPC client:

```ts
const card = await client.createTask({
  boardId,
  title: "verify-board card 3902dd",
  actor: "verify-board",
});
// → { id: "tsk_…", column: "intake", revision: 1, repo: "<the board's repo>", … }

await client.createTask({
  boardId,
  title: "…",
  repo: "acme/other",
  actor: "…",
});
// → BoardRepoMismatch: board brd_… is over <the board's repo>, so a card on it cannot name acme/other
```

## How the skill drives it

`create.ts`, the drive's first phase, calls `createTask` over the same NDJSON RPC client the CLI and
the dashboard build, against the board `./up.sh` seeded, with a title unique to the drive. It asserts:

- the card, created with **no repo**, carries the board's repository (LOB-255);
- a create naming another repository is `BoardRepoMismatch`, naming both, and no card with its title
  is on the board afterwards;
- the card opens in `intake` at revision 1;
- `getTask` reads back the same id, title, repo, column, revision and board.

Because the drive's card names no repo, the rest of the drive is the proof that such a card reaches
review with a PR: `build.ts`'s `built` mode checks that the build run `factory board start` opened is
bound to the board's repository, on `factory/<session-id>`, in a worktree whose `HEAD` is that branch
([build.md](build.md)).

The card id lands in `.verify/run/card.json` for the rest of the drive; `create.json` holds the
created card, the read-back and the checks. A fresh card per drive is what keeps the drive's revision
arithmetic true on a second run against one instance.

## What it does not prove

Any trigger's mapping from a tracker item to a card — that is `verify-api`'s `linear.md`,
`github.md`, `jira.md` and `slack.md`.
