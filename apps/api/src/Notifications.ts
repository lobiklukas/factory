/**
 * The notifier's boot (S-notifications): which sinks a deployment configured, which kinds it wants,
 * and the daemon that polls for them.
 *
 *   NOTIFY_SLACK_WEBHOOK_URL  a Slack incoming webhook; the URL is the credential, never logged
 *   NOTIFY_NTFY_TOPIC         an ntfy topic (as good as a password on a public server, never logged)
 *   NOTIFY_NTFY_URL           the ntfy server, default https://ntfy.sh
 *   NOTIFY_NTFY_TOKEN         an ntfy access token, for a protected topic
 *   NOTIFY_TYPES              which kinds: a comma-separated subset of question, approval, gate,
 *                             failed, spend; blank (the default) is all five
 *   NOTIFY_LINK_BASE          where links point: the dashboard's origin, default the first
 *                             ALLOWED_ORIGINS entry
 *   NOTIFY_POLL_MS            how often the notifier looks, default 5000
 *
 * With no sink the notifier is off, and the boot says so in one line; a malformed `NOTIFY_TYPES` or
 * poll interval, or an ntfy server with no topic, refuses the boot rather than paging nobody.
 */
import {
  makeNotifier,
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationSink,
  ntfySink,
  parseNotifyKinds,
  runNotifier,
  slackWebhookSink,
  TaskServiceLive,
} from "@repo/core";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

const DEFAULT_NTFY_URL = "https://ntfy.sh";
const DEFAULT_POLL_MS = 5_000;

export const NotifyConfig = Config.all({
  slackWebhookUrl: Config.option(Config.Redacted("NOTIFY_SLACK_WEBHOOK_URL")),
  ntfyUrl: Config.option(Config.String("NOTIFY_NTFY_URL")),
  ntfyTopic: Config.option(Config.Redacted("NOTIFY_NTFY_TOPIC")),
  ntfyToken: Config.option(Config.Redacted("NOTIFY_NTFY_TOKEN")),
  types: Config.String("NOTIFY_TYPES").pipe(Config.withDefault("")),
  linkBase: Config.option(Config.String("NOTIFY_LINK_BASE")),
  pollMs: Config.schema(
    Schema.Finite.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
    "NOTIFY_POLL_MS",
  ).pipe(Config.withDefault(DEFAULT_POLL_MS)),
});
export type NotifyConfig =
  typeof NotifyConfig extends Config.Config<infer A> ? A : never;

/** A notification setting the boot refuses. */
export class InvalidNotifyConfig extends Schema.TaggedError<InvalidNotifyConfig>()(
  "InvalidNotifyConfig",
  { message: Schema.String },
) {}

const present = (
  value: Option.Option<Redacted.Redacted<string>>,
): Redacted.Redacted<string> | undefined =>
  Option.isSome(value) && Redacted.value(value.value).trim() !== ""
    ? value.value
    : undefined;

/** What the boot resolved: the sinks, the kinds, where links go and how often to look. */
export type NotifyPlan = {
  readonly sinks: ReadonlyArray<NotificationSink>;
  readonly kinds: ReadonlySet<NotificationKind>;
  readonly linkBase: string;
  readonly pollMs: number;
};

/** Resolve the configuration into sinks; `defaultLinkBase` is the dashboard origin CORS allows. */
export const notifyPlan = (config: NotifyConfig, defaultLinkBase: string) =>
  Effect.gen(function* () {
    const kinds = yield* parseNotifyKinds(config.types).pipe(
      Effect.mapError(
        (error) => new InvalidNotifyConfig({ message: error.message }),
      ),
    );
    const sinks: NotificationSink[] = [];
    const slack = present(config.slackWebhookUrl);
    if (slack !== undefined) sinks.push(yield* slackWebhookSink(slack));
    const topic = present(config.ntfyTopic);
    const ntfyUrl = Option.getOrUndefined(config.ntfyUrl)?.trim();
    if (topic === undefined && ntfyUrl !== undefined && ntfyUrl !== "") {
      return yield* new InvalidNotifyConfig({
        message:
          "NOTIFY_NTFY_URL is set but NOTIFY_NTFY_TOPIC is not: ntfy needs the topic to publish to",
      });
    }
    if (topic !== undefined) {
      const token = present(config.ntfyToken);
      sinks.push(
        yield* ntfySink({
          url:
            ntfyUrl === undefined || ntfyUrl === ""
              ? DEFAULT_NTFY_URL
              : ntfyUrl,
          topic,
          ...(token === undefined ? {} : { token }),
        }),
      );
    }
    const plan: NotifyPlan = {
      sinks,
      kinds,
      linkBase: Option.getOrElse(config.linkBase, () => defaultLinkBase),
      pollMs: config.pollMs,
    };
    return plan;
  });

/** The boot's one line about notifications: names and kinds, never a URL with a secret in it. */
export const describeNotifyPlan = (plan: NotifyPlan): string =>
  plan.sinks.length === 0
    ? "notifications: off (set NOTIFY_SLACK_WEBHOOK_URL or NOTIFY_NTFY_TOPIC to notify a person when a run needs them)"
    : `notifications: ${NOTIFICATION_KINDS.filter((kind) => plan.kinds.has(kind)).join(", ") || "no kind"} to ${plan.sinks
        .map((sink) => sink.label)
        .join(" and ")}, every ${plan.pollMs}ms, linking to ${plan.linkBase}`;

/**
 * The daemon: read the configuration, log it, and — with a sink — poll for as long as the process
 * lives. Forked, so a pass that cannot reach Postgres (or runs before the migrations have) is
 * logged and the next one tries again. The first pass waits one interval, which is the boot's
 * migrations' head start.
 */
export const NotifierDaemon = (defaultLinkBase: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const plan = yield* notifyPlan(yield* NotifyConfig, defaultLinkBase);
      yield* Effect.logInfo(describeNotifyPlan(plan));
      if (plan.sinks.length === 0) return;
      const notifier = yield* makeNotifier({
        sinks: plan.sinks,
        kinds: plan.kinds,
        linkBase: plan.linkBase,
      });
      yield* Effect.forkScoped(
        Effect.sleep(plan.pollMs).pipe(
          Effect.andThen(runNotifier(notifier, plan.pollMs)),
        ),
      );
    }),
  ).pipe(Layer.provide(Layer.mergeAll(TaskServiceLive, FetchHttpClient.layer)));
