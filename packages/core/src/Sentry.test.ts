/**
 * The Sentry receiver (LOB-81): its signature, its filter and its dedupe — and its mapping (LOB-82):
 * the release/environment/severity filter, the title, the issue bound to its session, and the
 * default investigate-before-edit prompt.
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
 * with its own connection pool after the first is disposed, so nothing in memory carries over. The
 * session fake writes the `sessions` index row a real create would, because "is the issue's session
 * still open" is read from it; `afterAll` removes the rows this run wrote there.
 *
 * Needs Postgres: `docker compose up -d --wait postgres`. Every row this file writes carries a
 * per-run id, so it is safe against a database other suites also use.
 */
import { createHmac, randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import {
  renderPrompt,
  resolveMapping,
  startsWork,
  TriggerError,
  type TriggerRule,
} from "@repo/domain/Trigger";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import {
  SENTRY_LABEL,
  SENTRY_PROMPT_TEMPLATE,
  sentryDelivery,
  sentryEvent,
  sentryEventRequestId,
  sentryFilterFromEnv,
  sentryFilterRefusal,
  sentryProjectLabel,
  sentrySignature,
  sentryStartsWork,
  sentryTitle,
  sentryWorkRequestId,
  verifySentrySignature,
  type SentryFilter,
} from "./Sentry";
import {
  NoCards,
  NoWriteBack,
  readFingerprintBinding,
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
      // The fixture names an environment and no release (`release: null`).
      title: "ReferenceError: heck is not defined (production)",
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
      fingerprint: "1117540176",
      // The write-back's address is the Sentry issue, not the event the key names (LOB-83).
      address: "1117540176",
      defaultPrompt: SENTRY_PROMPT_TEMPLATE,
    });
  });

  it("carries no address for an alert whose payload names no issue", () => {
    const payload = alert("no-issue-id", { issue_id: undefined });
    const event = sentryEvent(payload, { resource: "event_alert" });
    expect(event).toBeDefined();
    expect(event).not.toHaveProperty("address");
    expect(event).not.toHaveProperty("fingerprint");
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
      address: "1170820242",
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

describe("a Sentry alert's title (LOB-82)", () => {
  it("carries the release and the environment when the payload has them", () => {
    const event = sentryEvent(
      alert("titled", { release: "web@1.2.3", environment: "production" }),
      { resource: "event_alert" },
    );
    expect(event?.title).toBe(
      "ReferenceError: heck is not defined (production, release web@1.2.3)",
    );
  });

  it("carries whichever of the two the payload has, and the bare title when it has neither", () => {
    expect(sentryTitle("E", { release: "r1" })).toBe("E (release r1)");
    expect(sentryTitle("E", { environment: "staging" })).toBe("E (staging)");
    expect(sentryTitle("E", {})).toBe("E");
    expect(sentryTitle("", { environment: "staging" })).toBe("(staging)");
    expect(
      sentryEvent(alert("bare", { environment: null }), {
        resource: "event_alert",
      })?.title,
    ).toBe("ReferenceError: heck is not defined");
  });
});

describe("the Sentry filter (LOB-82)", () => {
  const filter: SentryFilter = {
    minLevel: "error",
    environments: ["production"],
    releases: ["web@2.*", "api@1.0.0"],
  };
  const passing = {
    level: "error",
    environment: "production",
    release: "web@2.4.1",
  };

  it("admits an alert every field of which passes, a release matched by prefix or exactly", () => {
    expect(sentryFilterRefusal(passing, filter)).toBeUndefined();
    expect(
      sentryFilterRefusal(
        { ...passing, level: "fatal", release: "api@1.0.0" },
        filter,
      ),
    ).toBeUndefined();
    // An empty filter admits everything, a payload with no facts included.
    expect(sentryFilterRefusal({}, {})).toBeUndefined();
  });

  it("names the field and the value that failed: severity, environment, release", () => {
    expect(sentryFilterRefusal({ ...passing, level: "warning" }, filter)).toBe(
      'level "warning" is below SENTRY_MIN_LEVEL "error"',
    );
    expect(
      sentryFilterRefusal({ ...passing, environment: "staging" }, filter),
    ).toBe('environment "staging" is not in SENTRY_ENVIRONMENTS [production]');
    expect(
      sentryFilterRefusal({ ...passing, release: "web@1.9.0" }, filter),
    ).toBe(
      'release "web@1.9.0" is not in SENTRY_RELEASES [web@2.*, api@1.0.0]',
    );
    // `api@1.0.0` is exact, not a prefix.
    expect(
      sentryFilterRefusal({ ...passing, release: "api@1.0.0-rc1" }, filter),
    ).toBe(
      'release "api@1.0.0-rc1" is not in SENTRY_RELEASES [web@2.*, api@1.0.0]',
    );
  });

  it("refuses a missing or unknown fact the filter asks about, naming it", () => {
    expect(sentryFilterRefusal({ ...passing, level: undefined }, filter)).toBe(
      'level is missing; SENTRY_MIN_LEVEL is "error"',
    );
    expect(sentryFilterRefusal({ ...passing, level: "sample" }, filter)).toBe(
      'level "sample" is not a Sentry level, so it is not at least SENTRY_MIN_LEVEL "error"',
    );
    expect(
      sentryFilterRefusal({ ...passing, environment: undefined }, filter),
    ).toBe("environment is missing; SENTRY_ENVIRONMENTS is [production]");
    expect(
      sentryFilterRefusal({ ...passing, release: undefined }, filter),
    ).toBe("release is missing; SENTRY_RELEASES is [web@2.*, api@1.0.0]");
  });

  it("reads the filter from the environment: blank is any, a list is trimmed, a bad level is an error", () => {
    expect(sentryFilterFromEnv({})).toEqual({ ok: true, filter: {} });
    expect(
      sentryFilterFromEnv({
        SENTRY_MIN_LEVEL: " Warning ",
        SENTRY_ENVIRONMENTS: "production, staging ,",
        SENTRY_RELEASES: "  ",
      }),
    ).toEqual({
      ok: true,
      filter: {
        minLevel: "warning",
        environments: ["production", "staging"],
      },
    });
    expect(sentryFilterFromEnv({ SENTRY_MIN_LEVEL: "severe" })).toEqual({
      ok: false,
      message:
        'SENTRY_MIN_LEVEL is "severe"; it must be one of debug, info, warning, error, fatal',
    });
  });

  it("marks a refused alert filtered, keys it by its Request-ID, and does not count it as work", () => {
    const payload = alert("filtered-evt", { level: "warning" });
    const rules: ReadonlyArray<TriggerRule> = [
      { label: SENTRY_LABEL, repo: "acme/web" as RepoSlug, prompt: "" },
    ];
    const delivered = sentryDelivery(
      payload,
      { resource: "event_alert", requestId: "req-filtered" },
      rules,
      { minLevel: "error" },
    );
    expect(delivered).toEqual({
      requestId: "sentry:delivery:req-filtered",
      event: expect.objectContaining({
        action: "create",
        filtered: 'level "warning" is below SENTRY_MIN_LEVEL "error"',
      }),
    });
    if ("refused" in delivered) throw new Error(delivered.refused);
    expect(sentryStartsWork(delivered.event, rules)).toBe(false);

    // The control: the same alert under no filter is work, keyed by its event.
    const unfiltered = sentryDelivery(
      payload,
      { resource: "event_alert", requestId: "req-filtered" },
      rules,
    );
    expect(unfiltered).toMatchObject({
      requestId: sentryEventRequestId("filtered-evt"),
      keyedByWork: true,
    });
    if ("refused" in unfiltered) throw new Error(unfiltered.refused);
    expect(unfiltered.event.filtered).toBeUndefined();
    expect(sentryStartsWork(unfiltered.event, rules)).toBe(true);
  });
});

describe("the default Sentry prompt (LOB-82)", () => {
  it("is the investigate-before-edit template, verbatim", () => {
    expect(SENTRY_PROMPT_TEMPLATE).toBe(
      [
        "A Sentry alert fired: {{title}}",
        "",
        "{{body}}",
        "",
        "Investigate before you edit anything. Find where this error is raised and why: read the culprit and the code around it, and reproduce the failure with a test if you can. Then state the root cause in a short paragraph before you change any file.",
        "",
        "If the cause is outside this repository, or the alert is noise, say so and stop without editing. Otherwise fix the root cause rather than the symptom, keep the change as small as the fix needs, and open a pull request whose description names the Sentry issue and the root cause.",
      ].join("\n"),
    );
    // The adapter carries it on the event, so the generic seam names no Sentry vocabulary.
    expect(
      sentryEvent(alert("templated"), { resource: "event_alert" })
        ?.defaultPrompt,
    ).toBe(SENTRY_PROMPT_TEMPLATE);
  });

  it("is what a rule with a blank prompt renders, over the alert's own title and facts", () => {
    const event = sentryEvent(alert("prompted", { release: "web@1.2.3" }), {
      resource: "event_alert",
    });
    if (event === undefined) throw new Error("the alert did not normalize");
    const blank: TriggerRule = {
      label: SENTRY_LABEL,
      repo: "acme/web" as RepoSlug,
      prompt: "  ",
    };
    const prompt = resolveMapping([blank], event)?.prompt;
    expect(prompt).toBe(renderPrompt(SENTRY_PROMPT_TEMPLATE, event));
    expect(prompt).toContain(
      "A Sentry alert fired: ReferenceError: heck is not defined (production, release web@1.2.3)",
    );
    expect(prompt).toContain("release: web@1.2.3\nenvironment: production");
    expect(prompt).toContain("Investigate before you edit anything.");
    // A rule that writes its own prompt keeps it.
    expect(
      resolveMapping([{ ...blank, prompt: "Fix {{title}}" }], event)?.prompt,
    ).toBe(`Fix ${event.title}`);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the seam, on Postgres
// ---------------------------------------------------------------------------------------------

const repo = `acme/sentry-${runId}` as RepoSlug;
const unregistered = `acme/sentry-unregistered-${runId}` as RepoSlug;
const UNREGISTERED_PROJECT = "404";
/** A project whose rule writes no prompt, so the default Sentry template is what the session gets. */
const DEFAULT_PROMPT_PROJECT = "777";

const rules: ReadonlyArray<TriggerRule> = [
  // A project routed to a repo nobody registered, ahead of the catch-all.
  {
    label: sentryProjectLabel(UNREGISTERED_PROJECT),
    repo: unregistered,
    prompt: "{{title}}",
  },
  // A project whose rule says only where its alerts go (LOB-82).
  {
    label: sentryProjectLabel(DEFAULT_PROMPT_PROJECT),
    repo,
    prompt: "",
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

/** A Sentry issue id of this run's own, so no other run's binding can answer for it. */
const issueOf = (name: string): string => `${runId}-${name}`;

/** One fake session: what the seam asked the session layer for. */
type Opened = {
  readonly id: SessionId;
  readonly requestId: string;
  readonly source: string;
  readonly repo: RepoSlug;
  readonly title: string;
  prompt: string | undefined;
};

/** Every session id this file's fakes minted, run-scoped: `ses_<runId><counter>`. */
let minted = 0;
const SESSION_PREFIX = `ses_${runId}`;

type Post = (
  payload: Record<string, unknown>,
  requestId: string,
  resource?: string,
  filter?: SentryFilter,
) => Promise<{
  readonly status: string;
  readonly replayed: boolean;
  readonly reason?: string | undefined;
  readonly sessionId?: SessionId | undefined;
}>;

/** Run an effect against the database, in the process's runtime. */
type Run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) => Promise<A>;

/**
 * One "process": a runtime of its own — its own connection pool, its own seam — over the shared
 * `opened` ledger. The fake session layer also writes the `sessions` index row a real create would
 * (id, title, request id), because whether a Sentry issue's session is still open is a question the
 * seam asks of that table (LOB-82). `failCreate` makes the next create fail, once.
 */
const withProcess = async <A>(
  opened: Array<Opened>,
  body: (post: Post, run: Run) => Promise<A>,
  options: { failCreate?: boolean } = {},
): Promise<A> => {
  let failNext = options.failCreate === true;
  const sessions = Layer.effect(
    TriggerSessions,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return TriggerSessions.of({
        create: (input) =>
          Effect.gen(function* () {
            if (failNext) {
              failNext = false;
              return yield* new TriggerError({
                code: "session-create",
                message: "the fake session layer refused this one",
              });
            }
            minted += 1;
            const id =
              `${SESSION_PREFIX}${String(minted).padStart(26 - runId.length, "0")}` as SessionId;
            yield* sql`
              INSERT INTO sessions (id, title, request_id)
              VALUES (${id}, ${input.title}, ${input.requestId})
            `.pipe(Effect.orDie);
            opened.push({
              id,
              requestId: input.requestId,
              source: input.source,
              repo: input.repo,
              title: input.title,
              prompt: undefined,
            });
            return { id };
          }),
        send: (input) =>
          Effect.sync(() => {
            const entry = opened.find(
              (session) => session.id === input.sessionId,
            );
            if (entry !== undefined) entry.prompt = input.content;
          }),
      });
    }),
  );
  const runtime = ManagedRuntime.make(
    TriggerServiceLive({ rules }).pipe(
      Layer.provide(Layer.mergeAll(sessions, NoWriteBack, NoCards)),
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
    return await body(
      async (payload, requestId, resource = "event_alert", filter = {}) => {
        const derived = sentryDelivery(
          payload,
          { resource, requestId },
          rules,
          filter,
        );
        if ("refused" in derived) throw new Error(derived.refused);
        return runtime.runPromise(
          Effect.gen(function* () {
            const trigger = yield* TriggerService;
            return yield* trigger.deliver(derived);
          }),
        );
      },
      (effect) => runtime.runPromise(effect),
    );
  } finally {
    await runtime.dispose();
  }
};

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, DatabaseLive));

const registerUnregistered = () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO repos (slug) VALUES (${unregistered}) ON CONFLICT (slug) DO NOTHING`;
    }),
  );

/** What `webhook_deliveries` recorded for a delivery: the row an operator reads. */
const deliveryRow = (requestId: string) =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ status: string; skipReason: string | null }>`
        SELECT status, skip_reason FROM webhook_deliveries WHERE request_id = ${requestId}
      `;
      return rows[0];
    }),
  );

afterAll(() =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM trigger_fingerprints WHERE starts_with(fingerprint, ${`sentry:${runId}`})`;
      yield* sql`DELETE FROM sessions WHERE starts_with(id, ${SESSION_PREFIX})`;
    }),
  ),
);

