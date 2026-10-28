/**
 * The fixed set of the factory's own merged pull requests the reviewer is measured on (LOB-242).
 *
 * Each entry is one squash commit on `main`: the PR is `commit^..commit`. A clean entry is reviewed
 * as merged. A seeded entry gets one edit committed on top of the merge commit, so the diff the
 * reviewer reads is the real PR plus a bug the rubric would call P0 — and the entry says which file
 * the bug is in and which words a review that understood it would use.
 *
 * The commits are immutable, so the corpus does not drift; the seeds are `find`/`replace` pairs
 * against the file *at that commit*, which `bun run review-eval`'s `prepare` step refuses to apply
 * unless `find` occurs exactly once. The unit suite pins the corpus's shape (six seeded, six clean,
 * four kinds of bug) but cannot check the commits: CI clones shallow.
 */

export type ReviewEvalSeed = {
  /** The path the bug is in: the file a review has to name. */
  readonly file: string;
  /** What the file holds at the commit, exactly once. */
  readonly find: string;
  readonly replace: string;
  /** The kind of bug, for the table. */
  readonly kind:
    | "dropped element"
    | "missing await"
    | "off-by-one"
    | "inverted logic"
    | "unchecked input";
  /** The bug in a sentence: what a faux reviewer that finds it says, so it matches `mechanism`. */
  readonly bug: string;
  /**
   * Phrases a finding names the mechanism with, any one of which counts, matched case-insensitively
   * against the finding's text. A heuristic by design: the raw comment is kept beside every row for a
   * person to settle a disagreement, and a miss here is a row to read, not a verdict.
   */
  readonly mechanism: readonly string[];
};

export type ReviewEvalEntry = {
  /** A slug, unique in the corpus: names the evidence files and the repo slug. */
  readonly id: string;
  readonly pr: number;
  /** The squash commit that merged the PR, in full. */
  readonly commit: string;
  readonly title: string;
  /** Absent: the entry is reviewed as merged and is known clean. */
  readonly seed?: ReviewEvalSeed;
};

