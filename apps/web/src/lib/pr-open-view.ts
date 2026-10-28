import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
  pullRequestRefusal,
  type PullRequestStep,
} from "@repo/domain/PullRequest";
import type { SessionStatus } from "@repo/domain/Session";

/**
 * The "Open pull request" control's decisions (C7), computed here rather than in the panes so a case
 * a screenshot cannot settle — which answers are a refusal, which refusals stick, when the control
 * is offered at all — is a unit test, and so the session pane's header and the card pane's run row
 * cannot say different things about the same session.
 *
 * The step itself is the server's (`openPullRequest`, LOB-213). It chooses the repo, the head and
 * the base from the session, so nothing here decides *which* PR: the control names the session and
 * a title, as `factory pr` does.
 */

/**
 * What the last press of the control came to.
 *
 * `refused` is a determinate answer — the same branch, the same credential and the same cap would be
 * refused the same way — so the control stays disabled and says why. `failed` is not: a forge that
 * answered 502, or a connection that dropped, may well succeed the next time, so the control stays
 * available and says what happened.
 */
export type PrAttempt =
  | { readonly _tag: "none" }
  | { readonly _tag: "opening" }
  | { readonly _tag: "opened"; readonly url: string }
  | { readonly _tag: "refused"; readonly reason: string }
  | { readonly _tag: "failed"; readonly reason: string };

/** What an outcome-shaped step answer comes to: the link, or the reason there is none. */
export const attemptOfStep = (step: PullRequestStep): PrAttempt => {
  switch (step.outcome) {
    case "opened":
    case "already-open":
      return { _tag: "opened", url: step.url };
    // The same words the tracker write-back posts: one function in the domain, not a copy.
    case "over-cap":
    case "no-change":
      return { _tag: "refused", reason: pullRequestRefusal(step) };
  }
};

/**
 * Whether a typed failure is the server's determinate word about this session — one the same call
 * would meet again — judged by its code rather than its tag. A missing or unsupported credential, an
 * unbound repo or an unsafe branch name are decisions. Everything else that arrives typed is a
 * condition that passes: `at_capacity` (a session is released and there is room), `owned_elsewhere`
 * (the lease lapses), `busy`, `storage`, `harness`, `repo_clone_failed`, a credential mint that
 * `failed` on the network, and a `PrError` from the forge. Those stay pressable and offer a retry; a
 * button disabled beside a message that says "retry" would be a dead end.
 */
const isDeterminate = (error: {
  readonly _tag: string;
  readonly code?: unknown;
}): boolean => {
  switch (error._tag) {
    case "CredentialError":
      return error.code === "missing" || error.code === "unsupported";
    case "SessionError":
      return error.code === "invalid_input" || error.code === "not_found";
    default:
      return false;
  }
};

/**
 * The attempt a failed `openPullRequest` call comes to.
 *
 * A typed failure's `message` is shown verbatim — the server's words, which name the repo or the
 * limit — and only an untyped one (a transport failure, a defect) falls back to the cause's text.
 */
export const attemptOfCause = (cause: Cause.Cause<unknown>): PrAttempt => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause)) as
    | {
        readonly _tag?: unknown;
        readonly code?: unknown;
        readonly message?: unknown;
      }
    | undefined;
  return typeof error?._tag === "string" &&
    typeof error.message === "string" &&
    error.message.length > 0
    ? {
        _tag: isDeterminate({ _tag: error._tag, code: error.code })
          ? "refused"
          : "failed",
        reason: error.message,
      }
    : { _tag: "failed", reason: Cause.pretty(cause) };
};

/** The attempt a settled `openPullRequest` call comes to, as an atom's `AsyncResult` holds it. */
export const attemptOfResult = (
  result: AsyncResult.AsyncResult<PullRequestStep, unknown>,
): PrAttempt => {
  if (AsyncResult.isWaiting(result)) return { _tag: "opening" };
  if (AsyncResult.isSuccess(result)) return attemptOfStep(result.value);
  if (AsyncResult.isFailure(result)) return attemptOfCause(result.cause);
  return { _tag: "none" };
};

/** The link a press produced, if it produced one. */
export const openedUrl = (attempt: PrAttempt): string | undefined =>
  attempt._tag === "opened" ? attempt.url : undefined;

/** What a pane renders for the control. */
export type PrOffer =
  | { readonly _tag: "hidden" }
  | { readonly _tag: "available"; readonly retry?: string }
  | { readonly _tag: "opening" }
  | { readonly _tag: "blocked"; readonly reason: string };

/**
 * Whether the control is offered, and in what state.
 *
 * It is offered for a session bound to a repo that is idle and has no PR — `factory.pr` recorded
 * (`prUrl`) or just opened here. A scratch session has no branch to publish; a busy one is still
 * changing it, and a PR opened mid-run would publish a half-made branch. The server refuses the
 * first outright and would measure whatever the branch held at the second, so hiding the control is
 * about not offering a press that is never the right one, not the only guard.
 *
 * A refusal outranks the idle/busy rule on purpose: it is shown for as long as the session sits
 * idle, and `staleRefusal` is what drops it once the run moves the branch on.
 */
export const prOffer = (
  session: {
    readonly repo: string | undefined;
    readonly status: SessionStatus;
    readonly prUrl: string | undefined;
  },
  attempt: PrAttempt,
): PrOffer => {
  if (session.repo === undefined) return { _tag: "hidden" };
  if (session.prUrl !== undefined && session.prUrl !== "")
    return { _tag: "hidden" };
  if (attempt._tag === "opened") return { _tag: "hidden" };
  if (attempt._tag === "opening") return { _tag: "opening" };
  if (session.status !== "idle") return { _tag: "hidden" };
  if (attempt._tag === "refused")
    return { _tag: "blocked", reason: attempt.reason };
  if (attempt._tag === "failed")
    return { _tag: "available", retry: attempt.reason };
  return { _tag: "available" };
};

/**
 * Whether a remembered refusal no longer describes the session. A refusal is the verdict on the
 * branch as it stood when the press was made; a run that has started since may have committed a
 * change (or removed one), so the verdict is dropped and the control is offered again when the
 * session is idle.
 *
 * "Started since" is a *transition* this pane saw — from a status that was not busy to busy — and
 * not merely a busy status. The card row's status is a polled index that keeps its last answer
 * while it refreshes, so a leftover "busy" from before the press would otherwise wipe a refusal the
 * header (which reads the live stream) had only just received.
 */
export const staleRefusal = (
  attempt: PrAttempt,
  previous: SessionStatus | undefined,
  status: SessionStatus | undefined,
): boolean =>
  (attempt._tag === "refused" || attempt._tag === "failed") &&
  previous !== undefined &&
  previous !== "busy" &&
  status === "busy";

/**
 * The title the PR is opened with: the session's own, as `factory pr` does by default. A session
 * with no title falls back to its id rather than a refusal the person cannot act on from a button.
 */
export const prTitleFor = (title: string | undefined, id: string): string =>
  title === undefined || title.trim().length === 0 ? id : title;
