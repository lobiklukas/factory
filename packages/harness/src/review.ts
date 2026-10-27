/**
 * The review agent (LOB-36): a read-only run that reviews one pull request at one head and posts one
 * review comment.
 *
 * D16 keeps review *in GitHub*: the factory has no review UI. What it adds is a reviewer — a review
 * run (`RunProfile.reviewing`: a session opened for one PR's head) in the card's reviewer column
 * (B4's `review`), which is the read-only reviewing stage (`REVIEWING_STAGE`), talks to its column's
 * role's model (`ROLE_MODELS`, the cheaper one), and is offered exactly one way to say anything
 * outside its log: the `review` tool, which commits the verdict and posts it on the PR. "Read-only
 * plus comment" is that pair: the stage refuses every write, and the comment is a tool whose post is
 * the control plane's. A person-started run in the same column is not a review, and is not limited.
 *
 * - **A verdict per dimension.** `correctness`, `security`, `tests` and `performance`, each declared
 *   explicitly — `findings: []` is the only way to say a dimension has none, as `gaps: []` is the
 *   only way a spec says it has none (LOB-72). A dimension is not one score folded into another.
 * - **A severity rubric** (`P0`/`P1`/`P2`, the seeded `review` skill's own words): a `P0` or `P1`
 *   finding fails its dimension, and only one does. A dimension that fails with no such finding, or
 *   passes over one, is refused, so the verdict and the findings cannot disagree.
 * - **Specific or nothing.** Every finding names a file the pull request changes (measured in the
 *   run's own worktree, `git diff --name-only base...HEAD`) and the mechanism — what goes wrong and
 *   how. A finding on a file the PR does not touch is refused before anything is committed. A review
 *   with no finding at all is the clean answer: committed, and **not posted** — a clean PR gets no
 *   comment.
 * - **One review per run.** A run reviews the head it was opened for (`factory.review`'s target,
 *   written by the control plane at create); once a call has settled — posted, clean, or stale — a
 *   second is refused. A new commit is a new run, opened by the PR's `synchronize` event, so a
 *   verdict is always about the head it names.
 * - **A stale verdict is not posted.** The post is the control plane's (`ReviewOptions.post`), and it
 *   reads the PR's head first: a head that moved since the run began answers `stale`, the verdict
 *   stays in the log marked as such, and nothing reaches the PR. The factory posts `COMMENT` reviews
 *   only, never an approval, so there is no approval on GitHub for a push to leave standing.
 *
 * The comment itself is `renderReview`'s, with a hidden marker naming the run and the head, which is
 * what the control plane's read-before-post finds on a retry.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { ConversationId, Extension, Tx } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { ReviewDoc } from "./docs";
import { changedPaths } from "./verify";

/** The tool's name, as the model calls it and as its result is found in the log. */
export const REVIEW_TOOL = "review";

/** The name the extension carrying the tool is installed under. */
export const REVIEW_EXTENSION = "factory.review";

/**
 * The roles whose column a review run joins (B4's `review` column): the trigger picks the card's
 * column whose role is here. Keyed by role, as `SPEC_ROLES` is, so a board that renames the column
 * keeps its reviews; a set so free text cannot find a prototype's key.
 */
export const REVIEW_ROLES: ReadonlySet<string> = new Set(["reviewer"]);

/** The dimensions a review gives a verdict on, in the order the comment lists them. */
export const REVIEW_DIMENSIONS = [
  "correctness",
  "security",
  "tests",
  "performance",
] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

/** The severity rubric, most severe first. */
export const SEVERITIES = ["P0", "P1", "P2"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What each severity means: the rubric the tool's description and the comment both carry. */
export const SEVERITY_RUBRIC: Readonly<Record<Severity, string>> = {
  P0: "the change is wrong: it breaks behaviour, loses data, or opens a hole — blocks the merge",
  P1: "a real problem to fix before merging: a likely regression, an unhandled case, changed behaviour no test covers",
  P2: "worth fixing, does not block: clarity, a small inefficiency, a weak test",
};

/** Whether a severity fails its dimension: `P0` and `P1` do, `P2` does not. */
export const isBlocking = (severity: Severity): boolean => severity !== "P2";

const Text = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => value.trim().length > 0)),
);

