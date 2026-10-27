/**
 * The Sentry receiver (LOB-81): its signature, its filter and its dedupe.
 *
 * Nothing here resolves `sentry.io` (`docs/testing-third-parties.md`'s Sentry row): the fake is the
 * sender — payloads shaped from Sentry's documented issue-alert example, signed in-test with the
 * scheme Sentry's own verification sample recomputes.
 *
 * The first two blocks are pure: the signature verdict and the normalization, which is where the
 * filter lives (only an issue alert's `triggered` is a `create`; everything else keeps a name the
 * seam's filter refuses). The last block goes through the real `TriggerServiceLive` on Postgres with
 * a counting session fake, because "two deliveries, one session" and "the dedupe survives a
 * restart" are facts about the `webhook_deliveries` row — the restart case opens a second runtime
 * with its own connection pool after the first is disposed, so nothing in memory carries over.
 *
 * Needs Postgres: `docker compose up -d --wait postgres`. Every row this file writes carries a
 * per-run id, so it is safe against a database other suites also use.
 */
import { createHmac, randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import { startsWork, type TriggerRule } from "@repo/domain/Trigger";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  SENTRY_LABEL,
  sentryDelivery,
  sentryEvent,
  sentryEventRequestId,
  sentryProjectLabel,
  sentrySignature,
  sentryStartsWork,
  sentryWorkRequestId,
  verifySentrySignature,
} from "./Sentry";
import {
  NoWriteBack,
  TriggerService,
  TriggerServiceLive,
  TriggerSessions,
} from "./TriggerService";

const runId = randomBytes(6).toString("hex");
const SECRET = "lob-81-client-secret";

/** An issue alert as Sentry's documented example shapes one. */
const alert = (
  eventId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  action: "triggered",
  installation: { uuid: "a8e5d37a-696c-4c54-adb5-b3f28d64c7de" },
  data: {
    event: {
      event_id: eventId,
      issue_id: "1117540176",
      title: "ReferenceError: heck is not defined",
      level: "error",
      culprit: "?(<anonymous>)",
      project: 1,
      release: null,
      environment: "production",
      url: "https://sentry.io/api/0/projects/acme/web/events/e4874d664c3540c1a32eab185f12c5ab/",
      web_url:
        "https://sentry.io/organizations/acme/issues/1117540176/events/e4874d664c3540c1a32eab185f12c5ab/",
      ...over,
    },
    triggered_rule: "Very Important Alert!",
  },
  actor: { type: "application", id: "sentry", name: "Sentry" },
});

describe("the Sentry signature", () => {
  const raw = JSON.stringify(alert("e4874d664c3540c1a32eab185f12c5ab"));

  it("is the hex HMAC-SHA256 of the body under the client secret", () => {
    // Spelled out once here, independently of `sentrySignature`, so the two cannot agree on a
    // wrong scheme.
    const expected = createHmac("sha256", SECRET)
      .update(raw, "utf8")
      .digest("hex");
    expect(sentrySignature(raw, SECRET)).toBe(expected);
    expect(
      verifySentrySignature({
        raw,
        signature: expected,
        clientSecret: SECRET,
      }),
    ).toEqual({ ok: true });
  });

  it("accepts the hex in either case, as a header may carry it", () => {
    expect(
      verifySentrySignature({
        raw,
        signature: sentrySignature(raw, SECRET).toUpperCase(),
        clientSecret: SECRET,
      }),
    ).toEqual({ ok: true });
  });

  it("names a missing signature, an empty one included", () => {
    for (const signature of [undefined, "", "   "]) {
      expect(
        verifySentrySignature({ raw, signature, clientSecret: SECRET }),
      ).toEqual({ ok: false, refusal: "missing-signature" });
    }
  });

  it("refuses another body, another secret, a truncated hex and a non-hex value as bad", () => {
    const signature = sentrySignature(raw, SECRET);
    const cases = [
      { raw: `${raw} `, signature },
      { raw, signature: sentrySignature(raw, "someone-else") },
      { raw, signature: signature.slice(0, 63) },
      { raw, signature: "z".repeat(64) },
    ];
    for (const input of cases) {
      expect(verifySentrySignature({ ...input, clientSecret: SECRET })).toEqual(
        { ok: false, refusal: "bad-signature" },
      );
    }
  });

  it("verifies nothing under an empty secret, even a body signed with the empty key", () => {
    expect(
      verifySentrySignature({
        raw,
        signature: sentrySignature(raw, ""),
        clientSecret: "",
      }),
    ).toEqual({ ok: false, refusal: "bad-signature" });
  });
});

