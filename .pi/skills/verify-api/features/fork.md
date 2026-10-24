# Fork a session

**Status: passing.** `forkSession` returns a session whose transcript is the parent's prefix; a
message sent to either one lands in that session's log only.

## What it is

"Try a different approach" and "undo that turn", as one action (LOB-24, LOB-180). A session **is**
one Pi Durable log (D7), so a fork is a second log with the parent's entries copied into it, in one
commit, before anyone can read it. `SessionSummary.forkedFrom` on the fork names the parent, and the
fork's own log carries a `factory.fork` document with the same parent and the entry the fork was
taken at, so `rebuildIndexes` recovers the lineage from the log rather than from the index row.

Pi Durable has a `Conversation.fork`, and it forks a conversation _inside_ one storage. Using it
would put the fork in the parent's log, which would make the fork unreadable as a session of its
own: `SessionId` is the `log_id`, so two sessions cannot share a log. The copy is the same idea one
level up.

The fork works where its parent worked — the same repo and base ref, its own worktree — and it
carries the parent's `factory.session` binding in its own log so a rebuild keeps that. The entries,
the binding and the lineage land in **one commit** on the fork's log, so a fork never exists without
the documents `rebuildIndexes` folds.

What a fork does **not** copy: the task binding (`factory.task`), the spec and criteria documents,
and `pi.usage`. A fork of a task-bound session therefore starts unbound, with no spend history —
neither is transcript, and neither is in this issue's scope.

## How a user reaches it

The `forkSession` RPC, from the CLI or the dashboard (the dashboard affordance lands with LOB-182).

## How the skill drives it

`drive.ts` forks the session it has just driven, after that session has been released and folded:

1. `forkSession({ sessionId })` with no `at`, which means "the parent's last entry"
2. `getSession` on both: the fork's entries are the parent's, text for text
3. `forkSession({ sessionId: parent, at: <the fork's newest entry id> })` — a typed
   `SessionError{code: "invalid_input"}`, because that entry is not the parent's history. Entry ids
   are per-log numbers, so an id that happens to exist in both logs _is_ the parent's entry; what a
   foreign id can be is absent, and the drive uses one that is
4. `sendMessage` to the fork, wait for its run to settle, then `getSession` on both again: the fork
   kept its prefix and grew, and the parent's entries are unchanged and carry no trace of the fork's
   message

## What proves it

- the fork's id differs from the parent's, and its summary carries `forkedFrom: <parent id>`
- the fork's transcript equals the parent's, entry for entry, before either is written to again
- the fork's answer appears in the fork and nowhere in the parent, and the parent's transcript is
  byte-identical to the fold taken before the fork
- the refusal is typed over the wire, not a crash or a silently rounded fork point

## What it does not prove

- **Lineage in the list.** `SessionListEntry` does not carry `forkedFrom` yet; LOB-182 adds it with
  the dashboard affordance.
- **A task, spec or spend carried across a fork.** Deliberately not copied (see above).
- **A fork of a session mid-run.** Every fork here is of a settled or released session; forking a
  session whose run is in flight copies the entries committed so far, and nothing in the drive
  depends on that boundary.
