/**
 * The Sentry link-back (LOB-83): the one note a session leaves on its alert's Sentry issue.
 *
 * Nothing here resolves `sentry.io` (`docs/testing-third-parties.md`'s Sentry REST row). The fake is
 * at the HTTP boundary: a stateful `HttpClient` that keeps each issue's notes and answers the two
 * routes the write-back uses, so "exactly one note" is a count of what the issue holds, not of calls
 * a mock saw. It can drop the acknowledgement of a create (the note lands, the caller learns of a
 * dropped connection), answer an error, be unreachable, or never answer.
 *
 * The first blocks are the client alone: the request shapes, the read-before-post check, and each
 * failure being logged and swallowed. The composite block is `TriggerWriteBackBySource` with Linear's
 * client beside Sentry's. The last block goes through the real `TriggerServiceLive` on Postgres, where
 * the facts the issue promises live: a redelivery, a claim given back after the note landed, and a
 * second alert bound to the same session each leave one note, and a failed link-back leaves a
 * `processed` delivery.
 *
 * Needs Postgres: `docker compose up -d --wait postgres`. Every row it writes carries a per-run id.
 */
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import type { TriggerEvent, TriggerRule } from "@repo/domain/Trigger";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  Duration,
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAR_STATES,
  LinearIssueSyncLive,
  LinearTriggerWriteBack,
} from "./LinearSync";
import { makeLinear, PROGRESS, TODO } from "./linearFake";
import {
  SENTRY_LABEL,
  sentryDelivery,
  sentryEvent,
  sentryEventRequestId,
} from "./Sentry";
import {
  SENTRY_DEFAULT_API_URL,
  SENTRY_LINK_BACK_BUDGET,
  sentryApiConfigFromEnv,
  sentryNote,
  SentryWriteBack,
  type SentryApiConfig,
} from "./SentryWriteBack";
import {
  NoCards,
  TriggerService,
  TriggerServiceLive,
  TriggerSessions,
  TriggerWriteBack,
  TriggerWriteBackBySource,
} from "./TriggerService";

const runId = randomBytes(6).toString("hex");

/** How the fake answers one route. A number is an HTTP status. */
type Answer = "ok" | number | "unreachable" | "hang" | "garbage";

type Behavior = {
  /** The notes read: `ok` lists what the issue holds. */
  get: Answer;
  /**
   * The note create: `ok` is a 201. `lose-ack` applies the note and then drops the connection, so
   * Sentry holds it and the caller never learns that.
   */
  post: Answer | "lose-ack";
};

type Seen = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
};

const Json = Schema.fromJsonString(Schema.Unknown);

/**
 * Sentry's issue-notes routes over memory. Notes are listed newest first, each as the activity
 * Sentry serializes (`type: "note"`, the text under `data`). A route this fake does not know is a
 * 404, so a client that started calling another one would fail here instead of being answered.
 */
