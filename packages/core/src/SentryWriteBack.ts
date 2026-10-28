/**
 * The Sentry link-back (LOB-83, part 3 of LOB-33): the alert points at the session investigating it,
 * once.
 *
 * `Sentry.ts` only receives. This is the one outbound call the Sentry adapter makes: a note on the
 * alert's Sentry *issue* naming the session, through Sentry's REST API over the Effect `HttpClient`
 * every other control-plane client uses, so a fake needs no interception library.
 *
 * **The address is the issue, not the event.** An alert's `TriggerEvent.key` is its `event_id`, the
 * delivery's idempotency key; the note belongs on the issue every event of that alert shares, which
 * the adapter carries as `TriggerEvent.address` (`data.event.issue_id`). An alert with no
 * `issue_id` has nowhere to be answered, and the write-back says so in the log rather than guessing
 * an address from the prompt body.
 *
 * **Exactly once is a read before a post, keyed per session.** The seam calls the write-back after
 * the session is opened and *before* the delivery is marked processed, so a crash, or a failed
 * `processed` write, between the two gives the claim back and the retry calls `write` again. The
 * write-back therefore lists the issue's notes first and posts only when none names the session —
 * the check `JiraWriteBack` makes, and the one that also makes LOB-82's fingerprint binding safe: a
 * later alert routed to the same session finds the note and adds none. A *different* session for the
 * same issue (the first one was released) is a different id and gets its own note.
 *
 * **Best effort, as Linear's is.** A failed or slow call is logged — the issue id, the session id and
 * the cause on one line — and never the delivery's failure. A failed delivery gives its claim back,
 * so the sender's retry would send the session's prompt again, and a permanent failure (a token
 * without the scope, an issue deleted since) would make that every time. The note is a pointer, not
 * the product: the session runs either way, and no retry queue is added because the read-before-post
 * check is what makes any later attempt safe. The whole write runs under one time budget, so a
 * Sentry that accepts the connection and never answers cannot hold the delivery's response.
 *
 * What the REST routes are and what no fake can prove about them is
 * `docs/testing-third-parties.md`'s Sentry REST row.
 */
import { Duration, Effect, Layer, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import type { SessionId } from "@repo/domain/Session";
import { TriggerError } from "@repo/domain/Trigger";
import { TriggerWriteBack } from "./TriggerService";

/** Sentry's SaaS, where a deployment with no `SENTRY_API_URL` is assumed to be. */
export const SENTRY_DEFAULT_API_URL = "https://sentry.io";

/**
 * How long the whole link-back — the read and the post — may take before the delivery goes on
 * without it. The route answers after this runs, and Sentry's own delivery budget is one second
 * (`docs/testing-third-parties.md`), so a slow Sentry API outlives it: that is deliberate. The
 * delivery is still processed, and the sender that gave up and re-sent is answered by the dedupe,
 * so a late answer costs nothing but a repeat. The budget only keeps a silent API from holding the
 * route open indefinitely; a note that misses it is not retried, and a redelivery is what the
 * read-before-post check makes safe.
 */
export const SENTRY_LINK_BACK_BUDGET: Duration.Input = "4 seconds";

/** Where the write-back posts, and who it authenticates as. */
export type SentryApiConfig = {
  /** The API root, with no trailing slash: `https://sentry.io`, or a self-hosted install. */
  readonly baseUrl: string;
  /** An internal integration's token, with the scope to write issue comments. */
  readonly authToken: Redacted.Redacted<string>;
  /**
   * Where a reader finds the session, so the note links to it. Absent means the note names the
   * session id alone — a deployment with no dashboard still leaves a trace it can search.
   */
  readonly sessionUrlBase?: string;
  /** The whole link-back's budget; defaults to `SENTRY_LINK_BACK_BUDGET`. */
  readonly budget?: Duration.Input;
};

/** The environment a deployment configures the write-back with. */
export type SentryApiEnv = {
  readonly apiUrl: string | undefined;
  readonly authToken: string | undefined;
  readonly sessionUrlBase: string | undefined;
};

/**
 * A config from environment-shaped values, or `undefined` when the deployment configured none.
 *
 * The token is what switches it on: with none there is no Sentry write-back, and the receiver goes
 * on starting sessions and writing nothing back. A blank URL is the SaaS default, not an error.
 */
export const sentryApiConfigFromEnv = (
  env: SentryApiEnv,
): SentryApiConfig | undefined => {
  const authToken = env.authToken?.trim();
  if (!authToken) return undefined;
  const baseUrl = env.apiUrl?.trim() || SENTRY_DEFAULT_API_URL;
  const sessionUrlBase = env.sessionUrlBase?.trim();
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    authToken: Redacted.make(authToken),
    ...(sessionUrlBase ? { sessionUrlBase } : {}),
  };
};

/** The note's text: it names the session, and links to it when the deployment knows where. */
export const sentryNote = (
  config: Pick<SentryApiConfig, "sessionUrlBase">,
  sessionId: SessionId,
): string => {
  const link =
    config.sessionUrlBase === undefined
      ? ""
      : ` (${config.sessionUrlBase.replace(/\/+$/, "")}/${sessionId})`;
  return `Factory is investigating this alert in session ${sessionId}${link}.`;
};

