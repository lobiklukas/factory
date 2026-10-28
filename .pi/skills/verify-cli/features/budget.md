# `factory budget`

**What it is.** The command that sets a session's spend cap (C23). It calls `setSessionBudget`: the
server commits the new ceiling on the session's `factory.budget` document and clears the stop the old
cap recorded, so a session the cap stopped runs again on its next message. The stop's `[budget]`
transcript line stays, as history. `factory board start --budget <usd>` is the other half: it caps a
card's run when it opens ([../../verify-board/features/start.md](../../verify-board/features/start.md)).

**How a user reaches it.** `factory budget ses_… --cap 2.50` prints
`capped ses_…: $2.5000 cap, $0.0100 spent` and the server's sentence for it (a cap the spend already
reaches says so: the next run stops before its first request), and exits 0. A cap that is not a positive
amount of US dollars is refused by the flag, and an unknown id is `error: not_found: …` with exit 1.

**How the skill drives it.** `.pi/skills/verify-api/budget.sh` runs it on the session its driver
stopped and then raised (`budget-cli-set.txt`); `.pi/skills/verify-board/budget.sh` runs it on a card's
run beside the dashboard's **Raise cap**, and on an unknown id.

**What proves it.** The `capped …` line with the new cap and the spend, exit 0, and `getSession`'s
`budget.cap` equal to it with no `budget.stopped`; the unknown id is `error: not_found` with a non-zero
exit. The unit case is `apps/cli/src/commands/budget.test.ts`.
