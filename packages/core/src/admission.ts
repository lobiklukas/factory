import {
  type CapacityCapKind,
  type SessionError,
  SessionError as SessionErrorClass,
  type SpendCap,
} from "@repo/domain/Session";
import { TriggerError } from "@repo/domain/Trigger";
import { formatDollars } from "@repo/harness";
import type { GitHubWebhookAnswer } from "./LinearSync";

/**
 * Admission control (LOB-70): the one refusal a request gets when it would open one more session
 * than the server runs at once, and how that refusal crosses each boundary — a typed `SessionError`
 * on the RPC surface, a typed `TriggerError` in the trigger seam, and a `503` with `Retry-After` on a
 * webhook route.
 *
 * The cap itself is counted by `SessionService` (`maxConcurrentSessions`), in open owners. A cap is
 * a limit and the name an operator changes it by, so a cap with another source — a board
 * definition's run caps (B9, LOB-71, counted by `./boardCaps`) — refuses with the same code and says
 * where its own limit lives (`runCapReached`).
 */

/** The configuration key the server's own cap is read from (`apps/api`). */
export const SESSION_MAX_CONCURRENT = "SESSION_MAX_CONCURRENT";

/** A concurrency cap: how many, and where an operator sets it. */
export type AdmissionCap = {
  readonly limit: number;
  /** Where the limit is configured, as an operator would look for it: a key, a definition. */
  readonly source: string;
};

/**
 * One of a board definition's run caps (B9, LOB-71), as a refusal names it: which kind, what it
 * counted (the board, task or repository, or the column and its board), and the runs that hold it —
 * the sessions an operator finishes, or whose cards they finish, to free a slot.
 */
export type RunCapHit = AdmissionCap & {
  readonly kind: Exclude<CapacityCapKind, "server">;
  /** The board, task or repository counted; for a column, the column's name. */
  readonly scope: string;
  /** The board the runs were counted on: the column's, for a column cap. */
  readonly board: string;
  readonly holders: ReadonlyArray<string>;
};

/** How a run cap's scope reads in a sentence: "on board brd_…", "in column building of board brd_…". */
const scopePhrase = (hit: RunCapHit): string => {
  switch (hit.kind) {
    case "board":
      return `on board ${hit.scope}`;
    case "task":
      return `on task ${hit.scope}`;
    case "repo":
      return `in repository ${hit.scope}`;
    case "column":
      return `in column ${hit.scope} of board ${hit.board}`;
  }
};

/** The refusal past a cap: `at_capacity`, naming the limit and where it is configured. */
export const atCapacity = (cap: AdmissionCap): SessionError =>
  new SessionErrorClass({
    code: "at_capacity",
    message: `at capacity: at most ${cap.limit} session${cap.limit === 1 ? "" : "s"} may be open at once (${cap.source}=${cap.limit}), and that many are; retry once one is released`,
    cap: { kind: "server", limit: cap.limit, source: cap.source },
  });

/**
 * The refusal past a board definition's run cap (LOB-71): the same `at_capacity` as the server's,
 * built the same way from a limit and its source, and naming what it counted and the runs holding
 * it. Nothing was written: a retry succeeds once one of them ends its turn, is discarded, or its
 * card is finished — the three ways a person frees a slot, so the refusal names all three. Discarding
 * (`factory discard`) is the one that frees a run that will never take a turn without changing its
 * card: on a card capped at one run, finishing the card is canceling it.
 */
export const runCapReached = (hit: RunCapHit): SessionError =>
  new SessionErrorClass({
    code: "at_capacity",
    message: `at capacity: at most ${hit.limit} run${hit.limit === 1 ? "" : "s"} may be in flight ${scopePhrase(hit)} at once (${hit.source}=${hit.limit}), and ${hit.holders.length} ${hit.holders.length === 1 ? "is" : "are"}: ${hit.holders.join(", ")}; retry once one ends its turn (send it a message if it is waiting for one), is discarded (factory discard <session>), or its card is done or canceled`,
    cap: {
      kind: hit.kind,
      limit: hit.limit,
      source: hit.source,
      scope: hit.scope,
    },
  });

/**
 * The refusal past an aggregate spend cap (S-aggregate-spend-caps): `budget_exceeded`, built like
 * `atCapacity` from a limit and where it is configured, and naming what it counted (a repository's
 * or an actor's spend), the window, the spend that reaches the limit, and when the window ends.
 * Nothing was written and no model was called: a retry succeeds when the window rolls over or an
 * operator raises the cap.
 */
export const budgetExceeded = (cap: SpendCap): SessionError =>
  new SessionErrorClass({
    code: "budget_exceeded",
    message: `budget exceeded: ${cap.scope === "repo" ? "repository" : "actor"} ${cap.subject} has spent ${formatDollars(cap.spent)} of its ${formatDollars(cap.limit)} ${cap.window === "day" ? "daily" : "monthly"} cap (${cap.source}), so no new run may start ${cap.scope === "repo" ? "on it" : "for them"} until that ${cap.window} ends at ${cap.resetsAt} or the cap is raised`,
    spendCap: cap,
  });

/**
 * How long a sender is told to wait after an `at-capacity` delivery, in seconds. A slot frees when an
 * owner is released, which the idle sweep does on its own schedule, so this is a polite interval
 * rather than a promise; a sender with its own schedule (Linear) is told to retry by the status.
 */
export const AT_CAPACITY_RETRY_AFTER_S = 60;

/**
 * A session failure as the trigger seam reports it: `at_capacity` keeps its meaning as
 * `at-capacity`, so a route can answer "not now" rather than "broken", `budget_exceeded` is the
 * same "not now" (the window rolls over, or the cap is raised, and the redelivery then succeeds),
 * and `setup_failed` its as
 * `setup-failed` (S-env-setup), which the seam records as an outcome; every other code is a failed
 * session create, as it was.
 */
export const triggerErrorOfSession = (
  cause: Pick<SessionError, "code" | "message"> &
    Partial<Pick<SessionError, "spendCap">>,
): TriggerError =>
  new TriggerError({
    code:
      cause.code === "at_capacity" || cause.code === "budget_exceeded"
        ? "at-capacity"
        : cause.code === "setup_failed"
          ? "setup-failed"
          : "session-create",
    message: cause.message,
    // A spend cap holds until its window ends, so a sender is told when, not "in a minute".
    ...(cause.code === "budget_exceeded" && cause.spendCap !== undefined
      ? { retryAfterSeconds: cause.spendCap.retryAfterSeconds }
      : {}),
  });

/**
 * A delivery that failed, as a GitHub-shaped route answers it: `503` with `Retry-After` for
 * `at-capacity`, so the sender retries later and the redelivery claims afresh (the seam released the
 * claim); `500` for anything else, a real failure.
 */
export const triggerFailureAnswer = (
  cause: Pick<TriggerError, "code" | "message"> &
    Partial<Pick<TriggerError, "retryAfterSeconds">>,
): GitHubWebhookAnswer => {
  const retryAfter = cause.retryAfterSeconds ?? AT_CAPACITY_RETRY_AFTER_S;
  return cause.code === "at-capacity"
    ? {
        status: 503,
        headers: { "retry-after": String(retryAfter) },
        body: {
          ok: false,
          error: cause.message,
          code: cause.code,
          retryAfterSeconds: retryAfter,
        },
      }
    : {
        status: 500,
        body: { ok: false, error: cause.message, code: cause.code },
      };
};