const makeSentryApi = (initial: Partial<Behavior> = {}) => {
  const behavior: Behavior = { get: "ok", post: "ok", ...initial };
  const requests: Array<Seen> = [];
  const notes = new Map<string, Array<string>>();
  const notesOf = (issueId: string): ReadonlyArray<string> =>
    notes.get(issueId) ?? [];

  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array"
            ? yield* Schema.decodeEffect(Json)(
                new TextDecoder().decode(request.body.body),
              ).pipe(Effect.orDie)
            : undefined;
        requests.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers["authorization"],
          body,
        });
        const route = /^\/api\/0\/issues\/([^/]+)\/comments\/$/.exec(
          url.pathname,
        );
        const respond = (status: number, payload: unknown) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(payload), {
                status,
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        const dropped = Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        );
        if (route === null) return yield* respond(404, { detail: "not found" });
        const issueId = decodeURIComponent(route[1] ?? "");

        if (request.method === "GET") {
          if (behavior.get === "unreachable") return yield* dropped;
          if (behavior.get === "hang") return yield* Effect.never;
          if (behavior.get === "garbage") {
            return yield* respond(200, { detail: "not a list" });
          }
          if (typeof behavior.get === "number") {
            return yield* respond(behavior.get, { detail: "refused" });
          }
          return yield* respond(
            200,
            [...notesOf(issueId)].reverse().map((text, index) => ({
              id: String(index),
              type: "note",
              data: { text },
              user: { name: "factory" },
            })),
          );
        }

        if (behavior.post === "unreachable") return yield* dropped;
        if (behavior.post === "hang") return yield* Effect.never;
        if (typeof behavior.post === "number") {
          return yield* respond(behavior.post, { detail: "refused" });
        }
        const text = (body as { readonly text?: unknown } | undefined)?.text;
        notes.set(issueId, [...notesOf(issueId), String(text)]);
        if (behavior.post === "lose-ack") {
          // The note is on the issue; the connection drops before the answer.
          behavior.post = "ok";
          return yield* dropped;
        }
        return yield* respond(201, { id: "1", type: "note", data: { text } });
      }),
    ),
  );
  /** A note someone else left, as it would be on the issue. */
  const seed = (issueId: string, text: string): void => {
    notes.set(issueId, [...notesOf(issueId), text]);
  };
  return { behavior, requests, notesOf, seed, client };
};

const sessionId = "01J8Z000000000000000000000" as SessionId;
const otherSession = "01J8Z000000000000000000001" as SessionId;

const config = (over: Partial<SentryApiConfig> = {}): SentryApiConfig => ({
  baseUrl: "http://127.0.0.1:9999",
  authToken: Redacted.make("sentry-token"),
  ...over,
});

const alertEvent = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  source: "sentry",
  key: "event-1",
  action: "create",
  title: "ReferenceError: x",
  body: "",
  labels: [SENTRY_LABEL],
  fingerprint: "issue-9",
  address: "issue-9",
  ...over,
});

/** Run `write` through a Sentry client over `api`, and answer its exit and what it logged. */
const write = async (
  api: ReturnType<typeof makeSentryApi>,
  input: { event: TriggerEvent; session?: SessionId },
  options: Partial<SentryApiConfig> = {},
) => {
  const lines: Array<{ level: string; text: string }> = [];
  const recording = Logger.make(({ message, logLevel }) => {
    lines.push({
      level: logLevel,
      text: (Array.isArray(message) ? message : [message])
        .map(String)
        .join(" "),
    });
  });
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const port = yield* TriggerWriteBack;
      yield* port.write({
        event: input.event,
        sessionId: input.session ?? sessionId,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SentryWriteBack(config(options)).pipe(Layer.provide(api.client)),
          Logger.layer([recording]),
        ),
      ),
    ),
  );
  return { exit, lines };
};

describe("sentryApiConfigFromEnv", () => {
  it("is off without a token, and a blank one is none", () => {
    for (const authToken of [undefined, "", "   "]) {
      expect(
        sentryApiConfigFromEnv({
          apiUrl: "https://sentry.example",
          authToken,
          sessionUrlBase: undefined,
        }),
      ).toBeUndefined();
    }
  });

  it("defaults to Sentry's SaaS, trims the URL's trailing slashes and keeps the token redacted", () => {
    const sass = sentryApiConfigFromEnv({
      apiUrl: undefined,
      authToken: " tok ",
      sessionUrlBase: undefined,
    });
    expect(sass?.baseUrl).toBe(SENTRY_DEFAULT_API_URL);
    expect(SENTRY_DEFAULT_API_URL).toBe("https://sentry.io");
    expect(Redacted.value(sass?.authToken ?? Redacted.make(""))).toBe("tok");
    expect(JSON.stringify(sass)).not.toContain("tok");
    expect(sass).not.toHaveProperty("sessionUrlBase");

    const hosted = sentryApiConfigFromEnv({
      apiUrl: "https://sentry.acme.test//",
      authToken: "tok",
      sessionUrlBase: " http://localhost:3000/sessions ",
    });
    expect(hosted?.baseUrl).toBe("https://sentry.acme.test");
    expect(hosted?.sessionUrlBase).toBe("http://localhost:3000/sessions");
  });
});