export const ReviewFinding = Schema.Struct({
  severity: Schema.Literals(SEVERITIES),
  /** A path the pull request changes, as `git diff --name-only` spells it. */
  file: Text,
  /** The line the finding is about, when it is one line. */
  line: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  /** What goes wrong and how: the mechanism, not the symptom's label. */
  mechanism: Text,
});
export interface ReviewFinding extends Schema.Schema.Type<
  typeof ReviewFinding
> {}

const DimensionVerdict = Schema.Struct({
  verdict: Schema.Literals(["pass", "fail"]),
  findings: Schema.Array(ReviewFinding),
});

export const Review = Schema.Struct({
  summary: Text,
  dimensions: Schema.Struct({
    correctness: DimensionVerdict,
    security: DimensionVerdict,
    tests: DimensionVerdict,
    performance: DimensionVerdict,
  }),
});
export interface Review extends Schema.Schema.Type<typeof Review> {}

/** The review's own verdict: it fails when any dimension does. */
export const reviewVerdict = (review: Review): "pass" | "fail" =>
  REVIEW_DIMENSIONS.some(
    (dimension) => review.dimensions[dimension].verdict === "fail",
  )
    ? "fail"
    : "pass";

/** Every finding, with the dimension it was filed under, in the comment's order. */
export const reviewFindings = (
  review: Review,
): ReadonlyArray<ReviewFinding & { readonly dimension: ReviewDimension }> =>
  REVIEW_DIMENSIONS.flatMap((dimension) =>
    review.dimensions[dimension].findings.map((finding) => ({
      ...finding,
      dimension,
    })),
  );

/** A review the validator refused, in the words the model reads. */
export class ReviewRefused extends Schema.TaggedError<ReviewRefused>()(
  "ReviewRefused",
  { message: Schema.String },
) {}

/** A Pi Durable call or the control plane's post failed: its message is what the model reads. */
class ReviewCallFailed extends Schema.TaggedError<ReviewCallFailed>()(
  "ReviewCallFailed",
  { message: Schema.String },
) {}

const refused = (message: string) =>
  new ReviewRefused({ message: `review refused: ${message}` });

/**
 * Validate an untrusted value as a review: the shape, then the rubric — a dimension fails exactly
 * when it holds a `P0` or `P1` finding.
 */
export const decodeReview = (
  input: unknown,
): Effect.Effect<Review, ReviewRefused> =>
  Effect.gen(function* () {
    const review = yield* Schema.decodeUnknownEffect(Review)(input, {
      errors: "all",
    }).pipe(Effect.mapError((error) => refused(error.message)));
    for (const dimension of REVIEW_DIMENSIONS) {
      const { verdict, findings } = review.dimensions[dimension];
      const blocking = findings.filter((finding) =>
        isBlocking(finding.severity),
      );
      if (verdict === "fail" && blocking.length === 0) {
        return yield* refused(
          `\`dimensions.${dimension}\` fails with no P0 or P1 finding — a failing dimension names the finding that fails it`,
        );
      }
      if (verdict === "pass" && blocking[0] !== undefined) {
        return yield* refused(
          `\`dimensions.${dimension}\` passes over a ${blocking[0].severity} finding — a P0 or P1 finding fails its dimension`,
        );
      }
    }
    return review;
  });

/**
 * Refuse a finding on a file the pull request does not change: a review names the code it is about,
 * and a path outside the diff is the model describing something it did not read.
 */
export const checkFindingFiles = (
  review: Review,
  changed: readonly string[],
): Effect.Effect<Review, ReviewRefused> => {
  const files = new Set(changed);
  const stray = reviewFindings(review).find(
    (finding) => !files.has(finding.file),
  );
  return stray === undefined
    ? Effect.succeed(review)
    : Effect.fail(
        refused(
          `a ${stray.dimension} finding names ${stray.file}, which this pull request does not change (it changes ${changed.length === 0 ? "nothing" : changed.join(", ")})`,
        ),
      );
};

