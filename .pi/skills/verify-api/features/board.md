# Board tasks

**Status: passing.** Creates a task, moves it across a column, and reads it back with the same
revision, over the real Effect RPC client.

## What it is

The board is a typed task document (`factory.task`) projected into the session snapshot and
reachable over the wire through the `TasksRpc` group (`packages/domain/src/Rpc.ts`). A task is
created with a title and column, moved to another column (bumping its revision), and read back by
id — the revision round-trips unchanged.

## How a user reaches it

Any RPC client, or the dashboard/CLI board surface:

```ts
const task = await client.createTask({ title: "triage", column: "backlog" });
// → { id: "tsk_...", title: "triage", column: "backlog", revision: 0, ... }

const moved = await client.moveTask({ id: task.id, column: "in-progress" });
// → { ...task, column: "in-progress", revision: 1 }

const read = await client.getTask({ id: task.id });
// → read.revision === moved.revision === 1
```

## What proves it

- `createTask` returns a task whose `id` matches the task id kind and whose `revision` is `0`
- `moveTask` changes `column` and increments `revision` by exactly one
- `getTask` returns the same `revision` as the move result (no lost update, no stale projection)
- `listTasks` includes the created task with its current column
- a second `moveTask` to the same column is idempotent or rejected per the transition rules, never
  silently rewrites the revision

## What it does not prove

Nothing here drives the specifying/build/review pipeline or the verify-skill evidence gate — those
are separate board issues. This feature covers only the task CRUD + move + revision round-trip.
