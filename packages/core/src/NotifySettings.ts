/**
 * Notification settings (F21): the stored half of the notifier's configuration — the per-kind
 * toggles and each person's own sinks — and the reads the notifier makes of them on every pass.
 *
 * `NotifySettingsService` is what the settings RPC calls: it validates a destination before it is
 * stored (an address a header cannot be injected through, a Web Push subscription an `https:`
 * endpoint and well-formed keys), refuses a type this control plane cannot send, and scopes every
 * sink write to the caller — a person lists, pauses and removes their own sinks, and another's id
 * answers `NotificationSinkNotFound` exactly as an id that does not exist does.
 *
 * `storedKinds` and `storedPeople` are the notifier's side: the kinds with the stored toggles laid
 * over `NOTIFY_TYPES`, and the enabled sinks as `NotificationSink`s keyed by their owner. Both are
 * read at the start of a pass, so a toggle or a new sink is live on the next poll with no restart. A
 * stored row this deployment cannot send to (its SMTP server or VAPID key is gone, a subscription
 * stored before the endpoint policy tightened) is skipped and logged, never failed on: a pass must
 * not stop because one person's row is stale.
 */
import { randomBytes } from "node:crypto";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  type AddNotificationSinkInput,
  InvalidNotificationSink,
  NOTIFICATION_KINDS,
  NotificationChannelUnavailable,
  type NotificationKind,
  type NotificationSettings,
  NotificationSinkNotFound,
  type NotificationSinkSummary,
  NotificationStorageError,
  type NotificationSinkType,
  type SetNotificationKindInput,
} from "@repo/domain/Notify";
import { emailSink, isEmailAddress, type MailTransport } from "./NotifierEmail";
import {
  subscriptionProblem,
  type VapidConfig,
  webPushSink,
  webPushSinkId,
} from "./NotifierWebPush";
import { HttpClient } from "effect/http";
import {
  type NotificationSink,
  NotifyStorageError,
  type PeopleSinks,
} from "./Notifier";

/** What this control plane can send, from its environment: absent means that type is unavailable. */
export type NotifyChannels = {
  readonly email?: { readonly transport: MailTransport; readonly from: string };
  readonly vapid?: VapidConfig;
  /** `http:` push endpoints, for a loopback fake push service; every real one is `https:`. */
  readonly allowInsecurePush: boolean;
};

/** A person may keep this many sinks: a settings page, not a broadcast list. */
export const MAX_SINKS_PER_ACTOR = 10;

const EmailConfig = Schema.Struct({ address: Schema.String });
const PushConfig = Schema.Struct({
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
});

type SinkRow = {
  readonly id: string;
  readonly actor: string;
  readonly type: string;
  readonly config: string;
  readonly enabled: boolean;
  readonly expiredAt: Date | string | null;
  readonly createdAt: Date | string;
};

const iso = (value: Date | string): string =>
  DateTime.formatIso(DateTime.makeUnsafe(value));

const StoredConfig = Schema.Union([EmailConfig, PushConfig]);
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(StoredConfig));

const decodeEmail = Schema.decodeUnknownOption(
  Schema.fromJsonString(EmailConfig),
);
const decodePush = Schema.decodeUnknownOption(
  Schema.fromJsonString(PushConfig),
);

/** What the page shows for a sink: an address, or only the push service's host. */
const labelOf = (row: SinkRow): string => {
  if (row.type === "email") {
    const config = decodeEmail(row.config);
    return config._tag === "Some" ? config.value.address : "an email address";
  }
  const config = decodePush(row.config);
  if (config._tag === "None") return "a Web Push subscription";
  try {
    return new URL(config.value.endpoint).host;
  } catch {
    return "a Web Push subscription";
  }
};

const summaryOf = (row: SinkRow): NotificationSinkSummary => ({
  id: row.id,
  type: row.type === "email" ? "email" : "web_push",
  label: labelOf(row),
  enabled: row.enabled,
  ...(row.expiredAt === null || row.expiredAt === undefined
    ? {}
    : { expiredAt: iso(row.expiredAt) }),
  createdAt: iso(row.createdAt),
});

const withStorage = <A>(
  effect: Effect.Effect<A, SqlError>,
): Effect.Effect<A, NotificationStorageError> =>
  effect.pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(new NotificationStorageError({ message: cause.message })),
    ),
  );