describe("sentryNote", () => {
  it("names the session, and links to it when the deployment knows where", () => {
    expect(sentryNote({}, sessionId)).toBe(
      `Factory is investigating this alert in session ${sessionId}.`,
    );
    expect(
      sentryNote(
        { sessionUrlBase: "http://localhost:3000/sessions/" },
        sessionId,
      ),
    ).toBe(
      `Factory is investigating this alert in session ${sessionId} (http://localhost:3000/sessions/${sessionId}).`,
    );
  });
});

describe("SentryWriteBack", () => {
  it("reads the issue's notes, then posts one with the session's URL, as the configured token", async () => {
    const api = makeSentryApi();
    const { exit, lines } = await write(
      api,
      { event: alertEvent() },
      { sessionUrlBase: "http://localhost:3000/sessions" },
    );
    expect(exit._tag).toBe("Success");
    expect(lines).toEqual([]);
    expect(api.requests.map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/api/0/issues/issue-9/comments/"],
      ["POST", "/api/0/issues/issue-9/comments/"],
    ]);
    expect(
      api.requests.every(
        (request) => request.authorization === "Bearer sentry-token",
      ),
    ).toBe(true);
    expect(api.requests[1]?.body).toEqual({
      text: `Factory is investigating this alert in session ${sessionId} (http://localhost:3000/sessions/${sessionId}).`,
    });
    expect(api.notesOf("issue-9")).toHaveLength(1);
  });

  it("addresses the issue the event names, not the event it is keyed by", async () => {
    const api = makeSentryApi();
    await write(api, {
      event: alertEvent({ key: "the-event-id", address: "1117540176" }),
    });
    expect(api.requests.map((request) => request.path)).toEqual([
      "/api/0/issues/1117540176/comments/",
      "/api/0/issues/1117540176/comments/",
    ]);
    expect(api.notesOf("the-event-id")).toEqual([]);
  });

  it("posts one note however often it is asked, because the read finds the session's note", async () => {
    const api = makeSentryApi();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await write(api, { event: alertEvent() })).exit._tag).toBe(
        "Success",
      );
    }
    expect(api.notesOf("issue-9")).toHaveLength(1);
    expect(api.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "GET",
    ]);
  });

  it("posts nothing when the note landed and its acknowledgement did not, and logs the dropped call", async () => {
    // The window the seam's retry contract opens: Sentry holds the note, the caller saw a dropped
    // connection.
    const api = makeSentryApi({ post: "lose-ack" });
    const first = await write(api, { event: alertEvent() });
    expect(first.exit._tag).toBe("Success");
    expect(api.notesOf("issue-9")).toHaveLength(1);
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]?.level).toBe("Error");

    const retry = await write(api, { event: alertEvent() });
    expect(retry.exit._tag).toBe("Success");
    expect(retry.lines).toEqual([]);
    expect(api.notesOf("issue-9")).toHaveLength(1);
    expect(api.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  it("still posts when the issue's other notes name other sessions, one per session", async () => {
    const api = makeSentryApi();
    await write(api, { event: alertEvent() });
    await write(api, { event: alertEvent(), session: otherSession });
    await write(api, { event: alertEvent(), session: otherSession });
    expect(api.notesOf("issue-9")).toEqual([
      sentryNote({}, sessionId),
      sentryNote({}, otherSession),
    ]);
  });

  it("reads every note's text, not only the newest", async () => {
    const api = makeSentryApi();
    await write(api, { event: alertEvent() });
    // Other people's notes pile on top of ours, so ours is no longer the newest.
    for (let n = 0; n < 5; n += 1) api.seed("issue-9", `unrelated note ${n}`);
    await write(api, { event: alertEvent() });
    expect(api.notesOf("issue-9")).toHaveLength(6);
    expect(
      api.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  });

  describe("best effort: the delivery never fails, and one line says why", () => {
    const expectOneLine = (
      lines: ReadonlyArray<{ level: string; text: string }>,
      cause: string,
    ) => {
      expect(lines).toHaveLength(1);
      expect(lines[0]?.text).toContain("issue-9");
      expect(lines[0]?.text).toContain(sessionId);
      expect(lines[0]?.text).toContain(cause);
    };

    it("an HTTP 5xx on the read posts nothing", async () => {
      const api = makeSentryApi({ get: 503 });
      const { exit, lines } = await write(api, { event: alertEvent() });
      expect(exit._tag).toBe("Success");
      expectOneLine(lines, "HTTP 503");
      expect(lines[0]?.level).toBe("Error");
      expect(api.requests.map((request) => request.method)).toEqual(["GET"]);
    });

    it("an HTTP 5xx on the create leaves no note", async () => {
      const api = makeSentryApi({ post: 502 });
      const { exit, lines } = await write(api, { event: alertEvent() });
      expect(exit._tag).toBe("Success");
      expectOneLine(lines, "HTTP 502");
      expect(api.notesOf("issue-9")).toEqual([]);
    });

    it("a refusal (a token without the scope) is the same: logged, not thrown", async () => {
      const api = makeSentryApi({ post: 403 });
      const { exit, lines } = await write(api, { event: alertEvent() });
      expect(exit._tag).toBe("Success");
      expectOneLine(lines, "HTTP 403");
    });

    it("an unreachable API is logged on the read", async () => {
      const api = makeSentryApi({ get: "unreachable" });
      const { exit, lines } = await write(api, { event: alertEvent() });
      expect(exit._tag).toBe("Success");
      expectOneLine(lines, "gave no answer");
      expectOneLine(lines, "TransportError");
      expect(api.requests).toHaveLength(1);
    });

    it("an unreachable API is logged on the create", async () => {
      const api = makeSentryApi({ post: "unreachable" });
      const { exit, lines } = await write(api, { event: alertEvent() });
      expect(exit._tag).toBe("Success");
      expectOneLine(lines, "gave no answer");
      expectOneLine(lines, "whether it landed is unknown");
    });

    it("an answer that is not a list of notes posts nothing: a read nobody understood is not 'no note'", async () => {
      const api = makeSentryApi({ get: "garbage" });
      const { exit, lines } = await write(api, { event: alertEvent() });
      expect(exit._tag).toBe("Success");
      expectOneLine(lines, "could not be read");
      expect(api.requests.map((request) => request.method)).toEqual(["GET"]);
    });

    it("a Sentry that never answers the read is abandoned at the budget", async () => {
      const api = makeSentryApi({ get: "hang" });
      // The fake never answers, so a write that returns at all was ended by the budget.
      const { exit, lines } = await write(
        api,
        { event: alertEvent() },
        { budget: "60 millis" },
      );
      expect(exit._tag).toBe("Success");
      expectOneLine(lines, "within 60ms");
    });

    it("a Sentry that never answers the create is abandoned at the budget too", async () => {
      const api = makeSentryApi({ post: "hang" });
      const { exit, lines } = await write(
        api,
        { event: alertEvent() },
        { budget: "60 millis" },
      );
      expect(exit._tag).toBe("Success");
      expectOneLine(lines, "within 60ms");
    });

    it("the default budget is a few seconds, short of the route's patience", () => {
      expect(Duration.toMillis(SENTRY_LINK_BACK_BUDGET)).toBe(4_000);
    });
  });

  it("an alert with no issue id makes no request and says why", async () => {
    const api = makeSentryApi();
    const { address: _address, ...bare } = alertEvent({
      key: "event-no-issue",
    });
    const { exit, lines } = await write(api, { event: bare });
    expect(exit._tag).toBe("Success");
    expect(api.requests).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("event-no-issue");
    expect(lines[0]?.text).toContain("no issue_id");
    expect(lines[0]?.text).toContain(sessionId);
  });

  it("makes no request for another source's event", async () => {
    const api = makeSentryApi();
    const { exit } = await write(api, {
      event: alertEvent({ source: "linear", key: "LOB-1" }),
    });
    expect(exit._tag).toBe("Success");
    expect(api.requests).toEqual([]);
  });
});

