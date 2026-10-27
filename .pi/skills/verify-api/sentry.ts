// Drive the Sentry receiver (LOB-81) over real HTTP against a running API, in two phases around a
// restart that `sentry.sh` performs between them.
//
//   MODE=first bun sentry.ts          # the API's first process
//   MODE=after-restart bun sentry.ts  # a fresh process on the same database
//
// Env:
//   API_URL               default http://localhost:9400
//   API_LOG               the API process's log file, which the refusal checks read
//   EVIDENCE_DIR          default .verify/evidence/lob-81
//   SENTRY_STATE          where `first` writes what `after-restart` checks against
//   TRIGGER_REPO          the repo the `sentry` rule maps to (sentry.sh passes the same value in
//                         TRIGGER_RULES, so the two cannot disagree); project 404's rule maps to
//                         `<TRIGGER_REPO>-unregistered`, which nobody registers
//   SENTRY_CLIENT_SECRET  the secret sentry.sh booted the API with
//   SENTRY_RATE_LIMIT     the cap sentry.sh booted the API with
//   DATABASE_URL          the database the API serves, read for the delivery rows
//
// The deliveries are signed exactly the way Sentry's documented verification recomputes them
// (`@repo/core`'s `sentrySignature`: hex HMAC-SHA256 of the body under the client secret), and the
// payload is Sentry's documented issue-alert example with this run's own event id. Nothing here
// resolves `sentry.io`: the driver is the sender.
import { SQL } from "bun";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sentrySignature } from "@repo/core";
import { SessionRpc } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { TriggerOutcome } from "@repo/domain/Trigger";
import { Effect, Option, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, type CheckRecord } from "./harness.ts";

const MODE = process.env["MODE"] ?? "first";
const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const API_LOG = process.env["API_LOG"];
const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://factory:factory@localhost:5442/factory";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/lob-81";
const STATE =
  process.env["SENTRY_STATE"] ?? path.join(EVIDENCE_DIR, "sentry-state.json");
const REPO = RepoSlug.make(
  process.env["TRIGGER_REPO"] ?? "acme/verify-api-sentry",
);
const SECRET = process.env["SENTRY_CLIENT_SECRET"] ?? "";
/** The project sentry.sh routes to a repo nobody registered, and that repo. */
const UNREGISTERED_PROJECT = 404;
const UNREGISTERED_REPO = `${REPO}-unregistered`;
const RATE_LIMIT = Number(process.env["SENTRY_RATE_LIMIT"] ?? "20");

/** A string that is only ever in a payload: no API log line may contain it. */
const CANARY = "lob81-payload-canary-do-not-log";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  mode: string;
  apiUrl: string;
  repo: RepoSlug;
  checks: Record<string, CheckRecord>;
  deliveries: Array<{ requestId: string; status: number; answer: unknown }>;
} = { mode: MODE, apiUrl: API_URL, repo: REPO, checks: {}, deliveries: [] };
const assert = makeChecker(observed);

/** What `first` hands `after-restart`. */
const State = Schema.Struct({
  eventId: Schema.String,
  sessionId: Schema.String,
  sessions: Schema.Finite,
  runId: Schema.String,
});
type State = typeof State.Type;

/** A route refusal (`apps/api/src/Api/Webhook.ts`): a typed code, and the cap when it is `429`. */
const Refusal = Schema.Struct({
  code: Schema.String,
  limit: Schema.optional(Schema.Finite),
  retryAfterSeconds: Schema.optional(Schema.Finite),
});

/** Sentry's documented issue-alert example, for one event in one project. */
const alert = (eventId: string, title: string, project = 1) => ({
  action: "triggered",
  installation: { uuid: "a8e5d37a-696c-4c54-adb5-b3f28d64c7de" },
  data: {
    event: {
      event_id: eventId,
      issue_id: "1117540176",
      title,
      level: "error",
      culprit: "?(<anonymous>)",
      project,
      release: null,
      web_url: `https://sentry.example/organizations/acme/issues/1117540176/events/${eventId}/`,
    },
    triggered_rule: "Very Important Alert!",
  },
  actor: { type: "application", id: "sentry", name: "Sentry" },
});

/**
 * One POST to `/webhooks/sentry`, with the headers Sentry sends. `signature` defaults to the body
 * signed with the run's secret; `null` sends none.
 */
