# Cost prediction before a run: a range, a cap on request, and a published backtest

**Status: passing.** Before a session exists, the factory predicts what it will cost as a range drawn
from the completed sessions most like it. It caps the session at the range's high when asked, and it
publishes how wrong the prediction has been on its own history (LOB-38). The rules and the metric
are in `docs/cost-prediction.md`.

## What it is

- `predictCost({ prompt, repo?, model? })` (`@repo/domain/Cost`) answers `{ shape, model, basis,
comparables, history, range? }`. The predictor is pure (`packages/core/src/costPrediction.ts`):
  - it classifies the prompt's first line into a task shape
  - it takes the first comparable tier with at least three completed sessions (repo+model+shape,
    repo+model, model+shape, model, shape, all), using the newest fifty of them
  - it answers their p10 / median / p90
  - a model absent from the input is the deployment's; one the process does not serve is
    `invalid_input`, as `createSession` refuses it
- `backtestCost({ repo? })` walks the completed sessions forward. Each one is predicted from only the
  sessions created strictly before it, then scored on `|median − actual| / actual`. It reports:
  - the median of that (the headline)
  - the median absolute error
  - the range's coverage
  - `meaningful` (at least 20 scored sessions)
- "Completed" is the index's idle, priced rows with no run or mission in flight. Both reads are one
  query over the session index, never a fold (R6).
- `factory run` prints the prediction before it creates the session. `--cap-at-prediction` sets
  `budget` to the high, and is refused before anything is created when there is no range or when
  `--budget` is also given. `factory cost predict` and `factory cost backtest [--rows]` print the
  same answers.

## How the skill drives it

`./cost.sh` owns everything it uses:

- its own API (`COST_PORT`, else `API_PORT`, else `:9432`), running a priced faux (`FAUX_COST=0.01`)
- a throwaway database it mints on `DATABASE_URL`'s server and drops on exit, so every number is
  drawn from exactly the sessions it ran

The drive, in order:

1. On the empty database, `factory run --cap-at-prediction` is refused (and so is `--budget` with
   it), creating no session.
2. `cost.ts` checks `predictCost` and `backtestCost` empty, then runs six priced sessions on two
   repos (2, 2, 3, 4, 2 and 5 cents). It checks a fix's range (0.02 / 0.025 / 0.037 from the four
   fixes), a feature's fallback to repo+model, the typed refusal of an unserved model, and the
   repo's and the whole history's backtests, every number worked out by hand.
3. The terminal half checks `factory cost predict`'s and `factory cost backtest`'s lines, and that
   `factory run --cap-at-prediction` prints the prediction first and `budget $0.0370 (the predicted
high)`.
4. `cost.ts MODE=cap` reads that session's `budget.cap` (0.037) and its answer back over RPC.

## What proves it

Every check in `cost-process.json`, `cost.json` and `cost-capped.json`, plus the CLI's own output in
`cost-cli-*.txt`, under `.verify/evidence/latest/api/`. The arithmetic's edge cases are unit cases:

- `packages/core/src/costPrediction.test.ts`: tiers, window, quantiles, strictly-before, minimum sample
- `packages/core/src/costPrediction.service.test.ts`: which index rows count as history
- the CLI's and the dashboard's wording: `apps/cli/src/commands/cost.test.ts` and
  `apps/web/src/lib/cost-view.test.ts`

The dashboard half is verify-web's `cost.sh` ([cost.md](../../verify-web/features/cost.md)).

## What it does not prove

How good the prediction is on real models. The faux provider prices every request alike, so its
backtest proves the arithmetic, not the predictor. The real number is the owner's to record from a
deployment with real sessions (`docs/cost-prediction.md`, "Published backtests").