/** The pull request and head a reviewer run is opened for, written by the control plane at create. */
export type ReviewTarget = {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  /** The ref the PR merges into; the diff is `base...HEAD`. */
  readonly base: string;
  /** The commit the run reviews, which its worktree is checked out at. */
  readonly head: string;
};

/**
 * Where a call left the PR. `clean`: no finding, nothing posted. `posted`: the comment is on the PR.
 * `stale`: the PR moved past the run's head before the post, so nothing was posted.
 */
export type ReviewOutcome =
  | { readonly _tag: "clean" }
  | { readonly _tag: "posted"; readonly url: string }
  | { readonly _tag: "stale"; readonly head: string };

/** What a post answers: the comment is there, or the PR is no longer at the reviewed head. */
export type ReviewPosted =
  | { readonly _tag: "posted"; readonly url: string }
  | { readonly _tag: "stale"; readonly head: string };

export type ReviewOptions = {
  /**
   * Post the comment on the PR, as the reviewer's own identity. `marker` is in `body` and names the
   * run and the head, so the control plane can read before it posts: a replayed call, or a retry
   * after a lost acknowledgement, finds its own comment instead of posting a second.
   *
   * A rejection is reported to the model as the tool's error; the verdict stays in the log, unposted,
   * and the run may call the tool again.
   */
  readonly post: (request: {
    readonly target: ReviewTarget;
    readonly body: string;
    readonly marker: string;
  }) => Promise<ReviewPosted>;
};

/**
 * The hidden line that identifies the factory's comment on one head of one PR. Keyed by the head, not
 * by the run: the trigger opens one run per head, and a second comment on the same head would be the
 * duplicate the read-before-post exists to prevent.
 */
export const reviewMarker = (target: ReviewTarget): string =>
  `<!-- factory-review ${target.repo}#${target.number} ${target.head} -->`;

const short = (sha: string): string => sha.slice(0, 12);

/** The comment: verdict, a table of the four dimensions, the findings, and the rubric. */
export const renderReview = (input: {
  readonly review: Review;
  readonly target: ReviewTarget;
  readonly marker: string;
}): string => {
  const { review, target } = input;
  const verdict = reviewVerdict(review);
  const findings = reviewFindings(review);
  const rows = REVIEW_DIMENSIONS.map((dimension) => {
    const { verdict: dimensionVerdict, findings: filed } =
      review.dimensions[dimension];
    const counts = SEVERITIES.flatMap((severity) => {
      const count = filed.filter(
        (finding) => finding.severity === severity,
      ).length;
      return count === 0 ? [] : [`${count} ${severity}`];
    });
    return `| ${dimension} | ${dimensionVerdict} | ${counts.length === 0 ? "none" : counts.join(", ")} |`;
  });
  const listed = SEVERITIES.flatMap((severity) =>
    findings
      .filter((finding) => finding.severity === severity)
      .map(
        (finding) =>
          `- **${finding.severity}** · ${finding.dimension} · \`${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}\` — ${finding.mechanism.trim()}`,
      ),
  );
  return [
    input.marker,
    `## Factory review: ${verdict === "fail" ? "changes needed" : "no blocking finding"}`,
    "",
    `Reviewed \`${short(target.head)}\` against \`${target.base}\`. ${review.summary.trim()}`,
    "",
    "| Dimension | Verdict | Findings |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "### Findings",
    "",
    ...listed,
    "",
    "<details><summary>Severity rubric</summary>",
    "",
    ...SEVERITIES.map(
      (severity) => `- **${severity}**: ${SEVERITY_RUBRIC[severity]}`,
    ),
    "",
    "A new commit invalidates this review; the factory reviews the new head.",
    "</details>",
  ].join("\n");
};

