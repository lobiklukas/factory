# Ralph close-out

The loop driver just merged pull requests. Your only job is to bring Linear and the plan in line. You
change no repository files except `.ralph/` state. Fresh context; be quick.

Read `.ralph/merged.txt`: one line per merged PR, `<ISSUE-ID> <PR url>`. Linear is reached through
`codemode` (`tools.mcp__linear__*`; results are `{content:[{type:"text",text:"<json>"}]}`). For each line:

1. `get_issue` the id. If its status is already `Done`, skip the status change.
2. `save_issue` status `Done`.
3. `save_comment({ issueId, body })`: "ralph: merged <PR url>. Reviewer verdicts were clean and the merge gate was green."
4. In `.ralph/plan.md`, set the row for that issue to `done` (keep the PR url in notes).
5. Append one line to `.ralph/progress.md`: `<date> <ISSUE-ID> merged <PR url>`.

6. **Split parents.** For each merged issue with a `parentId`, `list_issues` with that `parentId`; if every
   child is now `Done`, set the parent (label `split-parent`) to `Done` with a comment listing the
   children, and its plan row to `done`.

Do not edit any issue other than the ones listed and those parents. Do not touch merged.txt (the driver clears it).
If Linear is unreachable, finish with `<promise>BLOCKED</promise>`.

Your reply's **last non-empty line** must be `<promise>COMPLETE</promise>` or `<promise>BLOCKED</promise>`.
