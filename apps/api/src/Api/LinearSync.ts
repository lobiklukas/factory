/* oxlint-disable effecttsgo/process-env */
/**
 * The Linear write-back's deployment wiring (LOB-15): one config, one sync, two consumers.
 *
 * The trigger seam moves a delegated issue to *started* when its session opens (`Webhook.ts`), and
 * the session layer mirrors the PR step on it (`index.ts`). Both are fed by the same
 * `LinearIssueSync` layer value, so the process builds one client and one write lock rather than a
 * copy per consumer.
 *
 * The config is read from the environment once, when the module loads, the way `Webhook.ts` reads
 * its rules — so whether the write-back is on is decided before any layer is built:
 *
 *   LINEAR_API_KEY            the key the write-back authenticates as; unset means no write-back
 *   LINEAR_API_URL            the GraphQL endpoint (default Linear's own)
 *   LINEAR_STATE_STARTED      the state a started session moves its issue to (default In Progress)
 *   LINEAR_STATE_IN_REVIEW    the state an opened PR moves it to (default In Review)
 *   LINEAR_STATE_DONE         the state a merged PR moves it to (default Done)
 *   LINEAR_SESSION_URL_BASE   where a comment links a session, e.g. http://localhost:3000/sessions
 */
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  LinearIssueSyncLive,
  LinearSessionWriteBack,
  LinearTriggerWriteBack,
  linearConfigFromEnv,
  NoWriteBack,
} from "@repo/core";

export const linearConfig = linearConfigFromEnv({
  apiUrl: process.env["LINEAR_API_URL"],
  apiKey: process.env["LINEAR_API_KEY"],
  stateStarted: process.env["LINEAR_STATE_STARTED"],
  stateInReview: process.env["LINEAR_STATE_IN_REVIEW"],
  stateDone: process.env["LINEAR_STATE_DONE"],
  sessionUrlBase: process.env["LINEAR_SESSION_URL_BASE"],
});

const LinearSync =
  linearConfig === undefined
    ? undefined
    : LinearIssueSyncLive(linearConfig).pipe(
        Layer.provide(FetchHttpClient.layer),
      );

/** The trigger seam's write-back: Linear's when a key is configured, otherwise none. */
export const TriggerWriteBackLive =
  LinearSync === undefined
    ? NoWriteBack
    : LinearTriggerWriteBack.pipe(Layer.provide(LinearSync));

/** The session layer's write-back. Without a key nothing is provided, and the default is a no-op. */
export const SessionWriteBackLive =
  LinearSync === undefined
    ? Layer.empty
    : LinearSessionWriteBack.pipe(Layer.provide(LinearSync));

/** Say at boot whether the loop closes in Linear, and through which states. */
export const LinearSyncLog = Layer.effectDiscard(
  linearConfig === undefined
    ? Effect.logInfo("linear write-back: off (no LINEAR_API_KEY)")
    : Effect.logInfo(
        `linear write-back: on — started → ${linearConfig.states.started}, PR opened → ${linearConfig.states.inReview}, merged → ${linearConfig.states.done}`,
      ),
);