describe("a Sentry payload, normalized (the filter)", () => {
  it("reads an issue alert as a create, keyed by its event, carrying the alert's own facts", () => {
    const event = sentryEvent(alert("e4874d664c3540c1a32eab185f12c5ab"), {
      resource: "event_alert",
    });
    expect(event).toEqual({
      source: "sentry",
      key: "e4874d664c3540c1a32eab185f12c5ab",
      action: "create",
      title: "ReferenceError: heck is not defined",
      body: [
        "alert rule: Very Important Alert!",
        "level: error",
        "culprit: ?(<anonymous>)",
        "environment: production",
        "issue: 1117540176",
        "event: e4874d664c3540c1a32eab185f12c5ab",
        "link: https://sentry.io/organizations/acme/issues/1117540176/events/e4874d664c3540c1a32eab185f12c5ab/",
      ].join("\n"),
      labels: [SENTRY_LABEL, sentryProjectLabel("1")],
    });
  });

  it("infers an alert from its payload when the resource header is missing", () => {
    expect(sentryEvent(alert("no-header"))?.action).toBe("create");
  });

  it("keeps every other resource's own name, so the seam's filter refuses it", () => {
    const issue = sentryEvent(
      {
        action: "created",
        data: {
          issue: {
            id: "1170820242",
            title: "Error: a new issue",
            culprit: "app/widget.ts",
            project: { id: "2", slug: "web" },
          },
        },
      },
      { resource: "issue" },
    );
    expect(issue).toMatchObject({
      source: "sentry",
      key: "issue:1170820242",
      action: "issue:created",
      title: "Error: a new issue",
      labels: [SENTRY_LABEL, sentryProjectLabel("2")],
    });
    expect(startsWork(issue?.action ?? "")).toBe(false);

    const installation = sentryEvent(
      { action: "created", data: { installation: { uuid: "u" } } },
      { resource: "installation" },
    );
    expect(installation?.action).toBe("installation:created");
    expect(startsWork(installation?.action ?? "")).toBe(false);

    // An alert action that is not `triggered` is not one either.
    const resolved = sentryEvent(
      { ...alert("other-action"), action: "resolved" },
      { resource: "event_alert" },
    );
    expect(resolved?.action).toBe("event_alert:resolved");
  });

  it("starts work for exactly the triggered issue alert", () => {
    expect(
      startsWork(
        sentryEvent(alert("x"), { resource: "event_alert" })?.action ?? "",
      ),
    ).toBe(true);
  });

  it("addresses nothing for a body that is not an object, has no resource, or an alert with no event id", () => {
    expect(sentryEvent(null)).toBeUndefined();
    expect(sentryEvent([alert("x")])).toBeUndefined();
    expect(sentryEvent({ action: "triggered", data: {} })).toBeUndefined();
    expect(
      sentryEvent(
        { action: "triggered", data: { event: { title: "no id" } } },
        { resource: "event_alert" },
      ),
    ).toBeUndefined();
  });
});