describe("a Sentry alert through the seam", () => {
  it("opens exactly one session for two deliveries of one alerted event", async () => {
    const opened: Array<Opened> = [];
    const eventId = `${runId}-twice`;
    const payload = alert(eventId, { issue_id: issueOf("twice") });
    await withProcess(opened, async (post) => {
      const first = await post(payload, "req-first");
      expect(first).toMatchObject({
        status: "processed",
        replayed: false,
        reason: `rule "${SENTRY_LABEL}" mapped it to ${repo}`,
      });

      // A second alert rule firing for the same event: a new Request-ID, the same work.
      const second = await post(payload, "req-second");
      expect(second).toMatchObject({ status: "processed", replayed: true });
    });

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      source: "sentry",
      requestId: `trigger:${sentryEventRequestId(eventId)}`,
      repo,
    });
    expect(opened[0]?.prompt).toContain(
      "Investigate ReferenceError: heck is not defined (production):",
    );
    expect(opened[0]?.prompt).toContain("alert rule: Very Important Alert!");
  });

  it("keeps the dedupe across a restart: a fresh process replays the delivery and opens nothing", async () => {
    const opened: Array<Opened> = [];
    const eventId = `${runId}-restart`;
    const payload = alert(eventId, { issue_id: issueOf("restart") });
    await withProcess(opened, async (post) => {
      expect(await post(payload, "req-before")).toMatchObject({
        status: "processed",
        replayed: false,
      });
    });
    // The first runtime is disposed — its pool closed, its seam gone. The second knows only the
    // database.
    await withProcess(opened, async (post) => {
      expect(await post(payload, "req-after")).toMatchObject({
        status: "processed",
        replayed: true,
      });
    });

    expect(opened).toHaveLength(1);
  });

  it("opens one session per Sentry issue: another issue's event is another delivery", async () => {
    const opened: Array<Opened> = [];
    await withProcess(opened, async (post) => {
      await post(alert(`${runId}-a`, { issue_id: issueOf("a") }), "req-a");
      await post(alert(`${runId}-b`, { issue_id: issueOf("b") }), "req-b");
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
    const payload = alert(eventId, {
      project: Number(UNREGISTERED_PROJECT),
      issue_id: issueOf("unregistered"),
    });
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

describe("a Sentry issue bound to its session (LOB-82)", () => {
  /** The recorded fixture: an alert in production for a release, in one issue of this run's. */
  const recorded = (eventId: string, issue: string) =>
    alert(eventId, {
      issue_id: issue,
      release: "web@1.2.3",
      environment: "production",
    });

  it("maps the recorded fixture to a session titled with its release and environment, and binds its issue — readable after a restart", async () => {
    const opened: Array<Opened> = [];
    const issue = issueOf("fixture");
    const first = await withProcess(opened, async (post, run) => {
      const answer = await post(recorded(`${runId}-fixture-1`, issue), "r-1");
      expect(answer).toMatchObject({ status: "processed", replayed: false });
      expect(await run(readFingerprintBinding(`sentry:${issue}`))).toEqual({
        fingerprint: `sentry:${issue}`,
        requestId: sentryEventRequestId(`${runId}-fixture-1`),
        sessionId: answer.sessionId,
        open: true,
      });
      return answer;
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.title).toBe(
      "ReferenceError: heck is not defined (production, release web@1.2.3)",
    );

    // A fresh process knows the binding from the database alone.
    await withProcess(opened, async (_post, run) => {
      expect(await run(readFingerprintBinding(`sentry:${issue}`))).toEqual({
        fingerprint: `sentry:${issue}`,
        requestId: sentryEventRequestId(`${runId}-fixture-1`),
        sessionId: first.sessionId,
        open: true,
      });
    });
  });

  it("answers a second event in the same issue with a recorded skip naming the open session — before and after a restart", async () => {
    const opened: Array<Opened> = [];
    const issue = issueOf("repeat");
    const firstEvent = `${runId}-repeat-1`;
    const first = await withProcess(opened, async (post) => {
      const answer = await post(recorded(firstEvent, issue), "r-1");
      expect(answer).toMatchObject({ status: "processed", replayed: false });
      return answer;
    });
    const sessionId = first.sessionId;
    expect(sessionId).toBeDefined();
    const expected = {
      status: "skipped",
      replayed: false,
      reason: `sentry:${issue} is bound to open session ${sessionId} (delivery ${sentryEventRequestId(firstEvent)}), so this delivery opens no second session; it frees when that session's workspace is released or after 3 days without activity, and \`factory discard ${sessionId}\` frees it now`,
    };

    await withProcess(opened, async (post) => {
      // A new event id, the same issue id: the alert firing again.
      const second = `${runId}-repeat-2`;
      expect(await post(recorded(second, issue), "r-2")).toEqual(expected);
      expect(await deliveryRow(sentryEventRequestId(second))).toEqual({
        status: "skipped",
        skipReason: expected.reason,
      });
    });
    // And again, in yet another process.
    await withProcess(opened, async (post) => {
      const third = `${runId}-repeat-3`;
      expect(await post(recorded(third, issue), "r-3")).toEqual(expected);
    });
    expect(opened).toHaveLength(1);
  });

  it("opens one session when two events of one issue race for it", async () => {
    const opened: Array<Opened> = [];
    const issue = issueOf("race");
    const answers = await withProcess(opened, (post) =>
      Promise.all(
        Array.from({ length: 4 }, (_, n) =>
          post(recorded(`${runId}-race-${n}`, issue), `r-${n}`),
        ),
      ),
    );
    expect(opened).toHaveLength(1);
    expect(answers.filter((answer) => answer.status === "processed")).toEqual([
      expect.objectContaining({ sessionId: opened[0]?.id }),
    ]);
    expect(
      answers.filter(
        (answer) =>
          answer.status === "skipped" &&
          answer.reason?.startsWith(`sentry:${issue} is b`) === true,
      ),
    ).toHaveLength(3);
  });

  it("opens the next session once the bound one is closed, and binds the issue to it", async () => {
    const opened: Array<Opened> = [];
    const issue = issueOf("closed");
    await withProcess(opened, async (post, run) => {
      const first = await post(recorded(`${runId}-closed-1`, issue), "r-1");
      expect(first.status).toBe("processed");
      // The card reached done: the session's workspace is released, so it is closed.
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`
            UPDATE sessions
            SET workspace_released_at = now(), workspace_release_reason = 'done'
            WHERE id = ${first.sessionId ?? ""}
          `;
        }),
      );
      expect(
        await run(readFingerprintBinding(`sentry:${issue}`)),
      ).toMatchObject({ sessionId: first.sessionId, open: false });

      const next = await post(recorded(`${runId}-closed-2`, issue), "r-2");
      expect(next).toMatchObject({ status: "processed", replayed: false });
      expect(next.sessionId).not.toBe(first.sessionId);
      expect(await run(readFingerprintBinding(`sentry:${issue}`))).toEqual({
        fingerprint: `sentry:${issue}`,
        requestId: sentryEventRequestId(`${runId}-closed-2`),
        sessionId: next.sessionId,
        open: true,
      });
    });
    expect(opened).toHaveLength(2);
  });

  it("gives an unopened binding back when its delivery fails, so the issue's next event opens the session", async () => {
    const opened: Array<Opened> = [];
    const issue = issueOf("failed");
    await withProcess(
      opened,
      async (post, run) => {
        await expect(
          post(recorded(`${runId}-failed-1`, issue), "r-1"),
        ).rejects.toThrow("the fake session layer refused this one");
        expect(
          await run(readFingerprintBinding(`sentry:${issue}`)),
        ).toBeUndefined();

        expect(
          await post(recorded(`${runId}-failed-2`, issue), "r-2"),
        ).toMatchObject({ status: "processed", replayed: false });
      },
      { failCreate: true },
    );
    expect(opened).toHaveLength(1);
  });
  it("opens new work for a session that ended without a PR once it has been idle past the window — the noise verdict does not mute the issue forever", async () => {
    const opened: Array<Opened> = [];
    const issue = issueOf("idle");
    await withProcess(opened, async (post, run) => {
      const first = await post(recorded(`${runId}-idle-1`, issue), "r-1");
      expect(first.status).toBe("processed");
      // The run judged the alert noise and stopped: no PR, no card, no release. Its last activity
      // is inside the window, so a repeat alert is still its.
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`
            INSERT INTO session_activity (session_id, status, last_activity_at)
            VALUES (${first.sessionId ?? ""}, 'idle', now() - interval '1 hour')
          `;
        }),
      );
      expect(
        await post(recorded(`${runId}-idle-2`, issue), "r-2"),
      ).toMatchObject({ status: "skipped" });

      // Weeks later the issue regresses: the session has been idle past the window.
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`
            UPDATE session_activity SET last_activity_at = now() - interval '30 days'
            WHERE session_id = ${first.sessionId ?? ""}
          `;
        }),
      );
      expect(
        await run(readFingerprintBinding(`sentry:${issue}`)),
      ).toMatchObject({ sessionId: first.sessionId, open: false });
      const regressed = await post(recorded(`${runId}-idle-3`, issue), "r-3");
      expect(regressed).toMatchObject({ status: "processed", replayed: false });
      expect(regressed.sessionId).not.toBe(first.sessionId);
      expect(
        await run(readFingerprintBinding(`sentry:${issue}`)),
      ).toMatchObject({ sessionId: regressed.sessionId, open: true });
    });
    expect(opened).toHaveLength(2);
  });

  it("claims afresh an event that lost to a holder which then gave the binding back, when that event is delivered again", async () => {
    const opened: Array<Opened> = [];
    const issue = issueOf("pending");
    const eventId = `${runId}-pending-loser`;
    const holder = `sentry:event:${runId}-pending-holder`;
    await withProcess(opened, async (post, run) => {
      // Another delivery holds the binding and has not opened its session yet.
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`
            INSERT INTO trigger_fingerprints (fingerprint, request_id)
            VALUES (${`sentry:${issue}`}, ${holder})
          `;
        }),
      );
      expect(await post(recorded(eventId, issue), "r-1")).toEqual({
        status: "skipped",
        replayed: false,
        reason: `sentry:${issue} is being bound by delivery ${holder}, which has not opened its session yet, so this delivery opens no second session`,
      });

      // The holder's delivery fails and gives the binding back (`releaseClaim`).
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`DELETE FROM trigger_fingerprints WHERE fingerprint = ${`sentry:${issue}`}`;
        }),
      );
      // The same event, delivered again (another alert rule, a new Request-ID): its transient skip
      // does not answer for it; it is claimed afresh and opens the issue's session.
      expect(await post(recorded(eventId, issue), "r-2")).toMatchObject({
        status: "processed",
        replayed: false,
      });
    });
    expect(opened).toHaveLength(1);
  });
});

