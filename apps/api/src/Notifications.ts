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
 * Personal sinks (F21) — what a person adds on the dashboard's notification settings page — need the
 * deployment to be able to send that type:
 *
 *   NOTIFY_SMTP_URL           an SMTP server for email: smtp://[user:password@]host[:587] (STARTTLS
 *                             when offered) or smtps://…[:465]; the URL holds the password, never logged
 *   NOTIFY_SMTP_FROM          the sender's address, required with NOTIFY_SMTP_URL
 *   NOTIFY_VAPID_PUBLIC_KEY   the Web Push application-server key pair, base64url (a pair is made by
 *   NOTIFY_VAPID_PRIVATE_KEY  `generateVapidKeys` in @repo/core); the private key is never logged
 *   NOTIFY_VAPID_SUBJECT      a mailto: or https: contact for push services, default mailto:<SMTP_FROM>
 *   NOTIFY_PUSH_ALLOW_INSECURE  accept http: and internal-host push endpoints (a loopback fake push service only)
 *   NOTIFY_RETENTION_DAYS     delivered notifications and run failures older than this are deleted
 *                             (F22), default 30
 *
 * With no sink and no way to send a personal one the notifier is off for delivery, and the boot says
 * so in one line; a malformed `NOTIFY_TYPES`, poll interval, SMTP URL or VAPID key, or an ntfy server
 * with no topic, refuses the boot rather than paging nobody. The daemon still runs, because the
 * retention sweep does and a sink added on the settings page is live on the next poll.
 */
import {
  expireWebPushSink,
  isEmailAddress,
  makeNotifier,
  makeNotifySettings,
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationSink,
  type NotifyChannels,
  NotifySettingsService,
  ntfySink,
  parseNotifyKinds,
  parseSmtpUrl,
  personalSinkOf,
  runNotifier,
  slackWebhookSink,
  smtpTransport,
  storedKinds,
  storedPeople,
  TaskServiceLive,
  vapidProblem,
  type VapidConfig,
} from "@repo/core";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";

const DEFAULT_NTFY_URL = "https://ntfy.sh";
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  smtpUrl: Config.option(Config.Redacted("NOTIFY_SMTP_URL")),
  smtpFrom: Config.option(Config.String("NOTIFY_SMTP_FROM")),
  vapidPublicKey: Config.option(Config.String("NOTIFY_VAPID_PUBLIC_KEY")),
  vapidPrivateKey: Config.option(Config.Redacted("NOTIFY_VAPID_PRIVATE_KEY")),
  vapidSubject: Config.option(Config.String("NOTIFY_VAPID_SUBJECT")),
  pushAllowInsecure: Config.Boolean("NOTIFY_PUSH_ALLOW_INSECURE").pipe(
    Config.withDefault(false),
  ),
  retentionDays: Config.schema(
    Schema.Finite.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
    "NOTIFY_RETENTION_DAYS",
  ).pipe(Config.withDefault(DEFAULT_RETENTION_DAYS)),
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
  /** What a person's own sink can be sent over: email and Web Push, when configured. */
  readonly channels: NotifyChannels;
  readonly retentionMs: number;
};

const text = (value: Option.Option<string>): string | undefined => {
  const trimmed = Option.getOrUndefined(value)?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * What personal sinks can be sent over: an SMTP server with its sender, and a VAPID key pair. Each
 * is all-or-nothing — a URL with no sender, or one half of a key pair, refuses the boot.
 */
export const notifyChannels = (config: NotifyConfig) =>
  Effect.gen(function* () {
    const refuse = (message: string) => new InvalidNotifyConfig({ message });
    const smtpUrl = present(config.smtpUrl);
    const from = text(config.smtpFrom);
    let email: NotifyChannels["email"];
    if (smtpUrl === undefined && from !== undefined) {
      return yield* refuse(
        "NOTIFY_SMTP_FROM is set but NOTIFY_SMTP_URL is not: email needs the server to send through",
      );
    }
    if (smtpUrl !== undefined) {
      if (from === undefined || !isEmailAddress(from)) {
        return yield* refuse(
          "NOTIFY_SMTP_URL is set but NOTIFY_SMTP_FROM is not an email address: email needs a sender",
        );
      }
      const smtp = yield* parseSmtpUrl(smtpUrl, "localhost").pipe(
        Effect.mapError((error) => refuse(error.message)),
      );
      email = { transport: smtpTransport(smtp), from };
    }
    const publicKey = text(config.vapidPublicKey);
    const privateKey = present(config.vapidPrivateKey);
    let vapid: VapidConfig | undefined;
    if ((publicKey === undefined) !== (privateKey === undefined)) {
      return yield* refuse(
        "NOTIFY_VAPID_PUBLIC_KEY and NOTIFY_VAPID_PRIVATE_KEY are set together or not at all",
      );
    }
    if (publicKey !== undefined && privateKey !== undefined) {
      const subject =
        text(config.vapidSubject) ??
        (from === undefined ? undefined : `mailto:${from}`);
      if (subject === undefined) {
        return yield* refuse(
          "NOTIFY_VAPID_SUBJECT is not set: push services want a mailto: or https: contact",
        );
      }
      vapid = { publicKey, privateKey, subject };
      const problem = vapidProblem(vapid);
      if (problem !== undefined) return yield* refuse(problem);
    }
    const channels: NotifyChannels = {
      ...(email === undefined ? {} : { email }),
      ...(vapid === undefined ? {} : { vapid }),
      allowInsecurePush: config.pushAllowInsecure,
    };
    return channels;
  });

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
    const channels = yield* notifyChannels(config);
    const plan: NotifyPlan = {
      sinks,
      kinds,
      linkBase: Option.getOrElse(config.linkBase, () => defaultLinkBase),
      pollMs: config.pollMs,
      channels,
      retentionMs: config.retentionDays * DAY_MS,
    };
    return plan;
  });