/** What the model is told after a call settled. */
export const describeReview = (
  review: Review,
  target: ReviewTarget,
  outcome: ReviewOutcome,
): string => {
  const head = `Review of ${target.repo}#${target.number} at ${short(target.head)} committed to this run's log: ${reviewVerdict(review)}, ${reviewFindings(review).length} finding(s).`;
  switch (outcome._tag) {
    case "clean":
      return `${head} No finding, so nothing was posted: a clean pull request gets no comment. The review is done.`;
    case "posted":
      return `${head} Posted on the pull request: ${outcome.url}. The review is done.`;
    case "stale":
      return `${head} Not posted: the pull request moved to ${short(outcome.head)} after this run began, so this verdict is stale and the new head is reviewed by its own run. The review is done.`;
  }
};

/** The target the control plane wrote, or `undefined` when this run was opened for no PR. */
const targetOf = (
  doc:
    | {
        readonly repo: string;
        readonly number: number;
        readonly url: string;
        readonly base: string;
        readonly head: string;
      }
    | undefined,
): ReviewTarget | undefined =>
  doc === undefined || doc.head === ""
    ? undefined
    : {
        repo: doc.repo,
        number: doc.number,
        url: doc.url,
        base: doc.base,
        head: doc.head,
      };

/** The four dimensions as the document stores them: plain JSON, each finding as it was filed. */
const dimensionsJson = (review: Review): JsonValue =>
  Object.fromEntries(
    REVIEW_DIMENSIONS.map((dimension) => {
      const { verdict, findings } = review.dimensions[dimension];
      return [
        dimension,
        {
          verdict,
          findings: findings.map((finding) => ({
            severity: finding.severity,
            file: finding.file,
            ...(finding.line === undefined ? {} : { line: finding.line }),
            mechanism: finding.mechanism,
          })),
        },
      ];
    }),
  );

/** Commit the verdict (and, once it is known, where it left the PR) into `factory.review`. */
const commitVerdict = (
  tx: Tx,
  conversationId: ConversationId,
  input: {
    readonly review: Review;
    readonly callId: string;
    readonly outcome: ReviewOutcome | undefined;
  },
): Promise<void> =>
  tx.doc(ReviewDoc, conversationId).then((doc) => {
    doc.callId = input.callId;
    doc.verdict = reviewVerdict(input.review);
    doc.summary = input.review.summary;
    doc.dimensions = dimensionsJson(input.review);
    const outcome = input.outcome;
    doc.outcome = outcome === undefined ? "unposted" : outcome._tag;
    doc.outcomeDetail =
      outcome === undefined || outcome._tag === "clean"
        ? ""
        : outcome._tag === "posted"
          ? outcome.url
          : outcome.head;
  });

/** Run an Effect for the tool, rejecting with the failure's own sentence. */
const run = <A>(
  effect: Effect.Effect<A, { readonly message: string }>,
): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.findErrorOption(exit.cause);
    throw new Error(
      Option.isSome(failure) ? failure.value.message : Cause.pretty(exit.cause),
    );
  });

/** The files the pull request changes, measured in the run's worktree against the target's base. */
const changedFiles = (
  env: ExecutionEnv | undefined,
  target: ReviewTarget,
  context: Context,
): Effect.Effect<readonly string[], ReviewRefused> =>
  env === undefined
    ? Effect.fail(
        refused(
          "this run has no workspace, so the files the pull request changes cannot be listed",
        ),
      )
    : changedPaths({ env, baseRef: target.base, context }).pipe(
        Effect.mapError((cause) =>
          refused(
            `the files the pull request changes could not be listed: ${cause.message}`,
          ),
        ),
      );

const finding = Type.Object({
  severity: Type.Optional(
    Type.String({ description: "P0, P1 or P2 (see the rubric)" }),
  ),
  file: Type.Optional(
    Type.String({ description: "A path this pull request changes" }),
  ),
  line: Type.Optional(
    Type.Integer({ description: "The line, when it is one" }),
  ),
  mechanism: Type.Optional(
    Type.String({
      description: "What goes wrong and how — the mechanism, specifically",
    }),
  ),
});

const dimension = (about: string) =>
  Type.Optional(
    Type.Object(
      {
        verdict: Type.Optional(
          Type.String({
            description:
              "fail when a P0 or P1 finding is filed here, else pass",
          }),
        ),
        findings: Type.Optional(
          Type.Array(finding, { description: "[] when there are none" }),
        ),
      },
      { description: about },
    ),
  );

