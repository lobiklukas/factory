# Cost prediction on the dashboard

**What it is.** LOB-38 puts cost prediction in two places on the dashboard:

- **The New session form** shows what the next session would cost before it exists: `predictCost`'s
  range for the form's prompt on the picked model, its median, how many sessions it came from and
  how they were chosen. With too little history it says "No estimate yet" and why.
  **Cap at predicted high** creates the session with `budget` set to the range's high. The choice is
  disabled while there is no range; changing the model unticks it, and if it is ticked with no range
  to cap at, **New session** is disabled with a line saying why (`capBlocked`), so a cap asked for is
  never silently dropped. The range re-reads every 30 s, so a run that finishes reaches it.
- **`/spend`** publishes the backtest under its header (re-read every minute, summary only): the median error over the sessions scored,
  the median absolute error, how often the range held the actual, and — below twenty scored sessions
  — that the number is too few to mean much.

**How a user reaches it.** `/sessions`: read the line under **Model**, tick the cap if wanted, then
press **New session**. `/spend`: the **Cost prediction** strip.

**How the skill drives it.** `./cost.sh` owns its API (`COST_API_PORT`, default `:9452`; a priced
faux, `FAUX_COST=0.01`), its dashboard (`COST_WEB_PORT`, default `:3452`), and a throwaway database
it mints on `DATABASE_URL`'s server and drops on exit. `cost.mjs`:

1. Reads the empty form.
2. Runs three sessions on the form's prompt over the RPC (2, 3 and 4 cents) and reloads.
3. Ticks the cap and presses **New session**.
4. Opens `/spend`.

**What proves it.** The oracle is the RPC, read from the drive's own process, never the page:

- The empty form says `No estimate yet: 0 sessions completed, 3 comparable needed`, and the cap is
  disabled.
- After the runs it says `Predicted $0.0220 to $0.0380 (median $0.0300, 3 sessions,
repo+model+shape)`, and its `data-cost-high` is `predictCost`'s high.
- The capped session's `getSession().budget.cap` is that high.
- `/spend`'s strip carries `backtestCost`'s scored count and median error (`Median error 50.0% over
1 session`) and the too-few caveat.
- No console error.

Evidence: `cost-empty.png`, `cost-predicted.png`, `cost-capped.png`, `cost-spend.png`,
`observed.json` under `.verify/evidence/latest/cost/`.

**What it does not prove.** The prediction's quality on real models (see verify-api's
[cost.md](../../verify-api/features/cost.md)), and a card run's prediction: the card pane's **Start
run** shows none yet. The wording rules are unit cases in `apps/web/src/lib/cost-view.test.ts`.
