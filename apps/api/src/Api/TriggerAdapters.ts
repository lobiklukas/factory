/* oxlint-disable effecttsgo/process-env */
/**
 * The trigger adapters' deployment wiring (LOB-259): what answers a delivery after its session
 * opens, per source, and what answers the PR step after a session's PR does.
 *
 * `LinearSync.ts` is the Linear half of this and the model for the rest: a config read from the
 * environment once, when the module loads, so whether a client is on is decided before any layer is
 * built; no config, no client. The seam has one `TriggerWriteBack` and routes share one seam, so the
 * clients are put behind `TriggerWriteBackBySource`, which hands an event to the client of the
 * system it came from. The generic source writes nothing back.
 *
 *   Jira      JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (all three, or no client)  an issue comment
 *             JIRA_SESSION_URL_BASE  where a comment links a session
 *   Sentry    SENTRY_API_TOKEN (no token, no client)  one note on the alert's Sentry issue (LOB-83)
 *             SENTRY_API_URL  the API root (default https://sentry.io), SENTRY_SESSION_URL_BASE
 *   GitHub    GITHUB_SESSION_URL_BASE  where a comment links a session. The comment is posted with
 *             the credential seam's token (GITHUB_TOKEN or the App), the PR client's own
 *   Slack     SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_CHANNELS (all three, or no client)
 *             SLACK_API_URL, SLACK_SESSION_URL_BASE  a threaded reply: the session's link when the
 *             delivery opens it, and the PR's link when the session's PR step opens one
 *
 * A route's *secret* is not part of this: it is read per request, beside the route, and a route
 * with none answers `503` whether or not its client is configured. A client with no route answers
 * nothing, and a route with no client starts sessions and writes nothing back.
 */
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  type CredentialProvider,
  GitHubAuthorPermissions,
  GitHubWriteBack,
  jiraConfigFromEnv,
  JiraWriteBack,
  type LinearIssueSync,
  NoWriteBack,
  sentryApiConfigFromEnv,
  SentryWriteBack,
  SessionWriteBacksAll,
  slackConfigFromEnv,
  type SlackEnv,
  SlackSessionWriteBack,
  SlackWriteBack,
  TriggerWriteBackBySource,
} from "@repo/core";
import {
  SessionWriteBackLive as LinearSessionWriteBackLive,
  TriggerWriteBackLive as LinearTriggerWriteBackLive,
} from "./LinearSync";

export const jiraConfig = jiraConfigFromEnv({
  baseUrl: process.env["JIRA_BASE_URL"],
  email: process.env["JIRA_EMAIL"],
  apiToken: process.env["JIRA_API_TOKEN"],
  sessionUrlBase: process.env["JIRA_SESSION_URL_BASE"],
});

export const sentryApiConfig = sentryApiConfigFromEnv({
  apiUrl: process.env["SENTRY_API_URL"],
  authToken: process.env["SENTRY_API_TOKEN"],
  sessionUrlBase: process.env["SENTRY_SESSION_URL_BASE"],
});

/** The Slack environment as the process holds it *now*: the route reads its filter per request. */
export const slackEnv = (): SlackEnv => ({
  apiUrl: process.env["SLACK_API_URL"],
  botToken: process.env["SLACK_BOT_TOKEN"],
  signingSecret: process.env["SLACK_SIGNING_SECRET"],
  sessionUrlBase: process.env["SLACK_SESSION_URL_BASE"],
  channels: process.env["SLACK_CHANNELS"],
  text: process.env["SLACK_TEXT"],
});

export const slackApp = slackConfigFromEnv(slackEnv());

const githubSessionUrlBase = process.env["GITHUB_SESSION_URL_BASE"]?.trim();

/**
 * The trigger seam's write-back, per source: Linear's when a key is configured, Jira's, Slack's and
 * Sentry's when their clients are, and GitHub's always — a GitHub delivery needs no config of its own beyond
 * the credential the PR step already needs, and one without it fails at the comment (`write-back`),
 * which the delivery's `500` names.
 */
export const TriggerWriteBacksLive = TriggerWriteBackBySource<
  LinearIssueSync | CredentialProvider
>({
  linear: LinearTriggerWriteBackLive,
  jira:
    jiraConfig === undefined
      ? NoWriteBack
      : JiraWriteBack(jiraConfig).pipe(Layer.provide(FetchHttpClient.layer)),
  slack:
    slackApp === undefined
      ? NoWriteBack
      : SlackWriteBack(slackApp.config).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
  sentry:
    sentryApiConfig === undefined
      ? NoWriteBack
      : SentryWriteBack(sentryApiConfig).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
  github: GitHubWriteBack(
    githubSessionUrlBase ? { sessionUrlBase: githubSessionUrlBase } : {},
  ).pipe(Layer.provide(FetchHttpClient.layer)),
});

/**
 * The trust gate's permission port (S-trigger-trust-gating): a GitHub author's role on the repo, read
 * with the same credential and API root (`GITHUB_API_URL`) the comment uses. Asked only for a rule
 * whose `trust.githubPermission` is set and an author its allowlist does not name.
 */
export const TriggerAuthorPermissionsLive = GitHubAuthorPermissions().pipe(
  Layer.provide(FetchHttpClient.layer),
);

/**
 * The session layer's write-back: Linear's mirror of the PR step, and Slack's reply with the PR's
 * link, each only when configured. Without either nothing is reported, as before.
 */
export const SessionWriteBacksLive = SessionWriteBacksAll([
  LinearSessionWriteBackLive,
  slackApp === undefined
    ? Layer.empty
    : SlackSessionWriteBack(slackApp.config).pipe(
        Layer.provide(FetchHttpClient.layer),
      ),
]);

/** The GitHub route's secret as the process holds it *now*: the route reads it per request. */
const githubWebhookSecret = (): string | undefined =>
  process.env["GITHUB_WEBHOOK_SECRET"]?.trim();

/** Say at boot which adapters answer back, and where. */
export const TriggerAdaptersLog = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.logInfo(
      jiraConfig === undefined
        ? "jira write-back: off (JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not all set)"
        : `jira write-back: on — comments on issues at ${jiraConfig.baseUrl} (POST /webhooks/jira, JIRA_WEBHOOK_SECRET)`,
    );
    yield* Effect.logInfo(
      sentryApiConfig === undefined
        ? "sentry write-back: off (SENTRY_API_TOKEN is not set)"
        : `sentry write-back: on — one note naming the session on the alert's Sentry issue at ${sentryApiConfig.baseUrl} (best effort: a failed note is logged, never the delivery's failure)`,
    );
    yield* Effect.logInfo(
      slackApp === undefined
        ? "slack write-back: off (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET and SLACK_CHANNELS are not all set)"
        : `slack write-back: on — the session's link and the PR's link in the thread, channels ${slackApp.filter.channels.join(", ")} (POST /webhooks/slack, SLACK_SIGNING_SECRET)`,
    );
    // The route's secret is read per request, so the line says what the process holds now. The
    // comment needs the credential the PR step needs (GITHUB_TOKEN or the App), which is not
    // checked here: the line names it instead of claiming the write-back works.
    const githubSecret = githubWebhookSecret();
    yield* Effect.logInfo(
      githubSecret === undefined || githubSecret === ""
        ? "github issue intake: off (GITHUB_WEBHOOK_SECRET is not set, so POST /webhooks/github answers 503)"
        : "github issue intake: on (POST /webhooks/github); it comments the session's link on the issue with the GitHub credential (GITHUB_TOKEN or the App), and a comment that cannot be posted fails the delivery",
    );
  }),
);