/**
 * The `review` tool, bound to one run.
 *
 * `replay: "safe"`: a replayed call commits the same verdict again, and the post is found by its
 * marker before anything is posted twice.
 */
export const reviewTool = (options: ReviewOptions) =>
  defineTool({
    name: REVIEW_TOOL,
    description:
      "Record your review of this pull request and post it. Give a verdict for every dimension — " +
      "correctness, security, tests, performance — with its findings, `[]` when there are none. " +
      `Severity rubric: P0 — ${SEVERITY_RUBRIC.P0}; P1 — ${SEVERITY_RUBRIC.P1}; P2 — ${SEVERITY_RUBRIC.P2}. ` +
      "A dimension fails exactly when it has a P0 or P1 finding. Every finding names a file the " +
      "pull request changes and the mechanism: what goes wrong, and how. A review with no finding " +
      "posts nothing. Call it once, after reading the whole diff.",
    parameters: Type.Object({
      summary: Type.Optional(
        Type.String({
          description: "The change and your overall view, briefly",
        }),
      ),
      dimensions: Type.Optional(
        Type.Object({
          correctness: dimension("Does it do what it claims, in every case?"),
          security: dimension("Can it be abused, or leak what it should not?"),
          tests: dimension(
            "Is the changed behaviour tested, and could the tests fail?",
          ),
          performance: dimension("Does it cost more than it should?"),
        }),
      ),
    }),
    replay: "safe",
    executionMode: "sequential",
    execute: (args, api, context) => {
      /** A Pi Durable call, failing with its own words (which the model reads as the tool's error). */
      const call = <A>(operation: () => Promise<A>) =>
        Effect.tryPromise({
          try: operation,
          catch: (cause) =>
            new ReviewCallFailed({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      const commit = (review: Review, outcome: ReviewOutcome | undefined) =>
        call(() =>
          api.commit(
            (tx) =>
              commitVerdict(tx, api.conversationId, {
                review,
                callId: api.callId,
                outcome,
              }),
            context,
          ),
        );
      return run(
        Effect.gen(function* () {
          const doc = yield* call(() =>
            api.snapshot(ReviewDoc, api.conversationId, context),
          );
          const target = targetOf(doc);
          if (target === undefined) {
            return yield* refused(
              "this run was opened for no pull request, so there is nothing to review",
            );
          }
          if (
            doc !== undefined &&
            doc.callId !== "" &&
            doc.callId !== api.callId &&
            doc.outcome !== "unposted"
          ) {
            return yield* refused(
              `this run already recorded its review of ${short(target.head)} (${doc.outcome}); a new commit is reviewed by a new run`,
            );
          }
          const decoded = yield* decodeReview(args);
          const clean = reviewFindings(decoded).length === 0;
          const review = clean
            ? decoded
            : yield* checkFindingFiles(
                decoded,
                yield* changedFiles(api.env, target, context),
              );
          // The verdict is committed before anything leaves the run: the log is the truth for what
          // the reviewer found, whether or not the PR ever shows it.
          yield* commit(review, clean ? { _tag: "clean" } : undefined);
          let outcome: ReviewOutcome = { _tag: "clean" };
          if (!clean) {
            const marker = reviewMarker(target);
            outcome = yield* call(() =>
              options.post({
                target,
                marker,
                body: renderReview({ review, target, marker }),
              }),
            );
            yield* commit(review, outcome);
          }
          const details: JsonValue = {
            repo: target.repo,
            number: target.number,
            head: target.head,
            verdict: reviewVerdict(review),
            findings: reviewFindings(review).length,
            outcome: outcome._tag,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: describeReview(review, target, outcome),
              },
            ],
            details,
          };
        }),
      );
    },
  });

/** The extension installed beside `CodingTools` at `openSession`, for a reviewer run. */
export const reviewExtension = (options: ReviewOptions): Extension =>
  defineExtension({ name: REVIEW_EXTENSION, tools: [reviewTool(options)] });