/**
 * One page of an issue's notes, as `GET /api/0/issues/{issue_id}/comments/` answers it: the
 * activities of type `note`, newest first, each with its text under `data`. Only the text is read,
 * so a field Sentry adds is not a failure; an answer that is not a list is one, and nothing is
 * posted on a read that could not be understood.
 */
const SentryNotes = Schema.Array(
  Schema.Struct({
    data: Schema.optional(
      Schema.Struct({ text: Schema.optional(Schema.String) }),
    ),
  }),
);

/**
 * The seam's write-back port, filled by Sentry's issue-notes API.
 *
 * `GET` then `POST /api/0/issues/{issue_id}/comments/` with a bearer token and `{"text": …}`; Sentry
 * answers the create `201`. Anything but a 2xx, an unreachable API or an answer that cannot be read
 * is a `write-back` `TriggerError` inside, which the outside catches and logs.
 */
export const SentryWriteBack = (
  config: SentryApiConfig,
): Layer.Layer<TriggerWriteBack, never, HttpClient.HttpClient> =>
  Layer.effect(
    TriggerWriteBack,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const budget = config.budget ?? SENTRY_LINK_BACK_BUDGET;
      const headers = {
        authorization: `Bearer ${Redacted.value(config.authToken)}`,
        accept: "application/json",
      };
      const fail = (message: string): TriggerError =>
        new TriggerError({ code: "write-back", message });
      /** Why a request produced no answer: the client error's reason, so a log line can tell a refused connection from a reset one. */
      const why = (error: HttpClientError.HttpClientError): string =>
        `${error.reason._tag}${error.message ? `: ${error.message}` : ""}`;
      const notesUrl = (issueId: string): string =>
        `${config.baseUrl}/api/0/issues/${encodeURIComponent(issueId)}/comments/`;

      /** Whether this issue already carries a note naming this session. */
      const alreadyNoted = (input: {
        readonly issueId: string;
        readonly sessionId: SessionId;
      }): Effect.Effect<boolean, TriggerError> =>
        Effect.gen(function* () {
          const response = yield* http
            .execute(
              HttpClientRequest.get(notesUrl(input.issueId), { headers }),
            )
            .pipe(
              Effect.mapError((error) =>
                fail(
                  `Sentry gave no answer reading issue ${input.issueId}'s notes (${why(error)}); nothing was posted`,
                ),
              ),
            );
          if (response.status < 200 || response.status > 299) {
            return yield* fail(
              `Sentry answered HTTP ${response.status} reading issue ${input.issueId}'s notes`,
            );
          }
          const notes = yield* HttpClientResponse.schemaBodyJson(SentryNotes)(
            response,
          ).pipe(
            Effect.mapError(() =>
              fail(
                `Sentry's notes for issue ${input.issueId} could not be read`,
              ),
            ),
          );
          return notes.some((note) =>
            (note.data?.text ?? "").includes(input.sessionId),
          );
        });

      const link = (input: {
        readonly issueId: string;
        readonly sessionId: SessionId;
      }): Effect.Effect<void, TriggerError> =>
        Effect.gen(function* () {
          if (yield* alreadyNoted(input)) return;
          const request = yield* HttpClientRequest.post(
            notesUrl(input.issueId),
            { headers },
          ).pipe(
            HttpClientRequest.bodyJson({
              text: sentryNote(config, input.sessionId),
            }),
            Effect.mapError(() => fail("the note could not be encoded")),
          );
          const response = yield* http.execute(request).pipe(
            // The create is the one call that must reach Sentry at most once per attempt. Bun's
            // `fetch` re-sends a request whose reused connection drops before any answer, which
            // is a second note when the first landed (`sentry.sh`'s lost-acknowledgement case
            // measured it). A fresh connection is not re-sent. Another client ignores the hint.
            Effect.provideService(FetchHttpClient.RequestInit, {
              keepalive: false,
            }),
            Effect.mapError((error) =>
              fail(
                `Sentry gave no answer to the note on issue ${input.issueId} (${why(error)}); whether it landed is unknown, and a redelivery's read-before-post check settles it`,
              ),
            ),
          );
          if (response.status < 200 || response.status > 299) {
            return yield* fail(
              `Sentry answered HTTP ${response.status} noting issue ${input.issueId}`,
            );
          }
        });

      return TriggerWriteBack.of({
        write: ({ event, sessionId }) => {
          // The composite hands this client only its own source's events; a stray one is not ours.
          if (event.source !== "sentry") return Effect.void;
          const issueId = event.address;
          if (issueId === undefined) {
            return Effect.logWarning(
              `sentry: alert ${event.key} names no issue_id, so session ${sessionId} is not linked on it`,
            );
          }
          return link({ issueId, sessionId }).pipe(
            Effect.timeoutOrElse({
              duration: budget,
              orElse: () =>
                Effect.logWarning(
                  `sentry: issue ${issueId} was not linked to session ${sessionId} within ${Duration.toMillis(budget)}ms; the session runs, and a redelivery's read-before-post makes a later note safe`,
                ),
            }),
            Effect.catchTag("TriggerError", (error) =>
              Effect.logError(
                `sentry: could not link issue ${issueId} to session ${sessionId}: ${error.message}`,
              ),
            ),
          );
        },
      });
    }),
  );
