# Filing a pre-existing problem

**Rule: a problem you did not cause is never buried.** Not in a PR note, not in a progress line, not
in a code comment, not in your head. Every pre-existing defect you find becomes a Linear issue that
the next loop iteration will pick up and fix. "Pre-existing" means: it is present on a clean
`origin/main` (or in code your diff did not change) and is not part of your issue's acceptance
criteria. That covers red gates on main, failing or flaky or skipped tests, drifted verify skills and
feature docs, lint/type warnings, bugs in code you read, tests that can reach a real third party,
missing verification for an existing surface, and unevidenced claims in docs. It also covers real
defects that a reviewer, designer or verifier reported outside your diff, and deferred review findings.

Do **not** fix it inline - that is scope creep and hides it from review - **unless** it blocks the gate
for your own issue, in which case file it as below, then follow "Blocked by it".

## 1. Search first (no duplicates)

`list_issues` in project Factory MVP with `query` set to 2-3 distinctive keywords (file name, error
text, symbol), states Backlog/Todo/In Progress/In Review. If one matches, add a
`save_comment({ issueId, body })` ("ralph: seen again in LOB-n on <date>: <new evidence>") and use
that issue as the one to reference. If it exists but is `Done`, it regressed: file a new one and
`relatedTo` the old.

## 2. Create it

`save_issue` (no `id`) with:

- `team: "Lobiklukas"`, `project: "Factory MVP"`, `state: "Todo"`
- `labels: ["ralph", "Bug", <track label(s): backend, control-plane, cli, ui, harness, infra, ...>]`
- `priority`: 2 (High) if it turns a gate red, loses data, breaks a contract or a security boundary;
  3 (Medium) for broken tests, drifted verification, real bugs; 4 (Low) for polish.
- `relatedTo: [<your issue id>]`
- `title`: imperative, specific ("Fix flaky storage conformance case 17 under concurrent open"),
  not "Investigate issues".
- `description` in Markdown, exactly:

```
**Goal.** <one sentence: the end state>

**Evidence.** <path:line, the command run, the exact output or error, and where it was found:
"found while working LOB-n on branch ralph/LOB-n; also reproduces on origin/main@<sha>">

**Change.** <the smallest fix you believe is right, or "root cause unknown - diagnose first">

**Acceptance.**
- [ ] <observable check, with the command that proves it>
- [ ] a regression test or verify check that fails without the fix
- [ ] `format:check`, `build`, `lint`, `test`, `type-check` green

**Proof.** <gate and/or .pi/skills/verify-* drive that shows it fixed>
```

An issue without checkable acceptance criteria is a note, not a ticket - write the criteria. If
you cannot reproduce it, say exactly what you saw and file it anyway with "intermittent".

## 3. Put it in the queue

Append a row to the Queue in `.ralph/plan.md` with state `ready` (the plan format is in the plan
prompt; `blocked-by -`, `base main`). Use the **front** of the queue (row 1, renumber) when it
turns a gate red for everyone or blocks your issue; otherwise place it by priority among the
`ready` rows. Never leave a ticket that is only in Linear: a worker iteration also syncs `ralph`
issues missing from the plan, but do not rely on it.

## 4. Blocked by it

If the problem prevents you from finishing **your** issue: `save_issue` your issue with
`blockedBy: [<new issue>]`, set your plan row to `skipped` ("blocked by LOB-m"), comment on your issue,
return it to its original status, and end with `<promise>NEXT</promise>`. The next iteration takes the
new ticket first. This is not an infrastructure failure and is **not** `BLOCKED`.

## 5. Volume

File each distinct root cause separately, at most **8** per iteration. If you found more, group the
remainder by root cause into one issue that lists every instance with evidence - the point is that
none is lost. Record every filed id in your PR body (when you have one), in `.ralph/progress.md`, and
in the final reply.