const post = async (
  body: unknown,
  options: {
    readonly requestId: string;
    readonly resource?: string;
    readonly signature?: string | null;
  },
) => {
  const raw = JSON.stringify(body);
  const signature =
    options.signature === undefined
      ? sentrySignature(raw, SECRET)
      : options.signature;
  const response = await fetch(`${API_URL}/webhooks/sentry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "request-id": options.requestId,
      "sentry-hook-resource": options.resource ?? "event_alert",
      "sentry-hook-timestamp": String(Math.floor(Date.now() / 1000)),
      ...(signature === null ? {} : { "sentry-hook-signature": signature }),
    },
    body: raw,
  });
  const answer: unknown = await response.json().catch(() => null);
  observed.deliveries.push({
    requestId: options.requestId,
    status: response.status,
    answer,
  });
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body: answer,
    outcome: Option.getOrNull(
      Schema.decodeUnknownOption(TriggerOutcome)(answer),
    ),
    refusal: Option.getOrNull(Schema.decodeUnknownOption(Refusal)(answer)),
  };
};

/** The `webhook_deliveries` rows for these keys, as the API recorded them. */
const deliveryRows = (requestIds: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const db = new SQL(DATABASE_URL);
    try {
      const rows: Array<{ request_id: string; status: string }> = await db`
        SELECT request_id, status FROM webhook_deliveries
        WHERE request_id IN ${db(requestIds)}
      `;
      return rows;
    } finally {
      await db.close();
    }
  });

/** The API's log, once it holds `needle` (or after a short wait, as it stands). */
const readLog = (needle: string) =>
  Effect.promise(async () => {
    if (API_LOG === undefined) return "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const text = await readFile(API_LOG, "utf8").catch(() => "");
      if (text.includes(needle)) return text;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return await readFile(API_LOG, "utf8").catch(() => "");
  });

const ProtocolLive = protocolFor(API_URL);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);

  /** How many sessions this drive's own repo has (it is nobody else's repo). */
  const countForRepo = Effect.gen(function* () {
    const listed = yield* client.listSessions({ limit: 100 });
    return listed.sessions.filter((entry) => entry.repo === REPO).length;
  });

  if (MODE === "first") {
    const runId = `${Date.now()}`;
    const eventId = `lob81${runId}`;
    const title = `ReferenceError: lob-81 ${runId}`;
    yield* client.registerRepo({ repo: REPO, defaultBaseRef: "main" });
    const before = yield* countForRepo;

    // Feature: one session per delivery. The same signed payload, posted twice with the same
    // headers, must open one session; the second answer says `replayed`.
    const payload = alert(eventId, title);
    const first = yield* Effect.promise(() =>
      post(payload, { requestId: `req-${runId}-1` }),
    );
    assert(
      "a signed Sentry alert opens a session",
      first.status === 200 &&
        first.outcome?.status === "processed" &&
        first.outcome.replayed === false &&
        first.outcome.sessionId !== undefined,
      `status=${first.status} body=${JSON.stringify(first.body)}`,
    );
    const second = yield* Effect.promise(() =>
      post(payload, { requestId: `req-${runId}-1` }),
    );
    assert(
      "the same signed payload again is a replay",
      second.status === 200 &&
        second.outcome?.status === "processed" &&
        second.outcome.replayed === true,
      `status=${second.status} body=${JSON.stringify(second.body)}`,
    );
    const afterTwice = yield* countForRepo;
    assert(
      "exactly one session exists for the two posts",
      afterTwice === before + 1,
      `sessions ${before}→${afterTwice}`,
    );
    const sessionId = first.outcome?.sessionId;
    if (sessionId !== undefined) {
      const snapshot = yield* client.getSession({ sessionId });
      const prompt = snapshot.entries.find(
        (entry) => entry.kind === "user",
      )?.text;
      assert(
        "the alert's title and rule are the session's first message",
        (prompt ?? "").includes(title) &&
          (prompt ?? "").includes("alert rule: Very Important Alert!"),
        `prompt=${JSON.stringify(prompt ?? null)}`,
      );
    }

    // Feature: authentication. A missing and a wrong signature are refused before anything is
    // recorded, and the refusal is logged without the payload: the bodies carry the canary.
    const unsignedEvent = `lob81${runId}unsigned`;
    const unsignedRequest = `req-${runId}-missing-signature`;
    const missing = yield* Effect.promise(() =>
      post(alert(unsignedEvent, `missing ${CANARY}`), {
        requestId: unsignedRequest,
        signature: null,
      }),
    );
    const badEvent = `lob81${runId}badsig`;
    const badRequest = `req-${runId}-bad-signature`;
    const badPayload = alert(badEvent, `bad ${CANARY}`);
    const bad = yield* Effect.promise(() =>
      post(badPayload, {
        requestId: badRequest,
        // A real signature, of another body.
        signature: sentrySignature(`${JSON.stringify(badPayload)} `, SECRET),
      }),
    );
    const refusedRows = yield* deliveryRows([
      `sentry:event:${unsignedEvent}`,
      `sentry:event:${badEvent}`,
    ]);
    const afterRefusals = yield* countForRepo;
    assert(
      "a missing signature is 401 missing-signature",
      missing.status === 401 && missing.refusal?.code === "missing-signature",
      `status=${missing.status} body=${JSON.stringify(missing.body)}`,
    );
    assert(
      "a wrong signature is 401 bad-signature",
      bad.status === 401 && bad.refusal?.code === "bad-signature",
      `status=${bad.status} body=${JSON.stringify(bad.body)}`,
    );
    assert(
      "a refused signature creates no session and records no delivery",
      afterRefusals === afterTwice && refusedRows.length === 0,
      `sessions ${afterTwice}→${afterRefusals} rows=${JSON.stringify(refusedRows)}`,
    );
    const log = yield* readLog(badRequest);
    const missingLine = log
      .split("\n")
      .find((line) =>
        line.includes(`refused missing-signature (delivery ${unsignedRequest}`),
      );
    const badLine = log
      .split("\n")
      .find((line) =>
        line.includes(`refused bad-signature (delivery ${badRequest}`),
      );
    assert(
      "each refusal is logged, naming its reason and its delivery",
      missingLine !== undefined && badLine !== undefined,
      `missing=${JSON.stringify(missingLine ?? null)} bad=${JSON.stringify(badLine ?? null)}`,
    );
    assert(
      "no log line carries the refused payload",
      API_LOG !== undefined && log.length > 0 && !log.includes(CANARY),
      `log=${API_LOG ?? "unset"} bytes=${log.length} canary=${log.includes(CANARY)}`,
    );

    // Feature: the cap counts only work. A firehose of signed `issue` deliveries well past
    // SENTRY_RATE_LIMIT — which no rule lets start work — is answered and recorded as skips, none
    // of them `429`: they spend none of the budget the alerts below need.
    const firehose = [];
    for (let n = 1; n <= RATE_LIMIT + 4; n += 1) {
      const requestId = `req-${runId}-firehose-${n}`;
      firehose.push({
        requestId,
        answer: yield* Effect.promise(() =>
          post(
            {
              action: "resolved",
              data: { issue: { id: `${runId}${n}`, title: `firehose ${n}` } },
            },
            { requestId, resource: "issue" },
          ),
        ),
      });
    }
    const firehoseRows = yield* deliveryRows(
      firehose.map((entry) => `sentry:delivery:${entry.requestId}`),
    );
    assert(
      "a firehose of deliveries that start nothing is never rate-limited, and each is its skip",
      firehose.every(
        ({ answer }) =>
          answer.status === 200 &&
          answer.outcome?.status === "skipped" &&
          answer.outcome.reason === 'action "issue:resolved" is not "create"',
      ) &&
        firehoseRows.length === firehose.length &&
        firehoseRows.every((row) => row.status === "skipped"),
      `statuses=${firehose.map((entry) => entry.answer.status).join(",")} rows=${firehoseRows.length}/${firehose.length}`,
    );

    // Feature: the rate cap. A burst of signed alerts well past SENTRY_RATE_LIMIT: the ones past
    // the cap are 429 rate-limited with Retry-After — typed, never a 500 — and record nothing.
    // They name project 404, whose rule routes to a repo nobody registered, so the ones inside the
    // cap are recorded skips that open no session, and the burst measures the cap, not the
    // session layer. The two alerts above spent two of this window's tokens already.
    const burst = RATE_LIMIT + 4;
    const answers = [];
    for (let n = 1; n <= burst; n += 1) {
      const requestId = `req-${runId}-burst-${n}`;
      const burstEvent = `lob81${runId}burst${n}`;
      answers.push({
        requestId,
        eventId: burstEvent,
        answer: yield* Effect.promise(() =>
          post(alert(burstEvent, `burst ${n}`, UNREGISTERED_PROJECT), {
            requestId,
          }),
        ),
      });
    }
    const limited = answers.filter((entry) => entry.answer.status === 429);
    const admitted = answers.filter((entry) => entry.answer.status === 200);
    const limitedRows = yield* deliveryRows(
      limited.map((entry) => `sentry:event:${entry.eventId}`),
    );
    assert(
      "the burst past the cap is refused 429, and nothing in it is a 5xx",
      limited.length >= burst - RATE_LIMIT &&
        admitted.length <= RATE_LIMIT &&
        limited.length + admitted.length === burst,
      `statuses=${answers.map((entry) => entry.answer.status).join(",")} limit=${RATE_LIMIT}`,
    );
    assert(
      "every refusal is typed rate-limited with Retry-After and the cap it hit",
      limited.length > 0 &&
        limited.every(
          ({ answer }) =>
            answer.refusal?.code === "rate-limited" &&
            answer.refusal.limit === RATE_LIMIT &&
            answer.retryAfter !== null &&
            Number(answer.retryAfter) >= 1 &&
            answer.refusal.retryAfterSeconds === Number(answer.retryAfter),
        ),
      `first=${JSON.stringify(limited[0]?.answer.body ?? null)} retry-after=${limited[0]?.answer.retryAfter ?? null}`,
    );
    assert(
      "a rate-limited delivery records nothing; one inside the cap is recorded as its skip",
      limitedRows.length === 0 &&
        admitted.length > 0 &&
        admitted.every(
          ({ answer }) =>
            answer.outcome?.status === "skipped" &&
            answer.outcome.reason ===
              `repo ${UNREGISTERED_REPO} is not registered`,
        ),
      `limited rows=${limitedRows.length} admitted=${JSON.stringify(admitted.map(({ answer }) => answer.outcome))}`,
    );
    const afterBurst = yield* countForRepo;
    assert(
      "the burst opened no session",
      afterBurst === afterTwice,
      `sessions ${afterTwice}→${afterBurst}`,
    );

    if (sessionId !== undefined) {
      const state: State = { eventId, sessionId, sessions: afterBurst, runId };
      yield* Effect.promise(() =>
        writeFile(STATE, `${JSON.stringify({ ...state, title }, null, 2)}\n`),
      );
    }
    return;
  }

  // MODE=after-restart: a fresh process, the same database. The first process's memory is gone,
  // so a replay here is the `webhook_deliveries` row, nothing else.
  const raw: unknown = JSON.parse(
    yield* Effect.promise(() => readFile(STATE, "utf8")),
  );
  const state = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ ...State.fields, title: Schema.String }),
  )(raw);
  const replay = yield* Effect.promise(() =>
    post(alert(state.eventId, state.title), {
      requestId: `req-${state.runId}-after-restart`,
    }),
  );
  const afterReplay = yield* countForRepo;
  assert(
    "after a restart, the same alert is a replay of the processed delivery",
    replay.status === 200 &&
      replay.outcome?.status === "processed" &&
      replay.outcome.replayed === true,
    `status=${replay.status} body=${JSON.stringify(replay.body)}`,
  );
  assert(
    "and the restarted process opened no second session",
    afterReplay === state.sessions,
    `sessions ${state.sessions}→${afterReplay}`,
  );
  const rows = yield* deliveryRows([`sentry:event:${state.eventId}`]);
  assert(
    "the dedupe row the first process wrote is still processed",
    rows.length === 1 && rows[0]?.status === "processed",
    `rows=${JSON.stringify(rows)}`,
  );

  // The control: the restarted process does open work, so the replay above is the dedupe and not
  // a process that could not create anything.
  const freshEvent = `${state.eventId}fresh`;
  const fresh = yield* Effect.promise(() =>
    post(alert(freshEvent, `fresh ${state.title}`), {
      requestId: `req-${state.runId}-fresh`,
    }),
  );
  const afterFresh = yield* countForRepo;
  assert(
    "a new alert in the restarted process still opens its session",
    fresh.status === 200 &&
      fresh.outcome?.status === "processed" &&
      fresh.outcome.replayed === false &&
      afterFresh === afterReplay + 1,
    `status=${fresh.status} body=${JSON.stringify(fresh.body)} sessions ${afterReplay}→${afterFresh}`,
  );
});

try {
  await Effect.runPromise(
    program.pipe(Effect.provide(ProtocolLive), Effect.scoped),
  );
} catch (error) {
  assert("drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, `sentry-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);

console.log(`\nevidence: ${path.resolve(EVIDENCE_DIR)}`);
const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
