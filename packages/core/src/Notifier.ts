/**
 * Notifications (S-notifications): a person is told when a run needs them, instead of finding out
 * by polling the attention page.
 *
 * **What is an event.** Five kinds, each read from a row the factory already keeps, never from a
 * stream only this process saw:
 *
 * - `question` — a card blocked `needs_input` (B7), as the attention view lists it (LOB-77). The
 *   event is the block: `question:<card>:<since>`, so a card blocked again later is a new event and
 *   the same block seen twice is one.
 * - `approval` — an undecided `session_approvals` row, on a card's run or on a session no card owns
 *   (LOB-271): `approval:<session>:<request>`.
 * - `gate` — a card whose run is done in a column whose exit crosses a human gate (B5), which is how
 *   a card that reached `review` (or a plan waiting in `planning`) asks for its person:
 *   `gate:<card>:<column>:<run>`.
 * - `failed` — a run that ended without an answer because it failed: a budget stop (LOB-163) or a
 *   model request Pi Durable gave up on, as the session's activity projection records it in
 *   `run_failures` (migration 0039): `failed:<session>:<entry>`.
 * - `spend` — an aggregate spend cap (S-aggregate-spend-caps) crossed 80% or reached 100% in its
 *   window, as the attention view lists it: `spend:<scope>:<subject>:<window>:<period>:<limit>:<threshold>`,
 *   so each threshold of each cap is told once per day or month, not once per run, and a cap raised
 *   mid-window is told afresh at its own thresholds.
 *
 * The first three, and `spend`, are the attention view itself (`TaskService.attention`, every board), so "what
 * needs a person" has one definition and the notifier cannot disagree with the page. A failure is
 * history rather than a standing condition, so it is read over a bounded lookback
 * (`failureLookbackMs`, a day by default): a notifier enabled today does not page anybody about last
 * month's failures, and a restart inside the day loses none.
 *
 * **Who is told (F21).** Each event is about a card, a session or both, and has an owner: the
 * actor that created the card, then the actor that started its run. An owner with a personal sink
 * (`options.people`: an email address, a Web Push subscription they added on the settings page) is
 * told there **only**; an event with no such owner goes to the shared sinks (`options.sinks`, the
 * environment's Slack and ntfy). The kinds are read each pass too (`options.kinds` may be an effect,
 * the settings page's stored toggles over `NOTIFY_TYPES`), so a toggle or a new sink needs no restart.
 * Routing is read every pass, but an event already delivered to a personal sink is not posted to the
 * shared channel because its owner then paused or removed that sink; a sink added later is sent the
 * owner's open events, as the shared channel's backlog is not theirs. A personal sink whose destination is gone (`gone`) is
 * disabled by `onGone`, and the owner falls back to their other sinks or the shared ones.
 *
 * **Retention (F22).** A delivered `notification_deliveries` row and a `run_failures` row older than
 * `retentionMs` (30 days) are deleted, at most once an hour on the poll — and so is an undelivered row
 * that can never be sent (out of attempts, or to a sink this process no longer sends to), but never a
 * row still pending, never one whose event is still open (a card parked on a question for six
 * weeks would be announced again the moment its row went), and never anything the failure lookback
 * still reads.
 *
 * **Exactly once per event and sink.** Every delivery is a `notification_deliveries` row keyed by
 * `(event id, sink id)`. A pass inserts the rows it has not seen (`ON CONFLICT DO NOTHING`), then
 * claims the undelivered ones and sends them; a sent one is stamped `delivered_at`. So a restart —
 * or a second replica polling the same database — that sees the same pending approval inserts
 * nothing and sends nothing, and a send that failed is retried once its claim is older than
 * `retryAfterMs`, up to `maxAttempts`. A row is claimed just before it is sent and each send is cut
 * off at `sendTimeoutMs` (under the retry interval), so a slow sink cannot hold a claim long enough
 * for a second replica to take it over and send it too; each sink is flushed on its own fiber, so a
 * sink that hangs delays only its own messages. A retry of an event that is no longer open — the
 * approval was decided, the question answered — while the sink was down is dropped, not sent, and a
 * kind turned off is not sent from the backlog either. The window that is *not* covered is a process
 * that dies between a sink accepting a message and the stamp: that message is sent again after the
 * retry interval. At-least-once, then, with the duplicate confined to a crash inside one HTTP call.
 *
 * A sink's id names its destination (`slack:<fingerprint>`, `ntfy:<fingerprint>`), never the
 * secret, so two processes configured with different destinations — a verify drive's loopback fake
 * beside a developer's real webhook, over one database — keep separate ledgers rather than one
 * claiming what the other should have sent.
 *
 * **Per-type settings.** `kinds` is the set a deployment wants (`NOTIFY_TYPES`); an event of any
 * other kind is not recorded at all, so turning a kind off suppresses it rather than queueing it.
 *
 * **Every message links to where the person acts**: the card's pane on its board (with the run that
 * asked, for an approval or a failure; at the thread, for a question), or the session for an
 * approval or a failure no card owns — the same targets the attention page links to.
 */