describe("a filtered Sentry alert (LOB-82)", () => {
  const filter: SentryFilter = {
    minLevel: "error",
    environments: ["production"],
    releases: ["web@2.*"],
  };
  const admitted = {
    level: "error",
    environment: "production",
    release: "web@2.0.1",
  };

  it("creates nothing for a wrong severity, environment or release, and records a skip naming the field", async () => {
    const opened: Array<Opened> = [];
    const cases = [
      {
        name: "level",
        over: { level: "warning" },
        reason: 'level "warning" is below SENTRY_MIN_LEVEL "error"',
      },
      {
        name: "environment",
        over: { environment: "staging" },
        reason:
          'environment "staging" is not in SENTRY_ENVIRONMENTS [production]',
      },
      {
        name: "release",
        over: { release: "web@1.9.0" },
        reason: 'release "web@1.9.0" is not in SENTRY_RELEASES [web@2.*]',
      },
    ];
    await withProcess(opened, async (post, run) => {
      for (const { name, over, reason } of cases) {
        const requestId = `req-${runId}-filtered-${name}`;
        const issue = issueOf(`filtered-${name}`);
        const payload = alert(`${runId}-filtered-${name}`, {
          ...admitted,
          ...over,
          issue_id: issue,
        });
        expect(await post(payload, requestId, "event_alert", filter)).toEqual({
          status: "skipped",
          replayed: false,
          reason,
        });
        expect(await deliveryRow(`sentry:delivery:${requestId}`)).toEqual({
          status: "skipped",
          skipReason: reason,
        });
        // A filtered alert binds nothing either.
        expect(
          await run(readFingerprintBinding(`sentry:${issue}`)),
        ).toBeUndefined();
      }

      // The control: the same alert inside the filter opens its session.
      expect(
        await post(
          alert(`${runId}-filtered-control`, {
            ...admitted,
            issue_id: issueOf("filtered-control"),
          }),
          `req-${runId}-filtered-control`,
          "event_alert",
          filter,
        ),
      ).toMatchObject({ status: "processed", replayed: false });
    });
    expect(opened).toHaveLength(1);
  });
});

describe("a Sentry rule with no prompt (LOB-82)", () => {
  it("opens its session with the default investigate-before-edit prompt", async () => {
    const opened: Array<Opened> = [];
    const payload = alert(`${runId}-default-prompt`, {
      project: Number(DEFAULT_PROMPT_PROJECT),
      issue_id: issueOf("default-prompt"),
      release: "web@1.2.3",
    });
    await withProcess(opened, async (post) => {
      expect(await post(payload, "req-default")).toMatchObject({
        status: "processed",
        reason: `rule "${sentryProjectLabel(DEFAULT_PROMPT_PROJECT)}" mapped it to ${repo}`,
      });
    });
    const event = sentryEvent(payload, { resource: "event_alert" });
    if (event === undefined) throw new Error("the alert did not normalize");
    expect(opened[0]?.prompt).toBe(renderPrompt(SENTRY_PROMPT_TEMPLATE, event));
    expect(opened[0]?.prompt).toContain(
      "Investigate before you edit anything.",
    );
  });
});