describe("the composite write-back, with Sentry beside Linear", () => {
  const compose = (api: ReturnType<typeof makeSentryApi>) => {
    const linear: Array<string> = [];
    const layer = TriggerWriteBackBySource({
      linear: Layer.succeed(
        TriggerWriteBack,
        TriggerWriteBack.of({
          write: (input) =>
            Effect.sync(() => {
              linear.push(`started ${input.event.key}`);
            }),
        }),
      ),
      sentry: SentryWriteBack(config()).pipe(Layer.provide(api.client)),
    });
    const send = (event: TriggerEvent) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const port = yield* TriggerWriteBack;
          yield* port.write({ event, sessionId });
        }).pipe(Effect.provide(layer)),
      );
    return { linear, send };
  };

  it("moves a Linear issue to started and makes no Sentry request for it", async () => {
    const api = makeSentryApi();
    const { linear, send } = compose(api);
    await send(alertEvent({ source: "linear", key: "LOB-1" }));
    expect(linear).toEqual(["started LOB-1"]);
    expect(api.requests).toEqual([]);
  });

  it("moves a Linear issue to started through the real Linear write-back with Sentry configured", async () => {
    const sentry = makeSentryApi();
    const fake = makeLinear();
    const layer = TriggerWriteBackBySource({
      linear: LinearTriggerWriteBack.pipe(
        Layer.provide(
          LinearIssueSyncLive({
            apiUrl: "http://linear.test/graphql",
            apiKey: Redacted.make("lin_api_test"),
            states: DEFAULT_LINEAR_STATES,
          }),
        ),
        Layer.provide(fake.layer),
      ),
      sentry: SentryWriteBack(config()).pipe(Layer.provide(sentry.client)),
    });
    const send = (event: TriggerEvent) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const port = yield* TriggerWriteBack;
          yield* port.write({ event, sessionId });
        }).pipe(Effect.provide(layer)),
      );
    expect(fake.issue.state).toEqual(TODO);
    await send(alertEvent({ source: "linear", key: "ENG-42" }));
    expect(fake.issue.state).toEqual(PROGRESS);
    expect(sentry.requests).toEqual([]);
    // And the Sentry alert beside it notes its issue and leaves Linear's issue where it was.
    await send(alertEvent());
    expect(sentry.notesOf("issue-9")).toHaveLength(1);
    expect(fake.issue.state).toEqual(PROGRESS);
  });

  it("notes a Sentry alert and does not touch Linear for it", async () => {
    const api = makeSentryApi();
    const { linear, send } = compose(api);
    await send(alertEvent());
    expect(linear).toEqual([]);
    expect(api.notesOf("issue-9")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the seam, on Postgres
// ---------------------------------------------------------------------------------------------

const repo = `acme/sentry-linkback-${runId}` as RepoSlug;
const SESSION_PREFIX = `ses_${runId}`;
let minted = 0;

const rules: ReadonlyArray<TriggerRule> = [
  {
    label: SENTRY_LABEL,
    repo,
    baseRef: "main",
    prompt: "Investigate {{title}}",
  },
];

/** A Sentry issue id of this run's own, so no other run's binding can answer for it. */
const issueOf = (name: string): string => `${runId}-${name}`;

const alert = (
  eventId: string,
  issueId: string | undefined,
): Record<string, unknown> => ({
  action: "triggered",
  data: {
    event: {
      event_id: eventId,
      ...(issueId === undefined ? {} : { issue_id: issueId }),
      title: "ReferenceError: heck is not defined",
      level: "error",
      environment: "production",
      project: 1,
    },
    triggered_rule: "Very Important Alert!",
  },
});

/**
 * The real seam over Postgres, with the fake session layer writing the `sessions` row a real create
 * would (a fingerprint's binding asks that table whether the session is open) and the Sentry
 * write-back behind `TriggerWriteBackBySource`, over `api`. Answers `deliver`, and what the process
 * logged.
 */
const withSeam = async <A>(
  api: ReturnType<typeof makeSentryApi>,
  body: (tools: {
    readonly deliver: (
      payload: Record<string, unknown>,
      requestId: string,
    ) => Promise<{
      readonly status: string;
      readonly replayed: boolean;
      readonly sessionId?: SessionId | undefined;
    }>;
    readonly lines: ReadonlyArray<string>;
    readonly run: <B, E>(effect: Effect.Effect<B, E, SqlClient>) => Promise<B>;
  }) => Promise<A>,
  options: Partial<SentryApiConfig> = {},
): Promise<A> => {
  const lines: Array<string> = [];
  const recording = Logger.make(({ message }) => {
    lines.push(
      (Array.isArray(message) ? message : [message]).map(String).join(" "),
    );
  });
  const sessions = Layer.effect(
    TriggerSessions,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return TriggerSessions.of({
        create: (input) =>
          Effect.gen(function* () {
            // A real create dedupes on the request id, so a delivery given back and run again finds
            // the session it opened (`SessionService.create`).
            const known = yield* sql<{ readonly id: string }>`
              SELECT id FROM sessions WHERE request_id = ${input.requestId}
            `;
            if (known[0] !== undefined) return { id: known[0].id as SessionId };
            minted += 1;
            const id =
              `${SESSION_PREFIX}${String(minted).padStart(26 - SESSION_PREFIX.length, "0")}` as SessionId;
            yield* sql`
              INSERT INTO sessions (id, title, request_id)
              VALUES (${id}, ${input.title}, ${input.requestId})
            `;
            return { id };
          }).pipe(Effect.orDie),
        send: () => Effect.void,
      });
    }),
  );
  const runtime = ManagedRuntime.make(
    TriggerServiceLive({ rules }).pipe(
      Layer.provide(
        Layer.mergeAll(
          sessions,
          NoCards,
          TriggerWriteBackBySource({
            sentry: SentryWriteBack(config(options)).pipe(
              Layer.provide(api.client),
            ),
          }),
        ),
      ),
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      Layer.provideMerge(Logger.layer([recording])),
    ),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO repos (slug) VALUES (${repo}) ON CONFLICT (slug) DO NOTHING`;
      }),
    );
    return await body({
      deliver: (payload, requestId) => {
        const derived = sentryDelivery(
          payload,
          { resource: "event_alert", requestId },
          rules,
        );
        if ("refused" in derived) throw new Error(derived.refused);
        return runtime.runPromise(
          Effect.gen(function* () {
            const trigger = yield* TriggerService;
            return yield* trigger.deliver(derived);
          }),
        );
      },
      lines,
      run: (effect) => runtime.runPromise(effect),
    });
  } finally {
    await runtime.dispose();
  }
};

afterAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM trigger_fingerprints WHERE starts_with(fingerprint, ${`sentry:${runId}`})`;
      yield* sql`DELETE FROM webhook_deliveries WHERE starts_with(request_id, ${`sentry:event:${runId}`})`;
      yield* sql`DELETE FROM sessions WHERE starts_with(id, ${SESSION_PREFIX})`;
      yield* sql`DELETE FROM repos WHERE slug = ${repo}`;
    }).pipe(Effect.provide(DatabaseLive)),
  ),
);