import { createHash } from "node:crypto";
import { Clock, Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { NOTIFICATION_KINDS, NotificationKind } from "@repo/domain/Notify";
import type { AttentionItem } from "@repo/domain/Task";
import { TaskService } from "./TaskService";

/** The kinds of event a person can be told about; `NOTIFY_TYPES` and the settings page pick among them. */
export { NOTIFICATION_KINDS, NotificationKind };

/** One message, as every sink receives it: what happened, in a line and a paragraph, and where to act. */
export type Notification = {
  readonly eventId: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly link: string;
};

/** A sink refused or could not be reached; the message says which and why, never the secret. */
export class NotifyError extends Schema.TaggedError<NotifyError>()(
  "NotifyError",
  {
    sink: Schema.String,
    message: Schema.String,
    /**
     * The sink said "slow down" (HTTP 429): the send is tried again after the retry interval without
     * spending one of its attempts, and the sink is sent nothing more this pass.
     */
    rateLimited: Schema.optional(Schema.Boolean),
    /**
     * The destination is permanently gone (a Web Push subscription the push service answered 404 or
     * 410 for): the delivery is not retried, and `onGone` is told so the sink stops being routed to.
     */
    gone: Schema.optional(Schema.Boolean),
  },
) {}

/** The ledger or the attention view could not be read or written. */
export class NotifyStorageError extends Schema.TaggedError<NotifyStorageError>()(
  "NotifyStorageError",
  { message: Schema.String },
) {}

/**
 * Where messages go. `id` keys the ledger and names the destination without its secret; `label` is
 * what a log line says.
 */
export type NotificationSink = {
  readonly id: string;
  readonly label: string;
  readonly send: (
    notification: Notification,
  ) => Effect.Effect<void, NotifyError>;
};

/** What one pass did: rows it recorded, deliveries it made, and sends that failed. */
export type NotifyPass = {
  readonly recorded: number;
  readonly delivered: number;
  readonly failed: number;
};

/** Personal sinks by the actor who owns them, as of this pass (`NotifySettings`' stored sinks). */
export type PeopleSinks = ReadonlyMap<string, ReadonlyArray<NotificationSink>>;

/** What one retention sweep deleted. */
export type NotifySweep = {
  readonly deliveries: number;
  readonly failures: number;
};

export type NotifierOptions = {
  /** The shared sinks: where an event with no owner who has a personal sink of their own goes. */
  readonly sinks: ReadonlyArray<NotificationSink>;
  /**
   * The kinds a deployment wants; any other kind is never recorded. An effect is read at the start
   * of every pass, which is how the settings page's toggle takes effect without a restart.
   */
  readonly kinds:
    | ReadonlySet<NotificationKind>
    | Effect.Effect<ReadonlySet<NotificationKind>, NotifyStorageError>;
  /**
   * Each person's own sinks, read at the start of every pass. Absent: nobody has any, and every
   * event goes to the shared sinks.
   */
  readonly people?: Effect.Effect<PeopleSinks, NotifyStorageError>;
  /**
   * Told when a sink reports its destination permanently gone (`NotifyError.gone`): the place to
   * disable the person's stored sink, so routing falls back to their other sinks or the shared ones.
   */
  readonly onGone?: (sinkId: string) => Effect.Effect<void, NotifyStorageError>;
  /**
   * How old a delivered ledger row or a recorded failure must be before the retention sweep deletes
   * it. Default 30 days, and never less than `failureLookbackMs`.
   */
  readonly retentionMs?: number;
  /** How often the sweep runs, at most. Default an hour; the first pass sweeps. */
  readonly sweepEveryMs?: number;
  /** The dashboard's origin, which every link starts with (`NOTIFY_LINK_BASE`). */
  readonly linkBase: string;
  /** How old a claim must be before a send that has not landed is tried again. Default a minute. */
  readonly retryAfterMs?: number;
  /** How many sends a delivery gets before it is left failed. Default 5. */
  readonly maxAttempts?: number;
  /** How far back a failed run is still news. Default a day. */
  readonly failureLookbackMs?: number;
  /**
   * How long one send may take before it counts as failed. Default ten seconds, and never more than
   * half of `retryAfterMs`, so a send still in flight is never re-claimed by another replica.
   */
  readonly sendTimeoutMs?: number;
};

const DEFAULT_RETRY_AFTER_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_FAILURE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_EVERY_MS = 60 * 60 * 1000;
/** Sends one pass makes to one sink at most; the next pass goes on with the rest. */
const MAX_SENDS_PER_PASS = 500;
/** Why a retry was dropped instead of sent: what it announced is no longer open. */
const SUPERSEDED =
  "superseded: the event was no longer open when it was retried";
/**
 * Whether a ledger sink id names a person's own destination (`email:`, `push:`) rather than a shared
 * channel (`slack:`, `ntfy:`). An event already delivered to a person's own sink is never posted to
 * the shared channel afterwards, whatever happens to that sink.
 */
const isPersonalSinkId = (id: string): boolean =>
  id.startsWith("email:") || id.startsWith("push:");
/** Ledger rows one insert writes at most. */
const INSERT_BATCH = 200;
/** A detail longer than this is cut: a notification is a pointer to the card, not the transcript. */
const DETAIL_CHARS = 500;

/**
 * Parse `NOTIFY_TYPES`: a comma-separated subset of the kinds. Blank means every kind; an unknown
 * name is refused with the names that exist, because a typo that silently turned a kind off is a
 * person who is never paged.
 */
export const parseNotifyKinds = (
  raw: string,
): Effect.Effect<ReadonlySet<NotificationKind>, NotifyError> => {
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) return Effect.succeed(new Set(NOTIFICATION_KINDS));
  const kinds = new Set<NotificationKind>();
  for (const name of names) {
    const kind = NOTIFICATION_KINDS.find((candidate) => candidate === name);
    if (kind === undefined) {
      return Effect.fail(
        new NotifyError({
          sink: "config",
          message: `NOTIFY_TYPES names ${JSON.stringify(name)}, which is not one of ${NOTIFICATION_KINDS.join(", ")}`,
        }),
      );
    }
    kinds.add(kind);
  }
  return Effect.succeed(kinds);
};

