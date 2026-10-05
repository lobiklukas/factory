# `factory watch`

**What it is.** Attach to any session by id and print its transcript, starting with the read-path
label: `mode: live` when the control plane answering owns the session and is streaming commits as
they land, `mode: historical` when it folded the log and the stream will end after one snapshot (D8).

**How a user reaches it.** `factory watch ses_…`. The label is the first line; the entries follow,
then `answer: …`.

**How the skill drives it.** Twice, on one session id:

1. immediately after `factory run` — the API still owns the session, so the pane must read
   `mode: live` and print the same answer;
2. after waiting out `SESSION_IDLE_TIMEOUT_MS` (the idle sweep released the owner) — the pane must
   read `mode: historical` and print the same answer.

**What proves it.** One session, two labels, the same entries: the live path is the harness's
`viewState` stream and the historical path is a reader-mode fold, so agreement between them is the
claim D8 makes. A dropped stream would print neither label nor answer.

**What it does not prove.** Cross-process fan-out (D12): a session owned by _another_ process reads
as `historical` here, because nothing can say who owns it yet (`SessionBus`, `docs/handoff.md`
task 7). Nothing in this drive runs two control planes against one database.
