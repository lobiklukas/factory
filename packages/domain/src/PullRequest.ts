/**
 * The PR step's wire contract (LOB-213): what a client sends to open a session's PR, what it gets
 * back, and the typed failures it can branch on.
 *
 * The step itself is `@repo/core`'s (`prStep.ts`, `SessionService.openPullRequest`); these schemas
 * moved here from `packages/core/src/pr.ts` and `credentials.ts` when the step gained an RPC member,
 * because the RPC group is declared in this package and this package depends on nothing above it.
 * `@repo/core` re-exports every one of them under its old name, so the step, its tests and the
 * write-back read the same classes a client decodes — one `PrError`, not a core one and a wire one
 * that could drift.
 */
import { Schema } from "effect";
import { SessionId } from "@repo/domain/Ids";

/** A PR could not be created. Typed, so callers handle it instead of dumping stderr. */
export class PrError extends Schema.TaggedError<PrError>()("PrError", {
  operation: Schema.String,
  ref: Schema.String,
  message: Schema.String,
}) {}

/** A credential could not be resolved. Typed, so callers handle it instead of crashing. */
export class CredentialError extends Schema.TaggedError<CredentialError>()(
  "CredentialError",
  {
    repo: Schema.String,
    code: Schema.Literals(["missing", "unsupported", "failed"]),
    message: Schema.String,
  },
) {}

/**
 * Which of the PR step's two paths answered (LOB-212).
 *
 * `"opened"` is the GitHub call; `"already-open"` is the retry that read the `factory.pr` document
 * its log already held and never reached the network. The link is the same either way, which is
 * exactly why the tag has to be here: before it, a first open and a replay were indistinguishable
 * from the answer.
 *
 * `"opened"` means *this invocation made the call*, not *this invocation created the PR*: since
 * LOB-179 the call adopts the PR a killed attempt left behind when GitHub refuses the duplicate, and
 * that is still the call path. The tag separates "went to GitHub" from "the log answered", which is
 * the distinction a caller can act on; whether the PR existed before the call is the log's business.
 */
export const PullRequestOutcome = Schema.Literals(["opened", "already-open"]);
export type PullRequestOutcome = typeof PullRequestOutcome.Type;

/**
 * The PR step's answer: the link plus the path that produced it.
 *
 * A superset of `PullRequest`, not a replacement — a client that reads only `{number, url}` keeps
 * decoding this answer with `PullRequest` and is unaffected, which is why the tag lives on the
 * step's result rather than on the forge's own shape.
 */
export const OpenedPullRequest = Schema.Struct({
  number: Schema.Finite,
  url: Schema.String,
  outcome: PullRequestOutcome,
});
export type OpenedPullRequest = typeof OpenedPullRequest.Type;

/** Which of the cap's two dimensions an over-cap diff broke. */
export const DiffCapLimit = Schema.Literals(["files", "lines"]);
export type DiffCapLimit = typeof DiffCapLimit.Type;

/**
 * The answer for a diff the cap refused (LOB-227): no PR, no `factory.pr` document, and the numbers
 * that refused it — which limit, what that limit allows, and what the branch measured.
 *
 * A value rather than a `PrError`, because nothing failed: the step ran, measured, and decided. A
 * caller that retries an error would retry this one too, and the same branch would measure the same;
 * a caller that reads an outcome can instead report the cap and leave the session's PR absent.
 *
 * It carries no `number` and no `url` — there is no PR — which is why the step's answer is a union
 * of two shapes rather than one shape with absent fields: a decoded `{outcome: "over-cap", url}`
 * cannot exist, so no reader has to decide what a missing link on an over-cap answer would mean.
 */
export const OverCapPullRequest = Schema.Struct({
  outcome: Schema.Literal("over-cap"),
  limit: DiffCapLimit,
  cap: Schema.Finite,
  measured: Schema.Finite,
});
export type OverCapPullRequest = typeof OverCapPullRequest.Type;

/**
 * The answer for a branch with nothing to publish (LOB-196): no PR, no `factory.pr` document, no
 * `pr_url` row — the run measured the branch against its base and found it even.
 *
 * GitHub refuses to open a PR for a head with no commits ahead of its base, so before this the
 * ordinary result of a docs run over docs that need no edit was a typed 422 failure. It is a value
 * for the same reason an over-cap answer is: nothing failed, the step ran, measured and decided, and
 * a caller that retries an error would ask GitHub again for the same empty branch.
 *
 * Nothing is recorded about it, deliberately. A recorded answer would be sticky — the next run that
 * *does* change a file would read it and open nothing — so the transcript entry is the run's own
 * record and the next call measures the branch afresh.
 */
export const NoChangePullRequest = Schema.Struct({
  outcome: Schema.Literal("no-change"),
});
export type NoChangePullRequest = typeof NoChangePullRequest.Type;

/**
 * The answer for a branch the forge would not take (C17): the PR step pushes the session's branch
 * before it opens the PR, and the remote's `factory/<id>` holds commits this branch does not — a
 * push would have to force, and the step never forces. No PR, no `factory.pr` document, no `pr_url`
 * row, and `head` names the branch that was refused.
 *
 * A value rather than a `PrError` for the same reason a cap refusal is one: the push ran and the
 * forge answered a definite "not without the commits it has", which a retry of the same branch would
 * get again. The fix is the run's — fetch the remote branch, integrate it, push again — so a caller
 * reads an outcome it can route back to the run, not an error it would retry.
 */
export const NonFastForwardPullRequest = Schema.Struct({
  outcome: Schema.Literal("non-fast-forward"),
  head: Schema.String,
});
export type NonFastForwardPullRequest = typeof NonFastForwardPullRequest.Type;

/** What the PR step answers: the link and the path that produced it, the cap that refused it, the
 * empty branch that had nothing to open, or the branch the forge would not take without a force. */
export const PullRequestStep = Schema.Union([
  OpenedPullRequest,
  OverCapPullRequest,
  NoChangePullRequest,
  NonFastForwardPullRequest,
]);
export type PullRequestStep = typeof PullRequestStep.Type;

/**
 * The sentence for an answer that opened no PR: the diff over the cap, or the branch with nothing
 * to open. One function for every reader — the tracker write-back and the web's "Open pull request"
 * control (C7) — so the two cannot word the same answer differently.
 */
export const pullRequestRefusal = (
  step: OverCapPullRequest | NoChangePullRequest | NonFastForwardPullRequest,
): string => {
  switch (step.outcome) {
    case "over-cap":
      return `the branch changes ${step.measured} ${step.limit}, over the cap of ${step.cap}, so no pull request was opened`;
    case "no-change":
      return "the run changed no file against its base branch, so there is nothing to open a pull request for";
    case "non-fast-forward":
      return `the forge's ${step.head} has commits the run's branch does not, and the step never forces a push, so no pull request was opened`;
  }
};

/**
 * Open a session's PR (LOB-213): the session and the PR's title, and nothing else.
 *
 * Neither the repo nor the branches are here. The repo is the one the session is bound to, so a
 * client cannot open a session's PR on somebody else's repository; the head is the session's own
 * branch (`factory/<session-id>`, or the one it was created on) and the base the ref it was cut
 * from, so a client cannot publish another session's branch — or `main` — as this session's PR
 * (D10), and no client-chosen string reaches git's argv. The server reads all three from the
 * session row. An excess `head` or `base` in a payload is dropped by the decode, not honoured.
 */
export const OpenPullRequestPayload = Schema.Struct({
  sessionId: SessionId,
  title: Schema.NonEmptyString,
});
export type OpenPullRequestPayload = typeof OpenPullRequestPayload.Type;