const clip = (text: string): string =>
  text.length <= DETAIL_CHARS ? text : `${text.slice(0, DETAIL_CHARS - 1)}…`;

const base = (linkBase: string): string => linkBase.replace(/\/+$/, "");

/** A card's pane on its board — the dashboard's own `/boards/$boardId?card=…` route. */
export const cardLink = (
  linkBase: string,
  card: {
    readonly boardId: string;
    readonly taskId: string;
    readonly run?: string;
    readonly thread?: boolean;
  },
): string =>
  `${base(linkBase)}/boards/${encodeURIComponent(card.boardId)}?card=${encodeURIComponent(card.taskId)}${
    card.run === undefined ? "" : `&run=${encodeURIComponent(card.run)}`
  }${card.thread === true ? "#thread" : ""}`;

/** A session's page — where an approval or a failure no card owns is acted on. */
export const sessionLink = (linkBase: string, sessionId: string): string =>
  `${base(linkBase)}/sessions/${encodeURIComponent(sessionId)}`;

const withRepo = (body: string, repo: string | undefined): string =>
  repo === undefined ? body : `${body}\n${repo}`;

/** The message an attention row becomes, keyed by the event it is (see the module comment). */
export const notificationOfAttention = (
  item: AttentionItem,
  linkBase: string,
): Notification | undefined => {
  const { task, reason } = item;
  switch (reason._tag) {
    case "approval": {
      const subject =
        task === undefined
          ? `session "${item.sessionTitle === undefined || item.sessionTitle === "" ? reason.sessionId : item.sessionTitle}"`
          : `"${task.title}"`;
      return {
        eventId: `approval:${reason.sessionId}:${reason.requestId}`,
        kind: "approval",
        title: `Approval needed on ${subject}`,
        body: withRepo(clip(`${reason.action}: ${reason.detail}`), item.repo),
        link:
          task === undefined
            ? sessionLink(linkBase, reason.sessionId)
            : cardLink(linkBase, {
                boardId: task.boardId,
                taskId: task.id,
                run: reason.sessionId,
              }),
      };
    }
    case "question":
      // The server lists a question only on a card; one without is not an event anyone can answer.
      if (task === undefined) return undefined;
      return {
        eventId: `question:${task.id}:${reason.since}`,
        kind: "question",
        title: `Question on "${task.title}"`,
        body: withRepo(
          clip(reason.question ?? "A run is blocked waiting for input."),
          item.repo,
        ),
        link: cardLink(linkBase, {
          boardId: task.boardId,
          taskId: task.id,
          thread: true,
        }),
      };
    case "review":
      // A review that requested changes (C21) is listed on the attention page, but is not one of
      // the notifier's kinds yet: `notification_deliveries.kind` admits these four (0039), and
      // GitHub already tells the PR's watchers of the review. A follow-up of C21.
      return undefined;
    case "spend": {
      const subject = `${reason.scope === "repo" ? "repository" : "actor"} ${reason.subject}`;
      const window = reason.window === "day" ? "daily" : "monthly";
      return {
        eventId: `spend:${reason.scope}:${reason.subject}:${reason.window}:${reason.resetsAt}:${reason.limit}:${reason.threshold}`,
        kind: "spend",
        title:
          reason.threshold >= 100
            ? `Spend cap reached for ${subject}`
            : `Spend at ${reason.threshold}% of the ${window} cap for ${subject}`,
        body: clip(
          reason.threshold >= 100
            ? `$${reason.spent.toFixed(2)} of its $${reason.limit.toFixed(2)} ${window} cap: new runs are refused until ${reason.resetsAt} or the cap is raised.`
            : `$${reason.spent.toFixed(2)} of its $${reason.limit.toFixed(2)} ${window} cap; new runs are refused once it is reached, until ${reason.resetsAt}.`,
        ),
        link: `${base(linkBase)}/spend`,
      };
    }
    case "gate":
      if (task === undefined) return undefined;
      return {
        eventId: `gate:${task.id}:${task.column}:${reason.sessionId}`,
        kind: "gate",
        title: `"${task.title}" waits at ${reason.gate}`,
        body: withRepo(
          `Its run in ${task.column} is done; moving it to ${reason.to} needs a person.`,
          item.repo,
        ),
        link: cardLink(linkBase, {
          boardId: task.boardId,
          taskId: task.id,
          run: reason.sessionId,
        }),
      };
  }
};

/** One `run_failures` row, joined to its session and to the card that owns the run, if one does. */
export type RunFailure = {
  readonly sessionId: string;
  readonly entryId: string;
  readonly reason: "budget" | "model_error";
  readonly detail: string;
  readonly sessionTitle: string;
  readonly repo: string | undefined;
  readonly card:
    | {
        readonly taskId: string;
        readonly boardId: string;
        readonly title: string;
      }
    | undefined;
};