export type NotifySettingsShape = {
  /** The effective toggles, `actor`'s sinks and what this control plane can send. */
  readonly get: (
    actor: string,
  ) => Effect.Effect<NotificationSettings, NotificationStorageError>;
  readonly setKind: (
    input: SetNotificationKindInput & { readonly actor: string },
  ) => Effect.Effect<NotificationSettings, NotificationStorageError>;
  readonly addSink: (
    actor: string,
    destination: AddNotificationSinkInput["destination"],
  ) => Effect.Effect<
    NotificationSinkSummary,
    | InvalidNotificationSink
    | NotificationChannelUnavailable
    | NotificationStorageError
  >;
  readonly setSinkEnabled: (
    actor: string,
    id: string,
    enabled: boolean,
  ) => Effect.Effect<
    NotificationSinkSummary,
    NotificationSinkNotFound | NotificationStorageError
  >;
  readonly removeSink: (
    actor: string,
    id: string,
  ) => Effect.Effect<
    NotificationSinkSummary,
    NotificationSinkNotFound | NotificationStorageError
  >;
};

export class NotifySettingsService extends Context.Service<
  NotifySettingsService,
  NotifySettingsShape
>()("@repo/core/NotifySettingsService") {}

export type NotifySettingsOptions = {
  /** The kinds `NOTIFY_TYPES` wants: what a kind with no stored toggle follows. */
  readonly defaultKinds: ReadonlySet<NotificationKind>;
  /** The labels of the environment-configured sinks, which the page names as the shared channel. */
  readonly shared: ReadonlyArray<string>;
  readonly channels: NotifyChannels;
};

const unavailable = (
  channel: NotificationSinkType,
  message: string,
): NotificationChannelUnavailable =>
  new NotificationChannelUnavailable({ channel, message });

