/* oxlint-disable effecttsgo/process-env */
/**
 * The Linear write-back's deployment wiring (LOB-15): one config, one sync, three consumers.
 *
 * The trigger seam moves a delegated issue to *started* when its session opens (`Webhook.ts`), the
 * session layer mirrors the PR step on it (`index.ts`), and the GitHub webhook moves it to *done*
 * when its PR merges (`GitHubWebhook.ts`). All three read the one `LinearIssueSync` that
 * `LinearIssueSyncLayer` builds, and `index.ts` provides it beside Postgres — outside
 * `HttpRouter.serve`, whose forked `MemoMap` would otherwise build a private copy for the routes. So
 * the process holds one client and one set of per-issue write locks, which is what the sync's
 * read-then-write idempotency leans on.
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
import type { SqlClient } from "effect/sql/SqlClient";
import {
  type LinearIssueSync,
  LinearAskWriteBack,
  LinearIssueSyncLive,
  LinearTriggerBlockers,
  LinearTriggerReplies,
  LinearProposalTracker,
  LinearSessionWriteBack,
  LinearTriggerWriteBack,
  linearConfigFromEnv,
  NoLinearIssueSync,
  NoWriteBack,
  type TriggerWriteBack,
} from "@repo/core";

export const linearConfig = linearConfigFromEnv({
  apiUrl: process.env["LINEAR_API_URL"],
  apiKey: process.env["LINEAR_API_KEY"],
  stateStarted: process.env["LINEAR_STATE_STARTED"],
  stateInReview: process.env["LINEAR_STATE_IN_REVIEW"],
  stateDone: process.env["LINEAR_STATE_DONE"],
  sessionUrlBase: process.env["LINEAR_SESSION_URL_BASE"],
});

/** The process's one sync: Linear's when a key is configured, otherwise one that writes nothing. */
export const LinearIssueSyncLayer: Layer.Layer<LinearIssueSync> =
  linearConfig === undefined
    ? NoLinearIssueSync
    : LinearIssueSyncLive(linearConfig).pipe(
        Layer.provide(FetchHttpClient.layer),
      );

/** The trigger seam's write-back: Linear's when a key is configured, otherwise none. */
export const TriggerWriteBackLive: Layer.Layer<
  TriggerWriteBack,
  never,
  LinearIssueSync
> = linearConfig === undefined ? NoWriteBack : LinearTriggerWriteBack;

/**
 * The session layer's write-back. Without a key nothing is provided, and the default is a no-op —
 * so a PR step in a deployment with no tracker does not even look up which issue it belongs to.
 */
export const SessionWriteBackLive: Layer.Layer<
  never,
  never,
  LinearIssueSync | SqlClient
> = linearConfig === undefined ? Layer.empty : LinearSessionWriteBack;

/**
 * Where a question a run asks on a card filed from a Linear issue is also asked, as an `elicitation`
 * in Linear (T5). Without a key nothing is provided and the `ask` tool is unchanged.
 */
export const AskWriteBackLive: Layer.Layer<
  never,
  never,
  LinearIssueSync | SqlClient
> = linearConfig === undefined ? Layer.empty : LinearAskWriteBack;

/**
 * The seam's blocker gate (T5): an issue with an open `blockedBy` relation starts nothing. Without a
 * key there is no way to read the relations, and the seam waits on nothing, as before.
 */
export const TriggerBlockersLive: Layer.Layer<never, never, LinearIssueSync> =
  linearConfig === undefined ? Layer.empty : LinearTriggerBlockers;

/**
 * Where a person's reply in a Linear agent session goes (T5): the answer on the card its question
 * parked. A reply is a signed event like any delivery, so this needs no Linear key.
 */
export const TriggerRepliesLive = LinearTriggerReplies;

/**
 * Where an approved proposal becomes a Linear issue (LOB-202). Without a key nothing is provided and
 * the port's default refuses `no_tracker` with nothing sent, so `approveProposals` on a process with
 * no tracker is an answer rather than a silent success.
 */
export const ProposalTrackerLive: Layer.Layer<
  never,
  never,
  LinearIssueSync | SqlClient
> = linearConfig === undefined ? Layer.empty : LinearProposalTracker;

/** Say at boot whether the loop closes in Linear, and through which states. */
export const LinearSyncLog = Layer.effectDiscard(
  linearConfig === undefined
    ? Effect.logInfo("linear write-back: off (no LINEAR_API_KEY)")
    : Effect.logInfo(
        `linear write-back: on — started → ${linearConfig.states.started}, PR opened → ${linearConfig.states.inReview}, merged → ${linearConfig.states.done} (POST /webhooks/github, GITHUB_WEBHOOK_SECRET)`,
      ),
);