export const REVIEW_EVAL_CORPUS: readonly ReviewEvalEntry[] = [
  {
    id: "seed-usage-total",
    pr: 113,
    commit: "c601d7d40ad6bba5833b204ea567a9004c080ece",
    title: "Project both pi.usage buckets and their cost total (LOB-153)",
    seed: {
      file: "packages/harness/src/projection.ts",
      find: "[...usage.models, ...usage.tools].reduce(",
      replace: "[...usage.models].reduce(",
      kind: "dropped element",
      bug: "usageCostTotal drops the tool buckets, so a session's total cost leaves out every tool's spend",
      mechanism: [
        "usage.tools",
        "tool bucket",
        "tools bucket",
        "tool spend",
        "tool cost",
        "drops the tool",
        "omits the tool",
        "excludes the tool",
        "without the tool",
        "leaves out",
        "only the model",
        "model buckets only",
      ],
    },
  },
  {
    id: "seed-send-yield",
    pr: 150,
    commit: "8c991976eefb6d4c6ec59f56f7c4ad13de6f1964",
    title: "A retried trigger delivery sends the same prompt twice (LOB-218)",
    seed: {
      file: "packages/core/src/TriggerService.ts",
      find: "yield* sessions.send({",
      replace: "void sessions.send({",
      kind: "missing await",
      bug: "sessions.send is no longer yielded, so the effect is never run and the delivery's prompt is never sent",
      mechanism: [
        "never run",
        "never runs",
        "not run",
        "never executed",
        "not executed",
        "never sent",
        "is not sent",
        "not yielded",
        "no longer yield",
        "not awaited",
        "never awaited",
        "lazy",
        "discard",
      ],
    },
  },
  {
    id: "seed-no-change-count",
    pr: 125,
    commit: "e276aeaad60d33d06691b6578d970e33c8174e07",
    title:
      "Answer no-change instead of opening a PR for an empty branch (LOB-196)",
    seed: {
      file: "packages/core/src/prStep.ts",
      find: "measured.value.files === 0",
      replace: "measured.value.files === 1",
      kind: "off-by-one",
      bug: "the empty-branch guard is off-by-one: it tests files === 1, so a one-file branch gets no PR while an empty one reaches GitHub",
      mechanism: [
        "=== 1",
        "off-by-one",
        "off by one",
        "exactly one",
        "one file",
        "single file",
        "single-file",
        "files === 0",
        "zero files",
        "empty branch",
      ],
    },
  },
  {
    id: "seed-outcome-tag",
    pr: 103,
    commit: "5861265b84cf76c5446c22051a6a0546ad9a2cfa",
    title: "Tag the PR step's retry outcome, opened vs already-open (LOB-212)",
    seed: {
      file: "packages/core/src/prStep.ts",
      find: 'recorded === undefined ? "opened" : "already-open"',
      replace: 'recorded === undefined ? "already-open" : "opened"',
      kind: "inverted logic",
      bug: "the outcome tags are swapped, so a first open is reported as already-open and a replay as opened",
      mechanism: [
        "swap",
        "invert",
        "revers",
        "backwards",
        "flipped",
        "opposite",
        "wrong way",
        "mislabel",
      ],
    },
  },
  {
    id: "seed-reclaim-compare",
    pr: 159,
    commit: "582984511489cbd53cf0a80b43b846cc03e1be04",
    title: "Reclaim a stale trigger claim (LOB-216)",
    seed: {
      file: "packages/core/src/TriggerService.ts",
      find: "AND webhook_deliveries.claimed_at < now() - make_interval(secs => ${reclaimSeconds}))",
      replace:
        "AND webhook_deliveries.claimed_at > now() - make_interval(secs => ${reclaimSeconds}))",
      kind: "inverted logic",
      bug: "the claim age comparison is inverted, so a claim still in flight is reclaimed and a stale one never is",
      mechanism: [
        "inverted",
        "reversed",
        "wrong direction",
        "opposite",
        "> now",
        "greater than",
        "still in flight",
        "in-flight",
        "just claimed",
        "fresh claim",
        "recent claim",
        "still in progress",
      ],
    },
  },
  {
    id: "seed-board-repo",
    pr: 187,
    commit: "c86fb1fd5df17e1d9976486bdd4801999ebd1793",
    title: "A card with no repo inherits the board's repository (LOB-255)",
    seed: {
      file: "packages/core/src/TaskService.ts",
      find: "if (repo !== board.repo) {",
      replace: "if (repo !== board.repo && input.repo === undefined) {",
      kind: "unchecked input",
      bug: "the board repo mismatch check can never be true, so a card that names a different repo than its board is accepted unchecked",
      mechanism: [
        "never true",
        "never fires",
        "never fire",
        "never triggers",
        "can never",
        "always false",
        "dead",
        "unreachable",
        "bypass",
        "unchecked",
        "not checked",
        "no longer refuses",
        "never refuse",
        "never reject",
      ],
    },
  },
  {
    id: "clean-fork-pr-doc",
    pr: 153,
    commit: "908b5b9613c1345327678e45cc729f0211b7b66e",
    title:
      "A fork inherits the parent's prOpened entry but not its PR document (LOB-211)",
  },
  {
    id: "clean-lifecycle-action",
    pr: 168,
    commit: "0aded52cc1acfce932be76a337b1f99c4dc2242d",
    title: "The generic webhook can name a lifecycle action (LOB-235)",
  },
  {
    id: "clean-docs-write-rule",
    pr: 121,
    commit: "8ed2fc338f14255094d865a38936bd8d8f6fefa8",
    title: "A docs-only write rule composed with the autonomy policy (LOB-226)",
  },
  {
    id: "clean-title-entry",
    pr: 186,
    commit: "027fb586830e31ac357e30f4c336365e486e8e44",
    title: "The session title entry renders as an agent message (LOB-273)",
  },
  {
    id: "clean-dev-env",
    pr: 184,
    commit: "0a5009b042dad1217fa04a7feeaae2eaca58a0de",
    title: "bun run dev loads the repo-root .env (LOB-256)",
  },
  {
    id: "clean-sleeping-faux",
    pr: 141,
    commit: "14ef609aaa42093931abbc49814d5659c4dae548",
    title: "Sleeping faux script and CLI assertions for steer/busy (LOB-167)",
  },
];

export const isSeeded = (
  entry: ReviewEvalEntry,
): entry is ReviewEvalEntry & { readonly seed: ReviewEvalSeed } =>
  entry.seed !== undefined;
