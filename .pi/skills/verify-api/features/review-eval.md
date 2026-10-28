# Reviewer measurement: is the reviewer worth trusting on our own PRs

**Status: the faux proof passes; the live measurement is the owner's to run.** An opt-in script
(`bun run review-eval`, never part of the gate) runs the reviewer on twelve of the factory's own
merged pull requests — six with a bug seeded on top, six as merged — and writes a table of what it
found (LOB-242). LOB-36's acceptance ends with "measured on our own PRs before it is trusted"; the
gate can prove the reviewer's structure with the faux provider and cannot prove that a real model
finds a real bug and stays quiet on a clean change.

## What it is

- **The corpus** (`packages/harness/src/reviewEvalCorpus.ts`). Twelve squash commits on `main`, each
  one a PR (`commit^..commit`). Six are seeded: a `find`/`replace` against one file at that commit,
  committed on top of the merge, so the diff is the real PR plus one bug — a dropped element
  (`usageCostTotal` loses the tool buckets), a missing `await` (`yield*` becomes `void`), an off-by-one
  (`files === 0` becomes `=== 1`), two inverted conditions (the outcome tags swapped, a claim-age
  comparison reversed) and an unchecked input (the board-repo mismatch guard that can never fire).
  Six are clean, the PRs as merged. Each seed names the file a review has to name and the phrases a
  review that understood the bug would use.
- **The scoring** (`packages/harness/src/reviewEval.ts`, under test in the gate). It reads the comment
  the forge was handed back into findings (`parseReviewComment`) and scores each run: _reviewed_ (the
  `review` call was accepted), _posted_ (a review with no finding posts nothing), _detected_ (the posted
  review fails: a P0 or P1), _named the file_, _named the mechanism_ (a finding on that file, in the
  corpus's phrases; each column implies the one before it), _false positive_ (a clean PR whose review
  fails — a P2 nit is not one), other blocking findings, and cost from the session's own `pi.usage`
  ledger. The mechanism match is a heuristic by design: `comments/<id>.md` keeps the posted comment of
  every PR for a person to settle a disagreement.
- **The threshold** (`REVIEW_EVAL_THRESHOLD`): every run gives a verdict (100%), at least 80% of seeded
  bugs detected and 80% with the file named, 60% with the mechanism named, at most 20% of clean PRs
  falsely failed — over at least five of each kind. On six and six: 5, 5, 4 and at most 1. The reasons
  are in the constant's comment: a missed bug reaches a human who would have read the diff anyway, a
  false alarm teaches everyone to ignore the reviewer, so the false-positive line is the one that makes
  the gate worthless if it slips.
- **The run** (`review-eval.sh`, `review-eval.ts`). It clones this repository, builds the corpus's heads
  in the clone (a seed whose `find` is not in the file exactly once, or a commit a shallow clone lacks,
  stops it), boots the API and, for each PR, delivers a signed `pull_request` to `POST
/webhooks/github` exactly as `review.sh` does. The reviewer runs on its `ROLE_MODELS` model and
  posts to a loopback `Bun.serve` forge: `GITHUB_API_URL` is the only GitHub the API is told about and
  both tokens are fixed fakes, so nothing is ever written to github.com, and every forge request's
  token is recorded and checked.

## How the skill drives it

```
REVIEW_EVAL=faux DATABASE_URL=… API_PORT=9570 ./review-eval.sh      # the proof
REVIEW_EVAL=live DATABASE_URL=… API_PORT=9570 \
  ROLE_MODELS=reviewer=anthropic/<model> ./review-eval.sh            # the measurement
bun run review-eval                                                   # the same, from the root
```

Unset `REVIEW_EVAL`, it prints its usage and stops. `faux` boots the API once per PR (the faux script
is one per boot) with a scripted reviewer: right on three seeded PRs, a miss on one, the right file for
the wrong reason on one, a failing review of a different file on one, quiet on four clean PRs, a P2
nit on one and a false alarm on one. `live` forces `MODEL_BACKEND=anthropic` (a missing credential
fails the boot, it does not fall back to the faux), boots once and runs the twelve in order; it needs
the API's usual credential in its environment and spends money, a few dollars at most on a mid-size
model. The script reads no credential and no `.env` file.

## End state that proves it

The faux proof's 40 checks (`review-eval.log`; the 16 of `report` are in `review-eval-proof.json`). Per run, two:
every forge call carried the reviewer's own token and at most one review was posted. Then, over all twelve: each of the twelve table rows
equals what the faux reviewer's scripted answer scores, computed through the real rubric, comment
rendering and reading; every run was reviewed on `faux/faux-review` with a cost; every forge call, of
every run, carried the reviewer's own token; the table's totals are five detected, four named a file,
three a mechanism and one false alarm, and the threshold is not met (so the table is shown to tell a
miss, a wrong file and a false alarm from a pass); and at least five seeded and five clean PRs ran.
`review-eval.md` is the table, `review-eval.json` the same with the summary.

## What it does not prove

That any real model is good at this: that is the live run, and its result and the threshold decision
are recorded on LOB-242. Nor that the corpus is representative: twelve PRs, one author, six bug
shapes; a result is evidence about those, and the corpus is a list a person can extend. Nor the seeds'
subtlety against a model that has seen this repository: the merged PRs are public in its history.