describe("a Sentry delivery's key", () => {
  it("names the alerted event, not the request, and is keyed by work", () => {
    const first = sentryDelivery(alert("evt-1"), {
      resource: "event_alert",
      requestId: "req-a",
    });
    const second = sentryDelivery(alert("evt-1"), {
      resource: "event_alert",
      requestId: "req-b",
    });
    expect(first).toMatchObject({
      requestId: sentryEventRequestId("evt-1"),
      keyedByWork: true,
    });
    expect(second).toMatchObject({ requestId: sentryEventRequestId("evt-1") });
    expect(sentryEventRequestId("evt-1")).toBe("sentry:event:evt-1");
  });

  it("keys a delivery that starts nothing by its Request-ID, and refuses one with none", () => {
    const issue = {
      action: "resolved",
      data: { issue: { id: "7", title: "t" } },
    };
    expect(
      sentryDelivery(issue, { resource: "issue", requestId: "req-7" }),
    ).toMatchObject({ requestId: "sentry:delivery:req-7" });
    expect(
      "keyedByWork" in
        sentryDelivery(issue, { resource: "issue", requestId: "req-7" }),
    ).toBe(false);
    expect(sentryDelivery(issue, { resource: "issue" })).toEqual({
      refused: "a Sentry issue:resolved delivery carries no Request-ID header",
      code: "missing-request-id",
    });
  });

  it("keys an action a rule opts in by its subject and action, not its Request-ID, and by work", () => {
    const optIn: ReadonlyArray<TriggerRule> = [
      {
        label: SENTRY_LABEL,
        repo: "acme/web" as RepoSlug,
        prompt: "{{title}}",
        startsWorkFor: ["issue:created"],
      },
    ];
    const created = {
      action: "created",
      data: { issue: { id: "7", title: "t" } },
    };
    const first = sentryDelivery(
      created,
      { resource: "issue", requestId: "req-a" },
      optIn,
    );
    const second = sentryDelivery(
      created,
      { resource: "issue", requestId: "req-b" },
      optIn,
    );
    expect(first).toEqual({
      requestId: "sentry:work:issue:7:issue:created",
      event: expect.objectContaining({ key: "issue:7" }),
      keyedByWork: true,
    });
    expect(second).toMatchObject({
      requestId: "sentry:work:issue:7:issue:created",
      keyedByWork: true,
    });

    // Without the opt-in the same delivery starts nothing, so it is one row per delivery.
    expect(
      sentryDelivery(created, { resource: "issue", requestId: "req-a" }),
    ).toEqual({
      requestId: "sentry:delivery:req-a",
      event: expect.objectContaining({ key: "issue:7" }),
    });
    // An action the rule does not list is not its work either.
    expect(
      sentryDelivery(
        { ...created, action: "resolved" },
        { resource: "issue", requestId: "req-c" },
        optIn,
      ),
    ).toMatchObject({ requestId: "sentry:delivery:req-c" });
    // A subject with no id names no work, so it falls back to its Request-ID.
    expect(
      sentryDelivery(
        { action: "created", data: { issue: { title: "no id" } } },
        { resource: "issue", requestId: "req-d" },
        optIn,
      ),
    ).toEqual({
      requestId: "sentry:delivery:req-d",
      event: expect.objectContaining({ key: "issue:no-id" }),
    });
  });

  it("asks whether a delivery starts work of the rule that routes it, as the seam's filter does", () => {
    const issue = sentryEvent(
      {
        action: "created",
        data: { issue: { id: "8", project: { id: "3" } } },
      },
      { resource: "issue" },
    );
    if (issue === undefined) throw new Error("issue did not normalize");
    expect(sentryWorkRequestId(issue)).toBe(
      "sentry:work:issue:8:issue:created",
    );
    const catchAll: TriggerRule = {
      label: SENTRY_LABEL,
      repo: "acme/web" as RepoSlug,
      prompt: "{{title}}",
      startsWorkFor: ["issue:created"],
    };
    expect(sentryStartsWork(issue)).toBe(false);
    expect(sentryStartsWork(issue, [catchAll])).toBe(true);
    // The project's own rule routes it ahead of the catch-all and admits nothing extra, so the
    // catch-all's opt-in does not reach an event the seam would map to the project's repo.
    expect(
      sentryStartsWork(issue, [
        {
          label: sentryProjectLabel("3"),
          repo: "acme/project" as RepoSlug,
          prompt: "{{title}}",
        },
        catchAll,
      ]),
    ).toBe(false);
  });

  it("refuses a payload that names no event as a bad payload", () => {
    expect(sentryDelivery({ nothing: true })).toMatchObject({
      code: "bad-payload",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Through the seam, on Postgres
// ---------------------------------------------------------------------------------------------

const repo = `acme/sentry-${runId}` as RepoSlug;
const unregistered = `acme/sentry-unregistered-${runId}` as RepoSlug;
const UNREGISTERED_PROJECT = "404";

const rules: ReadonlyArray<TriggerRule> = [
  // A project routed to a repo nobody registered, ahead of the catch-all.
  {
    label: sentryProjectLabel(UNREGISTERED_PROJECT),
    repo: unregistered,
    prompt: "{{title}}",
  },
  {
    label: SENTRY_LABEL,
    repo,
    baseRef: "main",
    prompt: "Investigate {{title}}:\n{{body}}",
    // The opt-in: a new issue in any project starts work too, keyed by the issue.
    startsWorkFor: ["issue:created"],
  },
];

/** One fake session: what the seam asked the session layer for. */
type Opened = {
  readonly id: SessionId;
  readonly requestId: string;
  readonly source: string;
  readonly repo: RepoSlug;
  prompt: string | undefined;
};

/**
 * One "process": a runtime of its own — its own connection pool, its own seam — over the shared
 * `opened` ledger, which stands for the sessions table both processes would see.
 */
const withProcess = async <A>(
  opened: Array<Opened>,
  body: (
    post: (
      payload: Record<string, unknown>,
      requestId: string,
      resource?: string,
    ) => Promise<{
      readonly status: string;
      readonly replayed: boolean;
      readonly reason?: string | undefined;
      readonly sessionId?: SessionId | undefined;
    }>,
  ) => Promise<A>,
): Promise<A> => {
  const sessions = TriggerSessions.of({
    create: (input) =>
      Effect.sync(() => {
        const id =
          `ses_${String(opened.length + 1).padStart(26, "0")}` as SessionId;
        opened.push({
          id,
          requestId: input.requestId,
          source: input.source,
          repo: input.repo,
          prompt: undefined,
        });
        return { id };
      }),
    send: (input) =>
      Effect.sync(() => {
        const entry = opened.find((session) => session.id === input.sessionId);
        if (entry !== undefined) entry.prompt = input.content;
      }),
  });
  const runtime = ManagedRuntime.make(
    TriggerServiceLive({ rules }).pipe(
      Layer.provide(
        Layer.mergeAll(Layer.succeed(TriggerSessions, sessions), NoWriteBack),
      ),
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO repos (slug) VALUES (${repo}) ON CONFLICT (slug) DO NOTHING`;
      }),
    );
    return await body(async (payload, requestId, resource = "event_alert") => {
      const derived = sentryDelivery(payload, { resource, requestId }, rules);
      if ("refused" in derived) throw new Error(derived.refused);
      return runtime.runPromise(
        Effect.gen(function* () {
          const trigger = yield* TriggerService;
          return yield* trigger.deliver(derived);
        }),
      );
    });
  } finally {
    await runtime.dispose();
  }
};

const registerUnregistered = () =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO repos (slug) VALUES (${unregistered}) ON CONFLICT (slug) DO NOTHING`;
      }),
      DatabaseLive,
    ),
  );

describe("a Sentry alert through the seam", () => {
  it("opens exactly one session for two deliveries of one alerted event", async () => {
    const opened: Array<Opened> = [];
    const eventId = `${runId}-twice`;
    await withProcess(opened, async (post) => {
      const first = await post(alert(eventId), "req-first");
      expect(first).toMatchObject({
        status: "processed",
        replayed: false,
        reason: `rule "${SENTRY_LABEL}" mapped it to ${repo}`,
      });

      // A second alert rule firing for the same event: a new Request-ID, the same work.
      const second = await post(alert(eventId), "req-second");
      expect(second).toMatchObject({ status: "processed", replayed: true });
    });

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      source: "sentry",
      requestId: `trigger:${sentryEventRequestId(eventId)}`,
      repo,
    });
    expect(opened[0]?.prompt).toContain(
      "Investigate ReferenceError: heck is not defined:",
    );
    expect(opened[0]?.prompt).toContain("alert rule: Very Important Alert!");
  });

  it("keeps the dedupe across a restart: a fresh process replays the delivery and opens nothing", async () => {
    const opened: Array<Opened> = [];
    const eventId = `${runId}-restart`;
    await withProcess(opened, async (post) => {
      expect(await post(alert(eventId), "req-before")).toMatchObject({
        status: "processed",
        replayed: false,
      });
    });
    // The first runtime is disposed — its pool closed, its seam gone. The second knows only the
    // database.
    await withProcess(opened, async (post) => {
      expect(await post(alert(eventId), "req-after")).toMatchObject({
        status: "processed",
        replayed: true,
      });
    });

    expect(opened).toHaveLength(1);
  });

  it("opens one session per event: another event is another delivery", async () => {
    const opened: Array<Opened> = [];
    await withProcess(opened, async (post) => {
      await post(alert(`${runId}-a`), "req-a");
      await post(alert(`${runId}-b`), "req-b");
    });
    expect(opened.map((session) => session.requestId)).toEqual([
      `trigger:${sentryEventRequestId(`${runId}-a`)}`,
      `trigger:${sentryEventRequestId(`${runId}-b`)}`,
    ]);
  });

  it("opens one session for an opted-in action re-sent with a new Request-ID", async () => {
    const opened: Array<Opened> = [];
    const created = {
      action: "created",
      data: { issue: { id: `${runId}-optin`, title: "Error: a new issue" } },
    };
    await withProcess(opened, async (post) => {
      expect(await post(created, "req-optin-1", "issue")).toMatchObject({
        status: "processed",
        replayed: false,
      });
      expect(await post(created, "req-optin-2", "issue")).toMatchObject({
        status: "processed",
        replayed: true,
      });
      // The control: an action the rule did not opt in is still a recorded skip per delivery.
      expect(
        await post({ ...created, action: "resolved" }, "req-optin-3", "issue"),
      ).toMatchObject({
        status: "skipped",
        reason: 'action "issue:resolved" is not "create", "issue:created"',
      });
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.requestId).toBe(
      `trigger:sentry:work:issue:${runId}-optin:issue:created`,
    );
  });

  it("records an unregistered project's repo as a skip, and starts the next alert once it is registered", async () => {
    const opened: Array<Opened> = [];
    const eventId = `${runId}-unregistered`;
    const payload = alert(eventId, { project: Number(UNREGISTERED_PROJECT) });
    await withProcess(opened, async (post) => {
      expect(await post(payload, "req-1")).toEqual({
        status: "skipped",
        replayed: false,
        reason: `repo ${unregistered} is not registered`,
      });
      expect(opened).toHaveLength(0);

      // Keyed by work: the same event delivered again after the operator registers the repo is
      // claimed afresh, not answered with the old skip.
      await registerUnregistered();
      expect(await post(payload, "req-2")).toMatchObject({
        status: "processed",
        replayed: false,
      });
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.repo).toBe(unregistered);
  });
});