describe("a Sentry alert's link-back through the seam", () => {
  it("leaves exactly one note on the alert's issue, naming the session that opened for it", async () => {
    const api = makeSentryApi();
    const issue = issueOf("once");
    const opened = await withSeam(
      api,
      async ({ deliver }) => deliver(alert(`${runId}-once`, issue), "req-1"),
      { sessionUrlBase: "http://localhost:3000/sessions" },
    );
    expect(opened).toMatchObject({ status: "processed", replayed: false });
    expect(api.notesOf(issue)).toEqual([
      `Factory is investigating this alert in session ${opened.sessionId} (http://localhost:3000/sessions/${opened.sessionId}).`,
    ]);
  });

  it("a redelivery of the same event, in this process or a fresh one, adds no note", async () => {
    const api = makeSentryApi();
    const issue = issueOf("redeliver");
    const payload = alert(`${runId}-redeliver`, issue);
    await withSeam(api, async ({ deliver }) => {
      expect(await deliver(payload, "req-a")).toMatchObject({
        replayed: false,
      });
      expect(await deliver(payload, "req-b")).toMatchObject({ replayed: true });
    });
    // A restart: a runtime of its own over the same database.
    await withSeam(api, async ({ deliver }) => {
      expect(await deliver(payload, "req-c")).toMatchObject({ replayed: true });
    });
    expect(api.notesOf(issue)).toHaveLength(1);
  });

  it("a delivery replayed after the note landed but before it was marked processed adds no note", async () => {
    // The crash window the issue names: `write` ran, `processed` did not. The claim is gone, so the
    // same event is delivered afresh, and the seam calls `write` a second time for the same session.
    const api = makeSentryApi({ post: "lose-ack" });
    const issue = issueOf("window");
    const payload = alert(`${runId}-window`, issue);
    const requestId = sentryEventRequestId(`${runId}-window`);
    await withSeam(api, async ({ deliver, run }) => {
      const first = await deliver(payload, "req-1");
      expect(first).toMatchObject({ status: "processed", replayed: false });
      expect(api.notesOf(issue)).toHaveLength(1);

      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`DELETE FROM webhook_deliveries WHERE request_id = ${requestId}`;
        }),
      );
      const again = await deliver(payload, "req-2");
      expect(again).toMatchObject({ status: "processed", replayed: false });
      expect(again.sessionId).toBe(first.sessionId);
    });
    expect(api.notesOf(issue)).toHaveLength(1);
    // Two writes happened: the second one only read.
    expect(api.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  it("a second alert bound to the same session posts no second note", async () => {
    const api = makeSentryApi();
    const issue = issueOf("bound");
    await withSeam(api, async ({ deliver }) => {
      const first = await deliver(alert(`${runId}-bound-1`, issue), "req-1");
      expect(first).toMatchObject({ status: "processed" });
      const second = await deliver(alert(`${runId}-bound-2`, issue), "req-2");
      expect(second).toMatchObject({ status: "skipped" });
    });
    expect(api.notesOf(issue)).toHaveLength(1);
  });

  it("a link-back failure leaves the delivery processed, with one line naming issue, session and cause", async () => {
    for (const behavior of [
      { post: 503 },
      { get: 500 },
      { get: "unreachable" },
    ] as const) {
      const api = makeSentryApi(behavior);
      const name = `fail-${JSON.stringify(behavior)}`.replace(/\W/g, "");
      const issue = issueOf(name);
      const outcome = await withSeam(api, async ({ deliver, lines }) => {
        const answer = await deliver(alert(`${runId}-${name}`, issue), "req-1");
        const logged = lines.filter((line) => line.includes("sentry:"));
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain(issue);
        expect(logged[0]).toContain(String(answer.sessionId));
        return answer;
      });
      expect(outcome).toMatchObject({ status: "processed", replayed: false });
      expect(outcome.sessionId).toBeDefined();
    }
  });

  it("a Sentry that never answers does not hold the delivery past the budget", async () => {
    const api = makeSentryApi({ get: "hang" });
    const issue = issueOf("hang");
    const outcome = await withSeam(
      api,
      async ({ deliver }) => deliver(alert(`${runId}-hang`, issue), "req-1"),
      { budget: "80 millis" },
    );
    expect(outcome).toMatchObject({ status: "processed" });
  });

  it("an alert with no issue_id opens its session and posts nothing", async () => {
    const api = makeSentryApi();
    const payload = alert(`${runId}-noissue`, undefined);
    expect(
      sentryEvent(payload, { resource: "event_alert" }),
    ).not.toHaveProperty("address");
    const outcome = await withSeam(api, async ({ deliver }) =>
      deliver(payload, "req-1"),
    );
    expect(outcome).toMatchObject({ status: "processed", replayed: false });
    expect(outcome.sessionId).toBeDefined();
    expect(api.requests).toEqual([]);
  });
});