/** The settings over one database. `NotifySettingsLive` is this with the process's configuration. */
export const makeNotifySettings = (
  options: NotifySettingsOptions,
): Effect.Effect<NotifySettingsShape, never, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const { channels } = options;
    const columns = sql`id, actor, type, config::text AS config, enabled, expired_at, created_at`;

    const kindSettings = withStorage(
      sql<{ readonly kind: string; readonly enabled: boolean }>`
        SELECT kind, enabled FROM notification_kinds
      `,
    ).pipe(
      Effect.map((rows) =>
        NOTIFICATION_KINDS.map((kind) => {
          const stored = rows.find((row) => row.kind === kind);
          return {
            kind,
            enabled:
              stored === undefined
                ? options.defaultKinds.has(kind)
                : stored.enabled,
            stored: stored !== undefined,
          };
        }),
      ),
    );

    const get = Effect.fn("NotifySettings.get")(function* (actor: string) {
      const kinds = yield* kindSettings;
      const rows = yield* withStorage(
        sql<SinkRow>`
          SELECT ${columns} FROM notification_sinks
          WHERE actor = ${actor} ORDER BY created_at, id
        `,
      );
      return {
        actor,
        kinds,
        sinks: rows.map(summaryOf),
        channels: {
          email: channels.email !== undefined,
          webPush: {
            configured: channels.vapid !== undefined,
            ...(channels.vapid === undefined
              ? {}
              : { publicKey: channels.vapid.publicKey }),
          },
          shared: options.shared,
        },
      } satisfies NotificationSettings;
    });

    const setKind = Effect.fn("NotifySettings.setKind")(function* (
      input: SetNotificationKindInput & { readonly actor: string },
    ) {
      yield* withStorage(
        sql`
          INSERT INTO notification_kinds (kind, enabled, updated_by)
          VALUES (${input.kind}, ${input.enabled}, ${input.actor})
          ON CONFLICT (kind) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
        `,
      );
      return yield* get(input.actor);
    });

    const addSink = Effect.fn("NotifySettings.addSink")(function* (
      actor: string,
      destination: AddNotificationSinkInput["destination"],
    ) {
      let key: string;
      let config: typeof StoredConfig.Type;
      if (destination.type === "email") {
        if (channels.email === undefined) {
          return yield* unavailable(
            "email",
            "this control plane has no SMTP server (NOTIFY_SMTP_URL and NOTIFY_SMTP_FROM), so it cannot send email; nothing was stored",
          );
        }
        const address = destination.address.trim();
        if (!isEmailAddress(address)) {
          return yield* new InvalidNotificationSink({
            message: `"${address}" is not an email address (one local@domain, no spaces or brackets); nothing was stored`,
          });
        }
        key = address.toLowerCase();
        config = { address };
      } else {
        if (channels.vapid === undefined) {
          return yield* unavailable(
            "web_push",
            "this control plane has no VAPID key pair (NOTIFY_VAPID_PUBLIC_KEY, NOTIFY_VAPID_PRIVATE_KEY), so it cannot send Web Push; nothing was stored",
          );
        }
        const problem = subscriptionProblem(
          destination,
          channels.allowInsecurePush,
        );
        if (problem !== undefined) {
          return yield* new InvalidNotificationSink({
            message: `${problem}; nothing was stored`,
          });
        }
        key = destination.endpoint;
        config = {
          endpoint: destination.endpoint,
          p256dh: destination.p256dh,
          auth: destination.auth,
        };
      }
      const field =
        destination.type === "email"
          ? sql`config->>'address'`
          : sql`config->>'endpoint'`;
      const existing = yield* withStorage(
        sql<SinkRow>`
          SELECT ${columns} FROM notification_sinks
          WHERE actor = ${actor} AND type = ${destination.type}
            AND lower(${field}) = lower(${key})
        `,
      );
      const same = existing[0];
      if (same !== undefined) {
        // Adding what the person already has turns it back on: the answer they wanted.
        const [row] = yield* withStorage(
          sql<SinkRow>`
            UPDATE notification_sinks SET enabled = TRUE, expired_at = NULL WHERE id = ${same.id}
            RETURNING ${columns}
          `,
        );
        return summaryOf(row ?? same);
      }
      const owned = yield* withStorage(
        sql<{ readonly n: number }>`
          SELECT count(*)::int AS n FROM notification_sinks WHERE actor = ${actor}
        `,
      );
      if ((owned[0]?.n ?? 0) >= MAX_SINKS_PER_ACTOR) {
        return yield* new InvalidNotificationSink({
          message: `${actor} already has ${MAX_SINKS_PER_ACTOR} sinks; remove one first. Nothing was stored`,
        });
      }
      const id = `nsk_${randomBytes(10).toString("hex")}`;
      const stored = yield* encodeConfig(config).pipe(
        Effect.mapError(
          () =>
            new NotificationStorageError({
              message: "the destination could not be encoded",
            }),
        ),
      );
      const [row] = yield* withStorage(
        sql<SinkRow>`
          INSERT INTO notification_sinks (id, actor, type, config)
          VALUES (${id}, ${actor}, ${destination.type}, ${stored}::jsonb)
          RETURNING ${columns}
        `,
      );
      if (row === undefined) {
        return yield* new NotificationStorageError({
          message: "the write answered no row",
        });
      }
      return summaryOf(row);
    });

    const notFound = (id: string) =>
      new NotificationSinkNotFound({
        id,
        message: `you have no notification sink ${id}`,
      });

    const setSinkEnabled = Effect.fn("NotifySettings.setSinkEnabled")(
      function* (actor: string, id: string, enabled: boolean) {
        const [row] = yield* withStorage(
          sql<SinkRow>`
            UPDATE notification_sinks
            SET enabled = ${enabled},
                expired_at = ${enabled ? sql`NULL` : sql`expired_at`}
            WHERE id = ${id} AND actor = ${actor}
            RETURNING ${columns}
          `,
        );
        if (row === undefined) return yield* notFound(id);
        return summaryOf(row);
      },
    );

    const removeSink = Effect.fn("NotifySettings.removeSink")(function* (
      actor: string,
      id: string,
    ) {
      const [row] = yield* withStorage(
        sql<SinkRow>`
          DELETE FROM notification_sinks WHERE id = ${id} AND actor = ${actor}
          RETURNING ${columns}
        `,
      );
      if (row === undefined) return yield* notFound(id);
      return summaryOf(row);
    });

    return { get, setKind, addSink, setSinkEnabled, removeSink };
  });

export const NotifySettingsLive = (options: NotifySettingsOptions) =>
  Layer.effect(
    NotifySettingsService,
    Effect.map(makeNotifySettings(options), NotifySettingsService.of),
  );

/**
 * The kinds the notifier wants this pass: `defaults` (`NOTIFY_TYPES`) with every stored toggle laid
 * over it.
 */
export const storedKinds = (
  defaults: ReadonlySet<NotificationKind>,
): Effect.Effect<
  ReadonlySet<NotificationKind>,
  NotifyStorageError,
  SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      readonly kind: string;
      readonly enabled: boolean;
    }>`SELECT kind, enabled FROM notification_kinds`.pipe(
      Effect.mapError(
        (cause) =>
          new NotifyStorageError({
            message: `read the kind toggles: ${String(cause)}`,
          }),
      ),
    );
    return new Set(
      NOTIFICATION_KINDS.filter((kind) => {
        const stored = rows.find((row) => row.kind === kind);
        return stored === undefined ? defaults.has(kind) : stored.enabled;
      }),
    );
  });

