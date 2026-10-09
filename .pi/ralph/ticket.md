# Filing a pre-existing problem

A problem your diff did not cause is never fixed inline (that hides it from review) and never buried. It is
written down, then left for a human to schedule. The loop does **not** pick it up by itself, except a red main.

## Which form

- **Red gate on `origin/main`**, or a **security or data-loss defect** (a credential reaching a session, a
  path escaping the worktree, a lost write): a Linear issue, state **Todo**, priority 2. The loop works it next.
- **A real defect** (broken or flaky test, a bug in code you read, a test that can reach a real third party,
  a drifted verify skill): a Linear issue, state **Backlog**, priority 3. A human moves it to Todo if it is
  worth an iteration.
- **Polish** (wording, a comment, a naming nit, a README line): one line in `.ralph/polish.md`:
  `<date> LOB-n <path:line> <what>`. Not a ticket.

At most **3** tickets per iteration; the rest go to `polish.md` with their evidence. A problem in the loop's
own tooling (`.pi/ralph/`, `.pi/agents/ralph-*`) is filed in Backlog like any defect, never fixed by the loop.

## How

1. **Search first.** `list_issues({ project: "Factory MVP", query: "<2-3 distinctive words>" })`. If one is
   open, add `save_comment({ issueId, body })` ("ralph: seen again in LOB-n: <evidence>") and stop.
2. **Create** with `save_issue` (no `id`): `team: "Lobiklukas"`, `project: "Factory MVP"`, the state and
   priority above, `labels: ["ralph", "Bug", <track label>]`, `relatedTo: [<your issue>]`, an imperative,
   specific title, and this description:

```
**Goal.** <one sentence: the end state>

**Evidence.** <path:line, the command, the exact output; "also reproduces on origin/main@<sha>">

**Change.** <the smallest fix you believe is right, or "root cause unknown - diagnose first">

**Acceptance.**
- [ ] <observable check, with the command that proves it>
- [ ] a regression test that fails without the fix
```

3. **Blocked by it.** If it stops your own issue, set `blockedBy: [<new issue>]` on your issue and follow
   **Skip** in `work.prompt.md`. That is `NEXT`, not `BLOCKED`.

List the filed ids in your PR body and your final reply.