/** The message a failed run becomes. */
export const notificationOfFailure = (
  failure: RunFailure,
  linkBase: string,
): Notification => {
  const subject =
    failure.card !== undefined
      ? `"${failure.card.title}"`
      : `session "${failure.sessionTitle === "" ? failure.sessionId : failure.sessionTitle}"`;
  return {
    eventId: `failed:${failure.sessionId}:${failure.entryId}`,
    kind: "failed",
    title:
      failure.reason === "budget"
        ? `Run stopped by its budget on ${subject}`
        : `Run failed on ${subject}`,
    body: withRepo(clip(failure.detail), failure.repo),
    link:
      failure.card === undefined
        ? sessionLink(linkBase, failure.sessionId)
        : cardLink(linkBase, {
            boardId: failure.card.boardId,
            taskId: failure.card.taskId,
            run: failure.sessionId,
          }),
  };
};

/** What an event is about, which is how its owner is found: the card, the run, or both. */
export type EventSubject = {
  readonly taskId?: string;
  readonly sessionId?: string;
};

/** The card and run an attention row is about. */
export const subjectOfAttention = (item: AttentionItem): EventSubject => {
  const taskId = item.task?.id;
  const sessionId =
    item.reason._tag === "approval" || item.reason._tag === "gate"
      ? item.reason.sessionId
      : undefined;
  return {
    ...(taskId === undefined ? {} : { taskId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
};

/** The run, and the card that owns it if one does, that a failure is about. */
export const subjectOfFailure = (failure: RunFailure): EventSubject => ({
  sessionId: failure.sessionId,
  ...(failure.card === undefined ? {} : { taskId: failure.card.taskId }),
});

/** A short, stable, one-way name for a destination: the ledger key must not carry the secret. */
const fingerprint = (destination: string): string =>
  createHash("sha256").update(destination).digest("hex").slice(0, 16);

/** Slack's three control characters, escaped as its message formatting requires. */
const slackEscape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The body a Slack incoming webhook takes: one `text` in Slack's mrkdwn, the title bold and the
 * link as `<url|label>`.
 */
export const slackWebhookBody = (
  notification: Notification,
): { readonly text: string } => ({
  text: `*${slackEscape(notification.title)}*\n${slackEscape(notification.body)}\n<${notification.link}|Open in factory>`,
});

/** The JSON ntfy publishes from (`POST /` on the server, the topic in the body). */
export const ntfyBody = (
  notification: Notification,
  topic: string,
): {
  readonly topic: string;
  readonly title: string;
  readonly message: string;
  readonly click: string;
  readonly tags: ReadonlyArray<string>;
} => ({
  topic,
  title: notification.title,
  message: notification.body,
  click: notification.link,
  tags: ["factory", notification.kind],
});

const postJson = (
  sink: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return (what: string): Effect.Effect<void, NotifyError> =>
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(url, { headers }).pipe(
          HttpClientRequest.bodyJson(body),
          Effect.mapError(
            () =>
              new NotifyError({
                sink,
                message: `${what}: the body could not be encoded`,
              }),
          ),
        );
        const response = yield* http.execute(request).pipe(
          Effect.mapError(
            () =>
              new NotifyError({
                sink,
                message: `${what}: the sink could not be reached`,
              }),
          ),
        );
        if (response.status < 200 || response.status > 299) {
          return yield* new NotifyError({
            sink,
            message: `${what}: the sink answered HTTP ${response.status}`,
            ...(response.status === 429 ? { rateLimited: true } : {}),
          });
        }
      });
  });

/**
 * A Slack incoming webhook (`NOTIFY_SLACK_WEBHOOK_URL`): one `POST` of `{text}` per message, and any
 * `2xx` is accepted. The URL is the credential — Slack's webhook has no other — so it stays
 * `Redacted` and only its fingerprint reaches the ledger and the logs.
 */
export const slackWebhookSink = (
  url: Redacted.Redacted<string>,
): Effect.Effect<NotificationSink, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const id = `slack:${fingerprint(Redacted.value(url))}`;
    return {
      id,
      label: "a Slack incoming webhook",
      send: (notification) =>
        postJson(id, Redacted.value(url), slackWebhookBody(notification)).pipe(
          Effect.flatMap((post) => post(notification.eventId)),
          Effect.provideService(HttpClient.HttpClient, http),
        ),
    };
  });

/**
 * An ntfy topic (`NOTIFY_NTFY_URL` + `NOTIFY_NTFY_TOPIC`, and `NOTIFY_NTFY_TOKEN` for a protected
 * one): a JSON publish to the server's root, which is how ntfy takes a title, a click target and
 * tags without header encoding. The phone app is the push: this is the mobile path without a native
 * app. A topic name on a public server is as good as a password, so it is fingerprinted like the
 * Slack URL rather than logged.
 */
export const ntfySink = (config: {
  readonly url: string;
  readonly topic: Redacted.Redacted<string>;
  readonly token?: Redacted.Redacted<string>;
}): Effect.Effect<NotificationSink, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const server = config.url.replace(/\/+$/, "");
    const id = `ntfy:${fingerprint(`${server}/${Redacted.value(config.topic)}`)}`;
    const token = config.token;
    return {
      id,
      label: `ntfy at ${server}`,
      send: (notification) =>
        postJson(
          id,
          `${server}/`,
          ntfyBody(notification, Redacted.value(config.topic)),
          token === undefined
            ? {}
            : { authorization: `Bearer ${Redacted.value(token)}` },
        ).pipe(
          Effect.flatMap((post) => post(notification.eventId)),
          Effect.provideService(HttpClient.HttpClient, http),
        ),
    };
  });