/** What a row this deployment cannot send to builds: nothing. */
const unsendable = Effect.succeed(Option.none<NotificationSink>());

/**
 * The sink a stored row names, or none when this deployment cannot send to it: its SMTP
 * server or VAPID key is gone, or the row no longer passes the destination checks. Web Push needs the
 * `HttpClient` the sink posts with.
 */
export const personalSinkOf = (
  channels: NotifyChannels,
): Effect.Effect<
  (row: {
    readonly type: string;
    readonly config: string;
  }) => Effect.Effect<Option.Option<NotificationSink>>,
  never,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return (row) => {
      if (row.type === "email") {
        const config = decodeEmail(row.config);
        if (
          channels.email === undefined ||
          config._tag === "None" ||
          !isEmailAddress(config.value.address)
        ) {
          return unsendable;
        }
        return Effect.succeed(
          Option.some(
            emailSink({
              transport: channels.email.transport,
              from: channels.email.from,
              to: config.value.address,
            }),
          ),
        );
      }
      const config = decodePush(row.config);
      if (
        channels.vapid === undefined ||
        config._tag === "None" ||
        subscriptionProblem(config.value, channels.allowInsecurePush) !==
          undefined
      ) {
        return unsendable;
      }
      return webPushSink({
        vapid: channels.vapid,
        subscription: config.value,
      }).pipe(
        Effect.map(Option.some),
        Effect.provideService(HttpClient.HttpClient, http),
      );
    };
  });

/**
 * Every enabled stored sink as a `NotificationSink`, by owner — what the notifier's `people` reads
 * each pass. A row `build` cannot make a sink of is left out and named in a log line.
 */
export const storedPeople = (
  build: (row: {
    readonly type: string;
    readonly config: string;
  }) => Effect.Effect<Option.Option<NotificationSink>>,
): Effect.Effect<PeopleSinks, NotifyStorageError, SqlClient> => {
  // The read runs every pass; a row that cannot be sent to is named once per process, not every poll.
  const warned = new Set<string>();
  return Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      readonly id: string;
      readonly actor: string;
      readonly type: string;
      readonly config: string;
    }>`
      SELECT id, actor, type, config::text AS config FROM notification_sinks
      WHERE enabled ORDER BY created_at, id
    `.pipe(
      Effect.mapError(
        (cause) =>
          new NotifyStorageError({
            message: `read the notification sinks: ${String(cause)}`,
          }),
      ),
    );
    const people = new Map<string, NotificationSink[]>();
    for (const row of rows) {
      const built = yield* build(row);
      if (Option.isNone(built)) {
        if (!warned.has(row.id)) {
          warned.add(row.id);
          yield* Effect.logWarning(
            `notify: sink ${row.id} of ${row.actor} (${row.type}) cannot be sent to by this control plane and is skipped`,
          );
        }
        continue;
      }
      warned.delete(row.id);
      people.set(row.actor, [...(people.get(row.actor) ?? []), built.value]);
    }
    return people;
  });
};

/**
 * A push service answered 404 or 410 for the ledger sink `sinkId` (`push:<fingerprint of the
 * endpoint>`): switch off every stored Web Push subscription with that endpoint and stamp when, so the
 * owner's routing falls back to their other sinks or the shared ones, and the settings page says the
 * subscription expired. Returns how many rows it switched off.
 */
export const expireWebPushSink = (
  sinkId: string,
): Effect.Effect<number, NotifyStorageError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      readonly id: string;
      readonly endpoint: string | null;
    }>`
      SELECT id, config->>'endpoint' AS endpoint FROM notification_sinks
      WHERE type = 'web_push' AND enabled
    `;
    const ids = rows
      .filter(
        (row) =>
          row.endpoint !== null && webPushSinkId(row.endpoint) === sinkId,
      )
      .map((row) => row.id);
    if (ids.length === 0) return 0;
    yield* sql`
      UPDATE notification_sinks SET enabled = FALSE, expired_at = now()
      WHERE id IN ${sql.in(ids)}
    `;
    yield* Effect.logWarning(
      `notify: the push service says ${ids.length} Web Push subscription(s) are gone; switched off`,
    );
    return ids.length;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new NotifyStorageError({
          message: `switch off a gone subscription: ${String(cause)}`,
        }),
    ),
  );
