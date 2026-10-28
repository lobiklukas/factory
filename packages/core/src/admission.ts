import {
  type SessionError,
  SessionError as SessionErrorClass,
} from "@repo/domain/Session";
import { TriggerError } from "@repo/domain/Trigger";
import type { GitHubWebhookAnswer } from "./LinearSync";

/**
 * Admission control (LOB-70): the one refusal a request gets when it would open one more session
 * than the server runs at once, and how that refusal crosses each boundary — a typed `SessionError`
 * on the RPC surface, a typed `TriggerError` in the trigger seam, and a `503` with `Retry-After` on a
 * webhook route.
 *
 * The cap itself is counted by `SessionService` (`maxConcurrentSessions`), in open owners. A cap is
 * a limit and the name an operator changes it by, so a later cap with another source (a board's, in
 * its definition — LOB-71) refuses with the same code and says where its own limit lives.
 */

/** The configuration key the server's own cap is read from (`apps/api`). */
export const SESSION_MAX_CONCURRENT = "SESSION_MAX_CONCURRENT";

/** A concurrency cap: how many, and where an operator sets it. */
export type AdmissionCap = {
  readonly limit: number;
  /** Where the limit is configured, as an operator would look for it: a key, a definition. */
  readonly source: string;
};

/** The refusal past a cap: `at_capacity`, naming the limit and where it is configured. */
export const atCapacity = (cap: AdmissionCap): SessionError =>
  new SessionErrorClass({
    code: "at_capacity",
    message: `at capacity: at most ${cap.limit} session${cap.limit === 1 ? "" : "s"} may be open at once (${cap.source}=${cap.limit}), and that many are; retry once one is released`,
  });

/**
 * How long a sender is told to wait after an `at-capacity` delivery, in seconds. A slot frees when an
 * owner is released, which the idle sweep does on its own schedule, so this is a polite interval
 * rather than a promise; a sender with its own schedule (Linear) is told to retry by the status.
 */
export const AT_CAPACITY_RETRY_AFTER_S = 60;

/**
 * A session failure as the trigger seam reports it: `at_capacity` keeps its meaning as
 * `at-capacity`, so a route can answer "not now" rather than "broken"; every other code is a
 * failed session create, as it was.
 */
export const triggerErrorOfSession = (
  cause: Pick<SessionError, "code" | "message">,
): TriggerError =>
  new TriggerError({
    code: cause.code === "at_capacity" ? "at-capacity" : "session-create",
    message: cause.message,
  });

/**
 * A delivery that failed, as a GitHub-shaped route answers it: `503` with `Retry-After` for
 * `at-capacity`, so the sender retries later and the redelivery claims afresh (the seam released the
 * claim); `500` for anything else, a real failure.
 */
export const triggerFailureAnswer = (
  cause: Pick<TriggerError, "code" | "message">,
): GitHubWebhookAnswer =>
  cause.code === "at-capacity"
    ? {
        status: 503,
        headers: { "retry-after": String(AT_CAPACITY_RETRY_AFTER_S) },
        body: {
          ok: false,
          error: cause.message,
          code: cause.code,
          retryAfterSeconds: AT_CAPACITY_RETRY_AFTER_S,
        },
      }
    : {
        status: 500,
        body: { ok: false, error: cause.message, code: cause.code },
      };