type FailureRow = {
  readonly sessionId: string;
  readonly entryId: string;
  readonly reason: string;
  readonly detail: string;
  readonly sessionTitle: string;
  readonly sessionRepo: string | null;
  readonly taskId: string | null;
  readonly boardId: string | null;
  readonly taskTitle: string | null;
};

type ClaimedRow = {
  readonly eventId: string;
  readonly sink: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly link: string;
  /** The attempts after this claim: `1` is the first send. */
  readonly attempts: number;
};

const decodeKind = Schema.decodeUnknownEffect(NotificationKind);

/**
 * The notifier over one database: `events` is what needs a person right now (filtered to the kinds
 * the deployment wants), and `pass` records the ones not seen yet and delivers what is pending.
 * Needs the attention view (`TaskService`) and the ledger (`SqlClient`).
 */
export const makeNotifier = (options: NotifierOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tasks = yield* TaskService;
    const retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const lookbackMs = options.failureLookbackMs ?? DEFAULT_FAILURE_LOOKBACK_MS;
    const sendTimeoutMs = Math.max(
      1,
      Math.min(
        options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
        retryAfterMs > 0 ? retryAfterMs / 2 : Number.POSITIVE_INFINITY,
      ),
    );
    const retentionMs = Math.max(
      options.retentionMs ?? DEFAULT_RETENTION_MS,
      lookbackMs,
    );
    const sweepEveryMs = options.sweepEveryMs ?? DEFAULT_SWEEP_EVERY_MS;
    const sinks = new Map(options.sinks.map((sink) => [sink.id, sink]));
    const wantedKinds: Effect.Effect<
      ReadonlySet<NotificationKind>,
      NotifyStorageError
    > = Effect.isEffect(options.kinds)
      ? options.kinds
      : Effect.succeed(options.kinds);
    const people: Effect.Effect<PeopleSinks, NotifyStorageError> =
      options.people ?? Effect.succeed(new Map());
    let lastSweepAt = Number.NEGATIVE_INFINITY;

    const storage = <A, E>(
      what: string,
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, NotifyStorageError> =>
      Effect.mapError(
        effect,
        (cause) =>
          new NotifyStorageError({ message: `${what}: ${String(cause)}` }),
      );

    const failures = storage(
      "read run failures",
      sql<FailureRow>`
        SELECT rf.session_id, rf.entry_id, rf.reason, rf.detail,
               s.title AS session_title, s.repo AS session_repo,
               t.id AS task_id, t.board_id, t.title AS task_title
        FROM run_failures rf
        JOIN sessions s ON s.id = rf.session_id
        LEFT JOIN task_runs tr ON tr.session_id = rf.session_id
        LEFT JOIN tasks t ON t.id = tr.task_id
        WHERE rf.failed_at > now() - make_interval(secs => ${lookbackMs / 1000})
        ORDER BY rf.failed_at, rf.session_id, rf.entry_id
      `,
    ).pipe(
      Effect.map((rows) =>
        rows.map((row): RunFailure => ({
          sessionId: row.sessionId,
          entryId: row.entryId,
          reason: row.reason === "budget" ? "budget" : "model_error",
          detail: row.detail,
          sessionTitle: row.sessionTitle,
          repo: row.sessionRepo ?? undefined,
          card:
            row.taskId === null || row.boardId === null
              ? undefined
              : {
                  taskId: row.taskId,
                  boardId: row.boardId,
                  title: row.taskTitle ?? "",
                },
        })),
      ),
    );

    /**
     * What needs a person now, of every kind, as messages with what each is about: the attention
     * view's order and then the failures'. Kinds are filtered by the caller, because the retention
     * sweep needs to know every open event, wanted or not.
     */
    const readEvents: Effect.Effect<
      ReadonlyArray<{
        readonly notification: Notification;
        readonly subject: EventSubject;
      }>,
      NotifyStorageError
    > = Effect.gen(function* () {
      const attention = yield* storage(
        "read the attention view",
        tasks.attention(undefined),
      );
      const fromAttention = attention.flatMap((item) => {
        const notification = notificationOfAttention(item, options.linkBase);
        return notification === undefined
          ? []
          : [{ notification, subject: subjectOfAttention(item) }];
      });
      const fromFailures = (yield* failures).map((failure) => ({
        notification: notificationOfFailure(failure, options.linkBase),
        subject: subjectOfFailure(failure),
      }));
      return [...fromAttention, ...fromFailures];
    });

    /** What needs a person now and is of a kind the deployment wants. */
    const events: Effect.Effect<
      ReadonlyArray<Notification>,
      NotifyStorageError
    > = Effect.gen(function* () {
      const kinds = yield* wantedKinds;
      return (yield* readEvents)
        .map((event) => event.notification)
        .filter((notification) => kinds.has(notification.kind));
    });

    /**
     * Who owns each event, as the actors to try in order. A card's owner is the actor that created
     * it, then the actor that started the run the event is about; an event on a session no card
     * owns has only the second. Two reads, one per kind of subject.
     */
    const ownersOf = (
      subjects: ReadonlyArray<EventSubject>,
    ): Effect.Effect<
      (subject: EventSubject) => ReadonlyArray<string>,
      NotifyStorageError
    > =>
      Effect.gen(function* () {
        const taskIds = [
          ...new Set(subjects.flatMap((s) => (s.taskId ? [s.taskId] : []))),
        ];
        const sessionIds = [
          ...new Set(
            subjects.flatMap((s) => (s.sessionId ? [s.sessionId] : [])),
          ),
        ];
        const creators = new Map<string, string>();
        const starters = new Map<string, string>();
        if (taskIds.length > 0) {
          const rows = yield* storage(
            "read the cards' creators",
            sql<{ readonly taskId: string; readonly actor: string }>`
              SELECT task_id, actor FROM task_events
              WHERE kind = 'created' AND task_id IN ${sql.in(taskIds)}
            `,
          );
          for (const row of rows) creators.set(row.taskId, row.actor);
        }
        if (sessionIds.length > 0) {
          const rows = yield* storage(
            "read the runs' actors",
            sql<{ readonly id: string; readonly actor: string | null }>`
              SELECT id, actor FROM sessions
              WHERE actor IS NOT NULL AND id IN ${sql.in(sessionIds)}
            `,
          );
          for (const row of rows) {
            if (row.actor !== null) starters.set(row.id, row.actor);
          }
        }
        return (subject) =>
          [
            ...(subject.taskId === undefined
              ? []
              : [creators.get(subject.taskId)]),
            ...(subject.sessionId === undefined
              ? []
              : [starters.get(subject.sessionId)]),
          ].flatMap((actor) => (actor === undefined ? [] : [actor]));
      });

    /**
     * The sinks an event goes to: the first of its owners who has a personal sink — all of that
     * person's, and nobody else's — else the shared sinks.
     */
    const routeOf = (
      owners: ReadonlyArray<string>,
      personal: PeopleSinks,
    ): ReadonlyArray<NotificationSink> => {
      for (const owner of owners) {
        const own = personal.get(owner);
        if (own !== undefined && own.length > 0) return own;
      }
      return [...sinks.values()];
    };

    /** Insert a ledger row for every event and sink that has none; returns how many it inserted. */
    const record = (
      routed: ReadonlyArray<{
        readonly notification: Notification;
        readonly to: ReadonlyArray<NotificationSink>;
      }>,
    ): Effect.Effect<number, NotifyStorageError> =>
      Effect.gen(function* () {
        const notifications = routed
          .filter((event) => event.to.length > 0)
          .map((event) => event.notification);
        if (notifications.length === 0) return 0;
        const seen = yield* storage(
          "read the ledger",
          sql<{
            readonly eventId: string;
            readonly sink: string;
            readonly delivered: boolean;
          }>`
            SELECT event_id, sink, delivered_at IS NOT NULL AS delivered
            FROM notification_deliveries
            WHERE event_id IN ${sql.in(notifications.map((n) => n.eventId))}
          `,
        );
        const have = new Set(
          seen.map((row) => `${row.sink}\u0000${row.eventId}`),
        );
        // Events a person was already told of on their own sink.
        const toldPersonally = new Set(
          seen.flatMap((row) =>
            row.delivered && isPersonalSinkId(row.sink) ? [row.eventId] : [],
          ),
        );
        const missing = routed.flatMap(({ notification, to }) =>
          [...new Set(to.map((sink) => sink.id))].flatMap((sink) =>
            have.has(`${sink}\u0000${notification.eventId}`) ||
            // Routing is read every pass, so a person who pauses or removes their sink must not
            // have what they were already told posted to the shared channel as the fallback.
            (!isPersonalSinkId(sink) &&
              toldPersonally.has(notification.eventId))
              ? []
              : [
                  {
                    eventId: notification.eventId,
                    sink,
                    kind: notification.kind,
                    title: notification.title,
                    body: notification.body,
                    link: notification.link,
                  },
                ],
          ),
        );
        let recorded = 0;
        for (let at = 0; at < missing.length; at += INSERT_BATCH) {
          const inserted = yield* storage(
            "record deliveries",
            sql<{ readonly eventId: string }>`
              INSERT INTO notification_deliveries
              ${sql.insert(missing.slice(at, at + INSERT_BATCH))}
              ON CONFLICT (event_id, sink) DO NOTHING
              RETURNING event_id
            `,
          );
          recorded += inserted.length;
        }
        return recorded;
      });

    /**
     * Claim this sink's oldest pending delivery — never claimed, or claimed longer than
     * `retryAfterMs` ago, short of `maxAttempts`, of a kind the deployment still wants, and not tried
     * yet this pass — stamping the claim as it takes it. `SKIP LOCKED` keeps two replicas' passes
     * from claiming one row at once.
     */
    const claimOne = (
      sink: string,
      kinds: ReadonlyArray<NotificationKind>,
      tried: ReadonlyArray<string>,
    ): Effect.Effect<ClaimedRow | undefined, NotifyStorageError> =>
      storage(
        "claim a delivery",
        sql<ClaimedRow>`
          UPDATE notification_deliveries d
          SET claimed_at = now(), attempts = d.attempts + 1
          FROM (
            SELECT event_id, sink FROM notification_deliveries
            WHERE delivered_at IS NULL
              AND sink = ${sink}
              AND kind IN ${sql.in(kinds)}
              AND attempts < ${maxAttempts}
              AND (claimed_at IS NULL
                   OR claimed_at < now() - make_interval(secs => ${retryAfterMs / 1000}))
              ${tried.length === 0 ? sql`` : sql`AND event_id NOT IN ${sql.in(tried)}`}
            ORDER BY created_at, event_id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          ) p
          WHERE d.event_id = p.event_id AND d.sink = p.sink
          RETURNING d.event_id, d.sink, d.kind, d.title, d.body, d.link, d.attempts
        `,
      ).pipe(Effect.map((rows) => rows[0]));

    /** The send, cut off at `sendTimeoutMs`: a sink that never answers is a failed send. */
    const sendBounded = (
      sink: NotificationSink,
      notification: Notification,
    ): Effect.Effect<void, NotifyError> =>
      sink.send(notification).pipe(
        Effect.timeoutOrElse({
          duration: sendTimeoutMs,
          orElse: () =>
            Effect.fail(
              new NotifyError({
                sink: sink.id,
                message: `${notification.eventId}: the sink did not answer within ${sendTimeoutMs}ms`,
              }),
            ),
        }),
      );

    /**
     * Send what is pending for one sink, one claimed row at a time, until nothing is left to claim,
     * the sink says it is rate-limited, or the pass's bound is reached. `open` is the pass's events:
     * a retry of one no longer among them is dropped rather than sent. A first attempt is always
     * sent — another replica may have recorded an event newer than this pass's read.
     */
    const flushSink = (
      sink: NotificationSink,
      kinds: ReadonlyArray<NotificationKind>,
      open: ReadonlySet<string>,
    ): Effect.Effect<
      { readonly delivered: number; readonly failed: number },
      NotifyStorageError
    > =>
      Effect.gen(function* () {
        let delivered = 0;
        let failed = 0;
        // With every kind turned off nothing is wanted, and an empty `IN ()` is not SQL.
        if (kinds.length === 0) return { delivered, failed };
        const tried: string[] = [];
        while (tried.length < MAX_SENDS_PER_PASS) {
          const row = yield* claimOne(sink.id, kinds, tried);
          if (row === undefined) break;
          tried.push(row.eventId);
          if (row.attempts > 1 && !open.has(row.eventId)) {
            yield* storage(
              "drop a superseded delivery",
              sql`
                UPDATE notification_deliveries
                SET attempts = GREATEST(attempts, ${maxAttempts}), last_error = ${SUPERSEDED}
                WHERE event_id = ${row.eventId} AND sink = ${row.sink}
              `,
            );
            yield* Effect.logInfo(
              `notify: ${row.kind} ${row.eventId} not retried to ${sink.label}: ${SUPERSEDED}`,
            );
            continue;
          }
          const kind = yield* storage(
            "decode a delivery",
            decodeKind(row.kind),
          );
          const sent = yield* Effect.result(
            sendBounded(sink, {
              eventId: row.eventId,
              kind,
              title: row.title,
              body: row.body,
              link: row.link,
            }),
          );
          if (sent._tag === "Success") {
            delivered += 1;
            yield* storage(
              "stamp a delivery",
              sql`
                UPDATE notification_deliveries
                SET delivered_at = now(), last_error = NULL
                WHERE event_id = ${row.eventId} AND sink = ${row.sink}
              `,
            );
            yield* Effect.logInfo(
              `notify: ${row.kind} ${row.eventId} sent to ${sink.label}`,
            );
            continue;
          }
          failed += 1;
          const message = sent.failure.message;
          const rateLimited = sent.failure.rateLimited === true;
          const gone = sent.failure.gone === true;
          // A rate-limited send gives its attempt back: being told to wait is not the send failing.
          // A destination that is gone is never retried: the delivery is spent at once.
          yield* storage(
            "record a failed delivery",
            sql`
              UPDATE notification_deliveries
              SET last_error = ${message},
                  attempts = ${
                    rateLimited
                      ? sql`GREATEST(attempts - 1, 0)`
                      : gone
                        ? sql`GREATEST(attempts, ${maxAttempts})`
                        : sql`attempts`
                  }
              WHERE event_id = ${row.eventId} AND sink = ${row.sink}
            `,
          );
          yield* Effect.logWarning(
            `notify: ${row.kind} ${row.eventId} not sent to ${sink.label}: ${message}`,
          );
          if (gone) {
            // The rest of this sink's backlog is spent with it, and the owner's routing moves on.
            yield* storage(
              "spend a gone sink's deliveries",
              sql`
                UPDATE notification_deliveries
                SET attempts = GREATEST(attempts, ${maxAttempts}),
                    last_error = COALESCE(last_error, ${message})
                WHERE sink = ${sink.id} AND delivered_at IS NULL
              `,
            );
            if (options.onGone !== undefined) yield* options.onGone(sink.id);
            break;
          }
          if (rateLimited) break;
        }
        return { delivered, failed };
      });

    /** Flush every sink on its own fiber, so one that hangs delays nobody else's messages. */
    const flush = (
      every: ReadonlyArray<NotificationSink>,
      kinds: ReadonlyArray<NotificationKind>,
      open: ReadonlySet<string>,
    ): Effect.Effect<
      { readonly delivered: number; readonly failed: number },
      NotifyStorageError
    > =>
      Effect.forEach(every, (sink) => flushSink(sink, kinds, open), {
        concurrency: "unbounded",
      }).pipe(
        Effect.map((results) =>
          results.reduce(
            (total, result) => ({
              delivered: total.delivered + result.delivered,
              failed: total.failed + result.failed,
            }),
            { delivered: 0, failed: 0 },
          ),
        ),
      );

    /**
     * Delete what retention allows (F22): delivered ledger rows and recorded failures older than
     * `retentionMs`, except a delivered row whose event is still open — `every` is every event of
     * any kind that needs a person now, so a kind switched off for a while does not lose its
     * memory — and never an undelivered row. Ledger first: a failure's row outlives its
     * delivery's, so the failure is never read again after the row that remembers it is gone.
     */
    const sweepWith = (
      every: ReadonlyArray<{ readonly notification: Notification }>,
      known: ReadonlyArray<string>,
    ): Effect.Effect<NotifySweep, NotifyStorageError> =>
      Effect.gen(function* () {
        lastSweepAt = yield* Clock.currentTimeMillis;
        const ids = every.map((event) => event.notification.eventId);
        const deliveries = yield* storage(
          "prune delivered notifications",
          sql<{ readonly eventId: string }>`
            DELETE FROM notification_deliveries
            WHERE delivered_at IS NOT NULL
              AND delivered_at < now() - make_interval(secs => ${retentionMs / 1000})
              ${ids.length === 0 ? sql`` : sql`AND event_id NOT IN ${sql.in(ids)}`}
            RETURNING event_id
          `,
        );
        // A delivery that will never be sent — out of attempts (a destination that is gone, a
        // rejected address, one given up as superseded), or to a sink nothing sends to any more —
        // is as dead as a delivered one, and an owner's failing sink would otherwise grow the table
        // by one row per event forever. A row still pending (attempts left, its sink live) is never
        // touched, and neither is one for an event that is still open: it would be recorded again.
        const dead = yield* storage(
          "prune undeliverable notifications",
          sql<{ readonly eventId: string }>`
            DELETE FROM notification_deliveries
            WHERE delivered_at IS NULL
              AND created_at < now() - make_interval(secs => ${retentionMs / 1000})
              AND (attempts >= ${maxAttempts}
                   ${known.length === 0 ? sql`OR TRUE` : sql`OR sink NOT IN ${sql.in(known)}`})
              ${ids.length === 0 ? sql`` : sql`AND event_id NOT IN ${sql.in(ids)}`}
            RETURNING event_id
          `,
        );
        const failedRuns = yield* storage(
          "prune run failures",
          sql<{ readonly sessionId: string }>`
            DELETE FROM run_failures
            WHERE failed_at < now() - make_interval(secs => ${retentionMs / 1000})
            RETURNING session_id
          `,
        );
        const swept = {
          deliveries: deliveries.length + dead.length,
          failures: failedRuns.length,
        };
        if (swept.deliveries > 0 || swept.failures > 0) {
          yield* Effect.logInfo(
            `notify: pruned ${swept.deliveries} delivered notifications and ${swept.failures} run failures older than ${Math.round(retentionMs / 86_400_000)} days`,
          );
        }
        return swept;
      });

    /** The retention sweep, now, whether or not it is due. */
    const sweep: Effect.Effect<NotifySweep, NotifyStorageError> = Effect.gen(
      function* () {
        const every = yield* readEvents;
        const personal = yield* people;
        return yield* sweepWith(every, sinkIdsOf(personal));
      },
    );

    /** Every sink this process sends to as of this pass, by id: shared, then each person's. */
    const sinkIdsOf = (personal: PeopleSinks): ReadonlyArray<string> => [
      ...new Set([
        ...sinks.keys(),
        ...[...personal.values()].flat().map((sink) => sink.id),
      ]),
    ];

    const pass: Effect.Effect<NotifyPass, NotifyStorageError> = Effect.gen(
      function* () {
        const kinds = yield* wantedKinds;
        const personal = yield* people;
        // One mailbox two people share is one sink (its id is its destination's), flushed once.
        const everySink = [
          ...new Map(
            [...sinks.values(), ...[...personal.values()].flat()].map(
              (sink) => [sink.id, sink],
            ),
          ).values(),
        ];
        const sweepDue =
          (yield* Clock.currentTimeMillis) - lastSweepAt >= sweepEveryMs;
        // Nobody to tell and nothing to prune: the attention view is not even read.
        if (everySink.length === 0 && !sweepDue) {
          return { recorded: 0, delivered: 0, failed: 0 };
        }
        const every = yield* readEvents;
        const wanted = every.filter((event) =>
          kinds.has(event.notification.kind),
        );
        const owners = yield* ownersOf(wanted.map((event) => event.subject));
        const recorded = yield* record(
          wanted.map((event) => ({
            notification: event.notification,
            to: routeOf(owners(event.subject), personal),
          })),
        );
        const { delivered, failed } = yield* flush(
          everySink,
          [...kinds],
          new Set(wanted.map((event) => event.notification.eventId)),
        );
        if (sweepDue) yield* sweepWith(every, sinkIdsOf(personal));
        return { recorded, delivered, failed };
      },
    );

    return { events, pass, sweep };
  });

/**
 * Poll forever: one pass every `everyMs`, its failures logged and the next pass tried — a database
 * that is down for a minute delays a notification, it does not stop the notifier.
 */
export const runNotifier = (
  notifier: {
    readonly pass: Effect.Effect<NotifyPass, NotifyStorageError>;
  },
  everyMs: number,
): Effect.Effect<void> =>
  notifier.pass.pipe(
    Effect.catch((error) =>
      Effect.logWarning(`notify: a pass stopped: ${error.message}`).pipe(
        Effect.as(undefined),
      ),
    ),
    Effect.repeat(Schedule.spaced(everyMs)),
    Effect.asVoid,
  );
