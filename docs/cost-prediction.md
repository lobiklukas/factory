# Cost prediction before a run

LOB-38. Before a session exists, the factory says what it is likely to cost, as a range drawn from
the completed sessions most like it. It caps the session at the range's high when asked. And it
publishes how wrong the prediction has been on its own history, on the assumption that a number
everybody can see is the one that gets better.

## The history

The session index, read in one query and never a fold (R6). Each row gives:

- the title (the first prompt's first line, at most 80 characters)
- the repo, absent for a scratch session
- the model it was pinned to
- `created_at`
- `session_activity.last_activity_at`, after which its cost no longer moved
- `session_activity.cost_total`, the same cost the session list and `/spend` show

A **completed** session is one with all of the following:

- it is idle
- it has no run or mission in flight (`run_session_root IS NULL`, `NOT mission_in_flight`)
- it is priced: a session that spent nothing says nothing about price

At most the newest 2000 are read.

_Files touched_ is not a feature. The projection drops tool input, and a run's files are unknown
before it runs, so it could never be known at create time.

## The prediction

`packages/core/src/costPrediction.ts`, pure.

1. **Shape.** The prompt's title line is classified by keyword into `review`, `docs`, `fix`, `test`,
   `refactor`, `feature` or `other`. Whole words only; the first class that matches, in that order,
   wins. A history row is classified from its title by the same function.
2. **Comparables.** Take the first of these tiers that holds at least **3** completed sessions:
   - repo+model+shape
   - repo+model
   - model+shape
   - model
   - shape
   - all

   Use its newest **50**. A scratch session's repo is "none", which other scratch sessions share; a
   row with no recorded model matches no tier that asks for one. A request that names no model is
   predicted on the deployment's.

3. **Range.** The comparables' 10th percentile, median and 90th percentile, linearly interpolated.
   The answer also gives the tier (`basis`), how many sessions the range came from (`comparables`)
   and how many completed sessions there were to choose from (`history`). With fewer than three,
   there is no range and the answer says so.

**Cap on request.** `factory run --cap-at-prediction` and the dashboard's **Cap at predicted high**
create the session with `budget` set to the range's high, the p90. That is an ordinary LOB-163 cap
(docs/design.md R4), so about one comparable run in ten would have been stopped by it. With no range
the CLI refuses before anything is created. The dashboard disables the choice, and if it was ticked
for a range that is gone (a model change resets it; a refresh could drop it), **New session** waits
and says so rather than start the session uncapped.

## The backtest

`backtestCost` walks every completed session forward in creation order. Each session is predicted
from only the sessions that had **finished strictly before it was created**: their last activity
(`last_activity_at`) is earlier than its `created_at`. That rule is what keeps the walk honest. A
session's `cost_total` is read as it is now, and a session still working when the scored one was
created had not spent all of that yet; a session that had finished had, because nothing moved its
cost after its last activity. Two sessions created at the same instant never predict each other. A
session with too little before it is skipped. Each scored session gets `|median − actual| / actual`.

It is close to, not exactly, what `predictCost` would have answered that day. The difference runs
one way: a session that had finished then but was resumed later has a later last activity, so the
backtest leaves it out where `predictCost` would have used it at the cost it had then. The backtest
draws on slightly less history than the live predictor had, never on spend nobody had seen.

`--repo` scores only that repo's sessions, but each one is still predicted from the whole history,
as `predictCost` predicts it: the fallback tiers (model+shape, model, shape, all) draw on every repo.
A repo's number is therefore the error of the predictor that repo's runs actually get.

The report:

| Field                 | Meaning                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `medianRelativeError` | **The headline.** The median of `\|median − actual\| / actual`.           |
| `medianAbsoluteError` | The median of `\|median − actual\|`, in US dollars.                       |
| `coverage`            | The share of scored sessions whose actual cost fell inside p10–p90.       |
| `scored` / `skipped`  | Sessions with a prediction to score / without one.                        |
| `meaningful`          | `scored >= 20`. Below it the number is shown with "too few to mean much". |

There is no pass/fail threshold on the error: the goal is to publish it, not to gate on it. The gate
proves the arithmetic over priced faux sessions with known costs (`costPrediction.test.ts`,
`costPrediction.service.test.ts`, and `.pi/skills/verify-api/cost.sh`).

## Where it is published

- **The dashboard's `/spend`**, in the **Cost prediction** strip under the header: against every
  completed session that deployment has, re-read every minute (not with the spend's 5 s poll: the
  walk is quadratic in the history) and the summary only — the scored rows travel only when asked
  for (`backtestCost({ rows: true })`).
- **`factory cost backtest`** (add `--rows` for every scored session, `--repo` for one repo).

## Published backtests

The faux provider prices every request alike, so no backtest it produces says anything about the
predictor. A real number needs a deployment whose sessions ran on a real model. Record each one here,
newest first:

```sh
factory cost backtest --api <the deployment's URL>
```

| Date | Deployment | Completed | Scored | Median error | Median abs. error | Coverage | Notes                                         |
| ---- | ---------- | --------- | ------ | ------------ | ----------------- | -------- | --------------------------------------------- |
|      |            |           |        |              |                   |          | First real number pending (LOB-38 follow-up). |
