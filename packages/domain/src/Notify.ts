/**
 * Notification settings (F21): which kinds of event a deployment tells people about, and where each
 * person is told — stored in the control plane's database and changed over RPC, so the dashboard's
 * settings page works without a restart.
 *
 * **Two layers of sink.** A *shared* sink is one the deployment's environment configures (a Slack
 * incoming webhook, an ntfy topic): it is the team's channel, and it gets every event that has no
 * owner with a sink of their own. A *personal* sink is one a person adds here — an email address, a
 * Web Push subscription of one browser — and it gets the events that person owns: the cards they
 * created, and the runs they started on a card nobody with a sink owns. An owner with an enabled
 * personal sink is told there **only**; an owner with none falls back to the shared sinks, so an
 * event is never silently unrouted.
 *
 * **Per-type toggles are global.** The four kinds (`question`, `approval`, `gate`, `failed`) are
 * switched on or off for the whole deployment. A kind with no stored toggle follows `NOTIFY_TYPES`;
 * the page's toggle overrides it from then on.
 *
 * A Web Push subscription is a capability (its endpoint is a URL that, with the VAPID key, pushes to
 * one browser), so no member answers it back: a sink is listed by its type and a label, which for a
 * push subscription is the push service's host.
 */
import { Schema } from "effect";
import { Timestamp } from "@repo/domain/Ids";
import { SessionActor } from "@repo/domain/Session";

/** The kinds of event a person can be told about; `NOTIFY_TYPES` and the page pick among them. */
export const NotificationKind = Schema.Literals([
  "question",
  "approval",
  "gate",
  "failed",
  "spend",
]);
export type NotificationKind = typeof NotificationKind.Type;
export const NOTIFICATION_KINDS: ReadonlyArray<NotificationKind> =
  NotificationKind.literals;

/** What a person's own sink can be: an email address, or a browser's Web Push subscription. */
export const NotificationSinkType = Schema.Literals(["email", "web_push"]);
export type NotificationSinkType = typeof NotificationSinkType.Type;

/** One kind's effective setting: `stored` is false while it still follows `NOTIFY_TYPES`. */
export const NotificationKindSetting = Schema.Struct({
  kind: NotificationKind,
  enabled: Schema.Boolean,
  stored: Schema.Boolean,
});
export type NotificationKindSetting = typeof NotificationKindSetting.Type;

/** A person's sink as the page lists it: never the push endpoint or its keys. */
export const NotificationSinkSummary = Schema.Struct({
  id: Schema.String,
  type: NotificationSinkType,
  /** The email address, or the push service's host. */
  label: Schema.String,
  enabled: Schema.Boolean,
  /** When the push service said the subscription is gone (HTTP 404/410); the sink is then off. */
  expiredAt: Schema.optional(Timestamp),
  createdAt: Timestamp,
});
export type NotificationSinkSummary = typeof NotificationSinkSummary.Type;

/** What this control plane can send, so the page offers only what works. */
export const NotificationChannels = Schema.Struct({
  /** `NOTIFY_SMTP_URL` and `NOTIFY_SMTP_FROM` are set. */
  email: Schema.Boolean,
  webPush: Schema.Struct({
    /** A VAPID key pair is set. */
    configured: Schema.Boolean,
    /** The VAPID public key a browser subscribes with (`applicationServerKey`), base64url. */
    publicKey: Schema.optional(Schema.String),
  }),
  /** The environment-configured sinks, by label: where an event with no owner goes. */
  shared: Schema.Array(Schema.String),
});
export type NotificationChannels = typeof NotificationChannels.Type;

export const NotificationSettings = Schema.Struct({
  /** Whose sinks are listed: the credential's actor, or the declared one on an open control plane. */
  actor: Schema.String,
  kinds: Schema.Array(NotificationKindSetting),
  sinks: Schema.Array(NotificationSinkSummary),
  channels: NotificationChannels,
});
export type NotificationSettings = typeof NotificationSettings.Type;

/**
 * Set by the control plane from the caller's credential (LOB-20), as a card write's actor is: a
 * person's sinks are theirs, so the actor is never taken from a body on a control plane with auth on.
 */
const Actor = Schema.optional(SessionActor);

export const GetNotificationSettingsInput = Schema.Struct({ actor: Actor });
export type GetNotificationSettingsInput =
  typeof GetNotificationSettingsInput.Type;

export const SetNotificationKindInput = Schema.Struct({
  kind: NotificationKind,
  enabled: Schema.Boolean,
  actor: Actor,
});
export type SetNotificationKindInput = typeof SetNotificationKindInput.Type;

export const EmailDestination = Schema.Struct({
  type: Schema.Literal("email"),
  address: Schema.String,
});
/** The three fields of a browser's `PushSubscription.toJSON()`, keys base64url. */
export const WebPushDestination = Schema.Struct({
  type: Schema.Literal("web_push"),
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
});
export const NotificationDestination = Schema.Union([
  EmailDestination,
  WebPushDestination,
]);
export type NotificationDestination = typeof NotificationDestination.Type;

export const AddNotificationSinkInput = Schema.Struct({
  destination: NotificationDestination,
  actor: Actor,
});
export type AddNotificationSinkInput = typeof AddNotificationSinkInput.Type;

export const NotificationSinkRefInput = Schema.Struct({
  id: Schema.String,
  actor: Actor,
});
export type NotificationSinkRefInput = typeof NotificationSinkRefInput.Type;

export const SetNotificationSinkEnabledInput = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
  actor: Actor,
});
export type SetNotificationSinkEnabledInput =
  typeof SetNotificationSinkEnabledInput.Type;

/** A destination the store refuses before anything is written: a malformed address or subscription. */
export class InvalidNotificationSink extends Schema.TaggedError<InvalidNotificationSink>()(
  "InvalidNotificationSink",
  { message: Schema.String },
) {}

/** This control plane cannot send that type (no SMTP server, no VAPID key), so it stores none. */
export class NotificationChannelUnavailable extends Schema.TaggedError<NotificationChannelUnavailable>()(
  "NotificationChannelUnavailable",
  { channel: NotificationSinkType, message: Schema.String },
) {}

/** The caller has no such sink: another person's is answered the same, so ids are not probed. */
export class NotificationSinkNotFound extends Schema.TaggedError<NotificationSinkNotFound>()(
  "NotificationSinkNotFound",
  { id: Schema.String, message: Schema.String },
) {}

export class NotificationStorageError extends Schema.TaggedError<NotificationStorageError>()(
  "NotificationStorageError",
  { message: Schema.String },
) {}

export type NotificationError =
  | InvalidNotificationSink
  | NotificationChannelUnavailable
  | NotificationSinkNotFound
  | NotificationStorageError;

/** Every refusal the notifications RPC group answers, on the wire. */
export const NotificationErrorSchema = Schema.Union([
  InvalidNotificationSink,
  NotificationChannelUnavailable,
  NotificationSinkNotFound,
  NotificationStorageError,
]);
