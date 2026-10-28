/**
 * Where a session's PR step reports what it did, for a tracker to mirror (LOB-15).
 *
 * The trigger seam's `TriggerWriteBack` runs once, when a delivery opens a session. Everything the
 * tracker should learn after that — the PR link, the refusal that opened none, the error that
 * stopped the step — happens later, in `SessionService.openPullRequest`, so the port lives there:
 * the step reports its own exit, and a deployment that configured no tracker reports to nobody.
 *
 * **Optional, and a `Context.Reference` because of it.** The default is a no-op, as
 * `NoWriteBack` is the trigger seam's: a session layer built without a tracker (every test, every
 * drive, a deployment with no Linear key) must not have to wire one, and the PR step must not fail
 * because a mirror is absent. A deployment that has one provides it to `SessionServiceLive`.
 *
 * **It cannot fail the step.** The PR is the product; the tracker is a mirror of it (board.md
 * B11: outbound, idempotent). So the port answers `void` with no error: an implementation retries
 * what it can and logs what it could not, and every write it makes is idempotent, so the next
 * report — the caller's retry of the step answers `already-open` and reports again — converges the
 * mirror instead of the step having to. The session layer does not take that on trust: it bounds
 * the report (`SESSION_WRITE_BACK_BUDGET`) and logs any failure or defect it raises, so an
 * implementation that breaks the contract still cannot fail or stall the step.
 *
 * `pullRequestReport` is the one reading of a step's exit, so every tracker agrees on which exits
 * are a PR, which are a failed run, and which are an interrupt that says nothing about the run.
 */
import { Cause, Context, Duration, Effect, Exit, Layer, Option } from "effect";
import { pullRequestRefusal } from "@repo/domain/PullRequest";
import type { SessionError, SessionId } from "@repo/domain/Session";
import type { VerifyRecord } from "@repo/harness";
import type { CredentialError } from "./credentials";
import type { PrError, PullRequestStep } from "./pr";

/** The PR step's exit, as `openPullRequest` produced it. */
export type PullRequestStepExit = Exit.Exit<
  PullRequestStep,
  SessionError | PrError | CredentialError
>;

export type SessionWriteBackShape = {
  /**
   * The session's PR step finished, one way or another. `evidence` is lazy: reading the session's
   * `verify` records folds its log, and only a tracker that posts them should pay for that.
   */
  readonly pullRequest: (input: {
    readonly sessionId: SessionId;
    readonly result: PullRequestStepExit;
    readonly evidence: Effect.Effect<readonly VerifyRecord[]>;
  }) => Effect.Effect<void>;
};

/**
 * How long the PR step waits for its report before it answers anyway. The caller of the step is
 * waiting on an RPC; a tracker that answers slowly, request after request and retry after retry,
 * must not turn that wait into tens of seconds. Generous enough for one report's few requests to a
 * healthy tracker; a report cut short is completed by the next, because every write is idempotent.
 */
export const SESSION_WRITE_BACK_BUDGET: Duration.Input = "10 seconds";

export const SessionWriteBack = Context.Reference<SessionWriteBackShape>(
  "@repo/core/SessionWriteBack",
  { defaultValue: () => ({ pullRequest: () => Effect.void }) },
);

/**
 * Several trackers' write-backs as one: each report goes to every layer's `SessionWriteBack`, in
 * parallel, so a deployment with Linear and Slack configured mirrors the PR step on both
 * (LOB-259). A `Context.Reference` holds one value, so two layers provided side by side would
 * leave the last one standing; this is what makes them add up.
 *
 * Each layer is built here and read back as the reference's value, which is why every one of them
 * has the `never` output `LinearSessionWriteBack` has. Each implementation already cannot fail or
 * stall the step (the contract above), so one that is slow delays the others only up to
 * `SESSION_WRITE_BACK_BUDGET`, the bound the session layer puts on the whole report.
 */
export const SessionWriteBacksAll = <E, R>(
  layers: ReadonlyArray<Layer.Layer<never, E, R>>,
): Layer.Layer<never, E, R> =>
  Layer.effect(
    SessionWriteBack,
    Effect.gen(function* () {
      const shapes: SessionWriteBackShape[] = [];
      for (const layer of layers) {
        const context = yield* Layer.build(layer);
        shapes.push(Context.get(context, SessionWriteBack));
      }
      return {
        pullRequest: (input) =>
          Effect.forEach(shapes, (shape) => shape.pullRequest(input), {
            concurrency: "unbounded",
            discard: true,
          }),
      };
    }),
  );

/** What a step's exit means to a tracker. */
export type PullRequestReport =
  | {
      readonly _tag: "opened";
      readonly pr: { readonly number: number; readonly url: string };
    }
  | {
      readonly _tag: "failed";
      /** Which way the step failed; a tracker dedupes its explanation by it. */
      readonly step:
        | "over-cap"
        | "no-change"
        | "non-fast-forward"
        | "secret-found"
        | "pr-error";
      /** One sentence a person reading the issue can act on. */
      readonly reason: string;
    }
  | { readonly _tag: "interrupted" };

/**
 * One reading of the PR step's exit.
 *
 * `opened` and `already-open` are both a PR: a retry that the log answered is the same PR, and a
 * mirror that missed the first report has to learn it from the second. The two refusals are failed
 * runs — the run ended and there is no PR — and so is a typed error or a defect. An interrupt is
 * none of these: the caller stopped asking, which says nothing about the run, so it is not reported.
 */
export const pullRequestReport = (
  result: PullRequestStepExit,
): PullRequestReport => {
  if (Exit.isSuccess(result)) {
    const step = result.value;
    switch (step.outcome) {
      case "opened":
      case "already-open":
        return {
          _tag: "opened",
          pr: { number: step.number, url: step.url },
        };
      case "over-cap":
        return {
          _tag: "failed",
          step: "over-cap",
          reason: pullRequestRefusal(step),
        };
      case "no-change":
        return {
          _tag: "failed",
          step: "no-change",
          reason: pullRequestRefusal(step),
        };
      case "non-fast-forward":
        return {
          _tag: "failed",
          step: "non-fast-forward",
          reason: pullRequestRefusal(step),
        };
      case "secret-found":
        return {
          _tag: "failed",
          step: "secret-found",
          reason: pullRequestRefusal(step),
        };
    }
  }
  const cause = result.cause;
  if (Cause.hasInterruptsOnly(cause)) return { _tag: "interrupted" };
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error)) {
    return {
      _tag: "failed",
      step: "pr-error",
      reason: `the pull request step failed (${error.value._tag}): ${error.value.message}`,
    };
  }
  const first = Cause.pretty(cause).split("\n")[0]?.trim() ?? "unknown";
  return {
    _tag: "failed",
    step: "pr-error",
    reason: `the pull request step died: ${first}`,
  };
};