/** The boot's one line about notifications: names and kinds, never a URL with a secret in it. */
export const describeNotifyPlan = (plan: NotifyPlan): string => {
  const targets = [
    ...plan.sinks.map((sink) => sink.label),
    ...(plan.channels.email === undefined ? [] : ["each person's email"]),
    ...(plan.channels.vapid === undefined ? [] : ["each person's Web Push"]),
  ];
  return targets.length === 0
    ? "notifications: off (set NOTIFY_SLACK_WEBHOOK_URL or NOTIFY_NTFY_TOPIC to notify a person when a run needs them)"
    : `notifications: ${NOTIFICATION_KINDS.filter((kind) => plan.kinds.has(kind)).join(", ") || "no kind"} to ${targets.join(" and ")}, every ${plan.pollMs}ms, linking to ${plan.linkBase}`;
};

/**
 * The daemon: read the configuration, log it, and poll for as long as the process lives. Forked, so
 * a pass that cannot reach Postgres (or runs before the migrations have) is logged and the next one
 * tries again. The first pass waits one interval, which is the boot's migrations' head start.
 *
 * It runs with no shared sink too: a sink a person adds on the settings page is read at the start of
 * every pass, the stored kind toggles lie over `NOTIFY_TYPES` the same way, and the retention sweep
 * (F22) is the poll's. A pass with nothing to deliver and nothing due to prune reads two small tables.
 */
export const NotifierDaemon = (defaultLinkBase: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const plan = yield* notifyPlan(yield* NotifyConfig, defaultLinkBase);
      yield* Effect.logInfo(describeNotifyPlan(plan));
      const sql = yield* SqlClient;
      const build = yield* personalSinkOf(plan.channels);
      const notifier = yield* makeNotifier({
        sinks: plan.sinks,
        kinds: storedKinds(plan.kinds).pipe(
          Effect.provideService(SqlClient, sql),
        ),
        people: storedPeople(build).pipe(Effect.provideService(SqlClient, sql)),
        onGone: (sinkId) =>
          expireWebPushSink(sinkId).pipe(
            Effect.provideService(SqlClient, sql),
            Effect.asVoid,
          ),
        linkBase: plan.linkBase,
        retentionMs: plan.retentionMs,
      });
      yield* Effect.forkScoped(
        Effect.sleep(plan.pollMs).pipe(
          Effect.andThen(runNotifier(notifier, plan.pollMs)),
        ),
      );
    }),
  ).pipe(Layer.provide(Layer.mergeAll(TaskServiceLive, FetchHttpClient.layer)));

/**
 * The settings service over the same configuration the daemon reads (F21): the page's `channels` say
 * what this process can send, and its toggles lie over `NOTIFY_TYPES`. A configuration the daemon
 * refuses fails this layer the same way.
 */
export const NotifySettingsFromEnv = Layer.effect(
  NotifySettingsService,
  Effect.gen(function* () {
    const plan = yield* notifyPlan(yield* NotifyConfig, "");
    return NotifySettingsService.of(
      yield* makeNotifySettings({
        defaultKinds: plan.kinds,
        shared: plan.sinks.map((sink) => sink.label),
        channels: plan.channels,
      }),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
