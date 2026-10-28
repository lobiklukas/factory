// Drive the Sentry receiver (LOB-81), its mapping (LOB-82) and its link-back (LOB-83) over real HTTP
// against a running API, in phases around a restart that `sentry.sh` performs between them.
//
//   MODE=linkback bun sentry.ts       # the API's first process: the note on the alert's Sentry issue
//   MODE=first bun sentry.ts          # the same process: receiver and mapping (and one note per alert)
//   MODE=after-restart bun sentry.ts  # a fresh process on the same database
//
// Env:
//   API_URL               default http://localhost:9400
//   API_LOG               the API process's log file, which the refusal checks read
//   EVIDENCE_DIR          default .verify/evidence/lob-82
//   SENTRY_STATE          where `first` writes what `after-restart` checks against
//   TRIGGER_REPO          the repo the `sentry` rule maps to (sentry.sh passes the same value in
//                         TRIGGER_RULES, so the two cannot disagree); project 404's rule maps to
//                         `<TRIGGER_REPO>-unregistered`, which nobody registers
//   SENTRY_CLIENT_SECRET  the secret sentry.sh booted the API with
//   SENTRY_RATE_LIMIT     the cap sentry.sh booted the API with
//   SENTRY_MIN_LEVEL, SENTRY_ENVIRONMENTS, SENTRY_RELEASES
//                         the filter sentry.sh booted the API with (error, production, verify@*):
//                         every alert the drive means to be work carries `level: error`,
//                         `environment: production` and `release: verify@1.0.0`
//   DATABASE_URL          the database the API serves, read for the delivery rows
//   SENTRY_FAKE_LEDGER    the ledger file of `sentry-api-fake.ts`, the Sentry REST API the API's
//                         write-back calls (LOB-83): the drive counts the notes it holds
//   SENTRY_SESSION_URL_BASE
//                         the base the API links a session under, so a note carries the session URL
//   SENTRY_LOSE_ACK_ISSUE, SENTRY_FAIL_ISSUE, SENTRY_HANG_ISSUE
//                         the three Sentry issue ids the fake was started to misbehave for: its first
//                         note create applied and then the connection dropped, every request
//                         answered 503, and every request never answered
//
// The deliveries are signed exactly the way Sentry's documented verification recomputes them
// (`@repo/core`'s `sentrySignature`: hex HMAC-SHA256 of the body under the client secret), and the
// payload is Sentry's documented issue-alert example with this run's own event id. Nothing here
// resolves `sentry.io`: the driver is the sender.
import { SQL } from "bun";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SENTRY_PROMPT_TEMPLATE,
  sentryEvent,
  sentryEventRequestId,
  sentrySignature,
} from "@repo/core";
import { SessionRpc } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { renderPrompt, TriggerOutcome } from "@repo/domain/Trigger";
import { Effect, Option, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, type CheckRecord } from "./harness.ts";

const MODE = process.env["MODE"] ?? "first";
const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const API_LOG = process.env["API_LOG"];
const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://factory:factory@localhost:5442/factory";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/lob-83";
const STATE =
  process.env["SENTRY_STATE"] ?? path.join(EVIDENCE_DIR, "sentry-state.json");
/** What `linkback` hands `after-restart`: the lost-ack case, to redeliver across the restart. */
const LINKBACK_STATE = STATE.replace(/\.json$/, "-linkback.json");
const REPO = RepoSlug.make(
  process.env["TRIGGER_REPO"] ?? "acme/verify-api-sentry",
);
const SECRET = process.env["SENTRY_CLIENT_SECRET"] ?? "";
/** The project sentry.sh routes to a repo nobody registered, and that repo. */
const UNREGISTERED_PROJECT = 404;
const UNREGISTERED_REPO = `${REPO}-unregistered`;
/** The project sentry.sh routes with a blank prompt, so the default template is what it gets. */
const DEFAULT_PROMPT_PROJECT = 777;
/** The release every alert meant as work carries: inside sentry.sh's `SENTRY_RELEASES=verify@*`. */
const RELEASE = "verify@1.0.0";
const RATE_LIMIT = Number(process.env["SENTRY_RATE_LIMIT"] ?? "20");
const SENTRY_FAKE_LEDGER = process.env["SENTRY_FAKE_LEDGER"] ?? "";
const SESSION_URL_BASE = process.env["SENTRY_SESSION_URL_BASE"] ?? "";
const LOSE_ACK_ISSUE = process.env["SENTRY_LOSE_ACK_ISSUE"] ?? "lose-ack-issue";
const FAIL_ISSUE = process.env["SENTRY_FAIL_ISSUE"] ?? "fail-issue";
const HANG_ISSUE = process.env["SENTRY_HANG_ISSUE"] ?? "hang-issue";
/** The longest a link-back that never gets an answer may hold a delivery: the API's budget is 4s. */
const HANG_BUDGET_CEILING_MS = 15_000;

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

/** The Sentry issue an event belongs to, unless a case names another: one issue per event. */
const issueOf = (eventId: string): string => `issue-${eventId}`;

/**
 * Sentry's documented issue-alert example, for one event in one project and one issue — inside the
 * drive's filter (`level: error`, `environment: production`, `release: verify@1.0.0`) unless `over`
 * says otherwise.
 */
const alert = (
  eventId: string,
  title: string,
  options: {
    readonly project?: number;
    readonly issue?: string;
    readonly over?: Record<string, unknown>;
  } = {},
) => {
  const issue = options.issue ?? issueOf(eventId);
  return {
    action: "triggered",
    installation: { uuid: "a8e5d37a-696c-4c54-adb5-b3f28d64c7de" },
    data: {
      event: {
        event_id: eventId,
        issue_id: issue,
        title,
        level: "error",
        culprit: "?(<anonymous>)",
        project: options.project ?? 1,
        release: RELEASE,
        environment: "production",
        web_url: `https://sentry.example/organizations/acme/issues/${issue}/events/${eventId}/`,
        ...options.over,
      },
      triggered_rule: "Very Important Alert!",
    },
    actor: { type: "application", id: "sentry", name: "Sentry" },
  };
};

/** The title a session opened for `alert(…, title)` carries: its environment and release (LOB-82). */
const sessionTitleOf = (title: string): string =>
  `${title} (production, release ${RELEASE})`;

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
      const rows: Array<{
        request_id: string;
        status: string;
        skip_reason: string | null;
      }> = await db`
        SELECT request_id, status, skip_reason FROM webhook_deliveries
        WHERE request_id IN ${db(requestIds)}
      `;
      return rows;
    } finally {
      await db.close();
    }
  });

/** The `trigger_fingerprints` row a Sentry issue is bound by (LOB-82), as the API recorded it. */
const bindingOf = (issue: string) =>
  Effect.promise(async () => {
    const db = new SQL(DATABASE_URL);
    try {
      const rows: Array<{ request_id: string; session_id: string | null }> =
        await db`
          SELECT request_id, session_id FROM trigger_fingerprints
          WHERE fingerprint = ${`sentry:${issue}`}
        `;
      return rows[0] ?? null;
    } finally {
      await db.close();
    }
  });

/** The skip reason a repeat alert for `issue` records while its first session is open. */
const boundReason = (issue: string, sessionId: string, eventId: string) =>
  `sentry:${issue} is bound to open session ${sessionId} (delivery sentry:event:${eventId}), so this delivery opens no second session; it frees when that session's workspace is released or after 3 days without activity, and \`factory discard ${sessionId}\` frees it now`;

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

/** What the fake Sentry API holds: every request it saw, and each issue's notes. */
type SentryLedger = {
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | null;
  }>;
  readonly issues: Record<string, { readonly notes: ReadonlyArray<string> }>;
  readonly lostAcks: ReadonlyArray<string>;
};

const readSentryLedger = (): Promise<SentryLedger> =>
  readFile(SENTRY_FAKE_LEDGER, "utf8").then(
    (text) => JSON.parse(text) as SentryLedger,
  );

/** The notes the fake holds for one Sentry issue, and the requests it saw for it, by method. */
const ledgerFor = async (issue: string) => {
  const ledger = await readSentryLedger();
  const path = `/api/0/issues/${encodeURIComponent(issue)}/comments/`;
  const requests = ledger.requests.filter((request) => request.path === path);
  return {
    notes: ledger.issues[issue]?.notes ?? [],
    gets: requests.filter((request) => request.method === "GET").length,
    posts: requests.filter((request) => request.method === "POST").length,
    requests: requests.length,
    lostAck: ledger.lostAcks.includes(issue),
    total: ledger.requests.length,
  };
};

/** The note the API posts for a session: it names the session and links to it under the base. */
const noteFor = (sessionId: string): string =>
  `Factory is investigating this alert in session ${sessionId} (${SESSION_URL_BASE}/${sessionId}).`;

/** Forget a delivery's processed row: the state a crash between the write-back and `processed` leaves. */
const forgetDelivery = (requestId: string) =>
  Effect.promise(async () => {
    const db = new SQL(DATABASE_URL);
    try {
      await db`DELETE FROM webhook_deliveries WHERE request_id = ${requestId}`;
    } finally {
      await db.close();
    }
  });

const ProtocolLive = protocolFor(API_URL);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);

  /** How many sessions this drive's own repo has (it is nobody else's repo). */
  const countForRepo = Effect.gen(function* () {
    const listed = yield* client.listSessions({ limit: 100 });
    return listed.sessions.filter((entry) => entry.repo === REPO).length;
  });

  if (MODE === "linkback") {
    // Feature (LOB-83): the alert points at the session investigating it, exactly once, and a
    // link-back that cannot be made never costs the session. Each case is one Sentry issue the fake
    // was started to treat in its own way, so the ledger answers for it alone.
    const runId = `${Date.now()}`;
    yield* client.registerRepo({ repo: REPO, defaultBaseRef: "main" });
    const notesLine = (sessionId: string, needle: string) =>
      readLog(needle).pipe(
        Effect.map((log) =>
          log
            .split("\n")
            .filter(
              (line) => line.includes("sentry: ") && line.includes(sessionId),
            )
            .filter((line) => line.includes(needle)),
        ),
      );

    // A lost acknowledgement: the note lands, the connection drops, the delivery is still processed.
    const loseEvent = `lob83${runId}lose`;
    const losePayload = alert(loseEvent, `lose ack ${runId}`, {
      issue: LOSE_ACK_ISSUE,
    });
    const lost = yield* Effect.promise(() =>
      post(losePayload, { requestId: `req-${runId}-lose` }),
    );
    const loseSession = lost.outcome?.sessionId;
    assert(
      "an alert whose note's acknowledgement is lost is still a processed delivery with its session",
      lost.status === 200 &&
        lost.outcome?.status === "processed" &&
        lost.outcome.replayed === false &&
        loseSession !== undefined,
      `status=${lost.status} body=${JSON.stringify(lost.body)}`,
    );
    if (loseSession !== undefined) {
      const afterLost = yield* Effect.promise(() => ledgerFor(LOSE_ACK_ISSUE));
      assert(
        "the lost acknowledgement left exactly one note on the issue, and the fake saw the connection dropped",
        afterLost.lostAck &&
          afterLost.notes.length === 1 &&
          afterLost.notes[0] === noteFor(loseSession) &&
          afterLost.posts === 1,
        `ledger=${JSON.stringify(afterLost)}`,
      );
      const lostLines = yield* notesLine(
        loseSession,
        `could not link issue ${LOSE_ACK_ISSUE} to session ${loseSession}`,
      );
      assert(
        "one log line names the issue, the session and the cause of the dropped call",
        lostLines.length === 1 &&
          lostLines[0]?.includes("could not be reached") === true,
        `lines=${JSON.stringify(lostLines)}`,
      );

      // The same event again, under a new Request-ID: the dedupe row answers, nothing is called.
      const beforeReplay = yield* Effect.promise(() =>
        ledgerFor(LOSE_ACK_ISSUE),
      );
      const replay = yield* Effect.promise(() =>
        post(losePayload, { requestId: `req-${runId}-lose-again` }),
      );
      const afterReplay = yield* Effect.promise(() =>
        ledgerFor(LOSE_ACK_ISSUE),
      );
      assert(
        "a redelivery of the same event_id posts no note and makes no request",
        replay.outcome?.status === "processed" &&
          replay.outcome.replayed === true &&
          afterReplay.notes.length === 1 &&
          afterReplay.requests === beforeReplay.requests,
        `status=${replay.status} before=${beforeReplay.requests} after=${JSON.stringify(afterReplay)}`,
      );

      // The crash window: the note landed, `processed` never did. The claim is gone, so the same
      // event runs again and the seam calls the write-back for the same session a second time.
      yield* forgetDelivery(sentryEventRequestId(loseEvent));
      const window = yield* Effect.promise(() =>
        post(losePayload, { requestId: `req-${runId}-lose-window` }),
      );
      const afterWindow = yield* Effect.promise(() =>
        ledgerFor(LOSE_ACK_ISSUE),
      );
      assert(
        "a delivery replayed after the note landed but before processed was written posts no second note",
        window.outcome?.status === "processed" &&
          window.outcome.replayed === false &&
          window.outcome.sessionId === loseSession &&
          afterWindow.notes.length === 1 &&
          afterWindow.posts === 1 &&
          afterWindow.gets === afterReplay.gets + 1,
        `status=${window.status} body=${JSON.stringify(window.body)} ledger=${JSON.stringify(afterWindow)}`,
      );
      yield* Effect.promise(() =>
        writeFile(
          LINKBACK_STATE,
          `${JSON.stringify({ eventId: loseEvent, sessionId: loseSession, runId }, null, 2)}\n`,
        ),
      );
    }

    // A Sentry that answers 5xx: the delivery is processed, the session runs, one line says why.
    const failEvent = `lob83${runId}fail`;
    const failed = yield* Effect.promise(() =>
      post(alert(failEvent, `fail ${runId}`, { issue: FAIL_ISSUE }), {
        requestId: `req-${runId}-fail`,
      }),
    );
    const failSession = failed.outcome?.sessionId;
    assert(
      "a link-back that gets HTTP 503 does not fail the delivery",
      failed.status === 200 &&
        failed.outcome?.status === "processed" &&
        failSession !== undefined,
      `status=${failed.status} body=${JSON.stringify(failed.body)}`,
    );
    if (failSession !== undefined) {
      const failLines = yield* notesLine(
        failSession,
        `could not link issue ${FAIL_ISSUE} to session ${failSession}`,
      );
      const afterFail = yield* Effect.promise(() => ledgerFor(FAIL_ISSUE));
      assert(
        "and one log line names the issue, the session and the HTTP 503",
        failLines.length === 1 &&
          failLines[0]?.includes("HTTP 503") === true &&
          afterFail.notes.length === 0,
        `lines=${JSON.stringify(failLines)} ledger=${JSON.stringify(afterFail)}`,
      );
      const snapshot = yield* client.getSession({ sessionId: failSession });
      assert(
        "the session whose link-back failed has its prompt and runs",
        snapshot.entries.some((entry) => entry.kind === "user"),
        `entries=${snapshot.entries.length}`,
      );
    }

    // A Sentry that never answers: the budget ends the call, and the delivery goes on.
    const hangEvent = `lob83${runId}hang`;
    const hangStarted = Date.now();
    const hung = yield* Effect.promise(() =>
      post(alert(hangEvent, `hang ${runId}`, { issue: HANG_ISSUE }), {
        requestId: `req-${runId}-hang`,
      }),
    );
    const hangElapsed = Date.now() - hangStarted;
    const hangSession = hung.outcome?.sessionId;
    assert(
      "a link-back that gets no answer is abandoned at its budget and the delivery is processed",
      hung.status === 200 &&
        hung.outcome?.status === "processed" &&
        hangSession !== undefined &&
        hangElapsed >= 3_000 &&
        hangElapsed < HANG_BUDGET_CEILING_MS,
      `status=${hung.status} elapsed=${hangElapsed}ms body=${JSON.stringify(hung.body)}`,
    );
    if (hangSession !== undefined) {
      const hangLines = yield* notesLine(
        hangSession,
        `issue ${HANG_ISSUE} was not linked to session ${hangSession} within`,
      );
      assert(
        "and one log line names the issue, the session and the budget",
        hangLines.length === 1,
        `lines=${JSON.stringify(hangLines)}`,
      );
    }

    // An alert with no issue_id has nowhere to be answered: its session opens, nothing is posted.
    const bareEvent = `lob83${runId}bare`;
    const beforeBare = yield* Effect.promise(() => readSentryLedger());
    const bare = yield* Effect.promise(() =>
      post(
        alert(bareEvent, `no issue ${runId}`, {
          over: { issue_id: undefined },
        }),
        {
          requestId: `req-${runId}-bare`,
        },
      ),
    );
    const afterBare = yield* Effect.promise(() => readSentryLedger());
    const bareSession = bare.outcome?.sessionId;
    assert(
      "an alert with no issue_id opens its session and makes no Sentry request",
      bare.status === 200 &&
        bare.outcome?.status === "processed" &&
        bareSession !== undefined &&
        afterBare.requests.length === beforeBare.requests.length,
      `status=${bare.status} body=${JSON.stringify(bare.body)} requests ${beforeBare.requests.length}→${afterBare.requests.length}`,
    );
    if (bareSession !== undefined) {
      const bareLines = yield* notesLine(
        bareSession,
        `alert ${bareEvent} names no issue_id`,
      );
      assert(
        "and the log says why there is no link",
        bareLines.length === 1,
        `lines=${JSON.stringify(bareLines)}`,
      );
    }
    return;
  }

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
      // Feature (LOB-83): the alert's Sentry issue holds exactly one note, naming this session and
      // its URL, after the post and its replay.
      const linked = yield* Effect.promise(() => ledgerFor(issueOf(eventId)));
      assert(
        "a mapped alert leaves exactly one note on its Sentry issue, carrying the session URL",
        linked.notes.length === 1 &&
          linked.notes[0] === noteFor(sessionId) &&
          linked.posts === 1,
        `ledger=${JSON.stringify(linked)}`,
      );
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

      // Feature (LOB-82): the session's title says where it broke.
      const listed = yield* client.listSessions({ limit: 100 });
      const summary = listed.sessions.find((entry) => entry.id === sessionId);
      assert(
        "the session's title carries the alert's environment and release",
        summary?.title === sessionTitleOf(title),
        `title=${JSON.stringify(summary?.title ?? null)}`,
      );

      // Feature (LOB-82): the Sentry issue is bound to the session, in Postgres.
      const binding = yield* bindingOf(issueOf(eventId));
      assert(
        "the alert's Sentry issue is bound to its session",
        binding?.session_id === sessionId &&
          binding.request_id === `sentry:event:${eventId}`,
        `binding=${JSON.stringify(binding)}`,
      );

      // Feature (LOB-82): another event in the same issue — the alert firing again — opens no
      // second session; it is a recorded skip naming the open one.
      const repeatEvent = `${eventId}repeat`;
      const repeat = yield* Effect.promise(() =>
        post(
          alert(repeatEvent, title, {
            issue: issueOf(eventId),
            over: { level: "fatal" },
          }),
          { requestId: `req-${runId}-repeat` },
        ),
      );
      const repeatRows = yield* deliveryRows([`sentry:event:${repeatEvent}`]);
      const afterRepeat = yield* countForRepo;
      const expectedReason = boundReason(issueOf(eventId), sessionId, eventId);
      assert(
        "a new event in the same Sentry issue is a skip naming the open session",
        repeat.status === 200 &&
          repeat.outcome?.status === "skipped" &&
          repeat.outcome.reason === expectedReason &&
          repeatRows[0]?.status === "skipped" &&
          repeatRows[0].skip_reason === expectedReason,
        `status=${repeat.status} body=${JSON.stringify(repeat.body)} rows=${JSON.stringify(repeatRows)}`,
      );
      assert(
        "and it opened no second session",
        afterRepeat === afterTwice,
        `sessions ${afterTwice}→${afterRepeat}`,
      );
      // Feature (LOB-83): the second alert LOB-82 bound to this session called Sentry not at all.
      const afterBound = yield* Effect.promise(() =>
        ledgerFor(issueOf(eventId)),
      );
      assert(
        "a second alert bound to the same session posts no second note and makes no request",
        afterBound.notes.length === 1 &&
          afterBound.posts === 1 &&
          afterBound.requests === 2,
        `ledger=${JSON.stringify(afterBound)}`,
      );
    }

    // Feature (LOB-82): the filter. An alert of the wrong severity, environment or release is a
    // recorded skip that names the field and the value, and opens nothing.
    const filterCases = [
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
        over: { release: "other@2.0.0" },
        reason: 'release "other@2.0.0" is not in SENTRY_RELEASES [verify@*]',
      },
    ];
    const filtered = [];
    for (const { name, over, reason } of filterCases) {
      const requestId = `req-${runId}-filtered-${name}`;
      filtered.push({
        name,
        reason,
        requestId,
        answer: yield* Effect.promise(() =>
          post(
            alert(`lob82${runId}filtered${name}`, `filtered ${name}`, { over }),
            {
              requestId,
            },
          ),
        ),
      });
    }
    const filteredRows = yield* deliveryRows(
      filtered.map((entry) => `sentry:delivery:${entry.requestId}`),
    );
    const afterFiltered = yield* countForRepo;
    for (const entry of filtered) {
      const row = filteredRows.find(
        (candidate) =>
          candidate.request_id === `sentry:delivery:${entry.requestId}`,
      );
      assert(
        `an alert of the wrong ${entry.name} is a recorded skip naming the field`,
        entry.answer.status === 200 &&
          entry.answer.outcome?.status === "skipped" &&
          entry.answer.outcome.reason === entry.reason &&
          row?.status === "skipped" &&
          row.skip_reason === entry.reason,
        `status=${entry.answer.status} body=${JSON.stringify(entry.answer.body)} row=${JSON.stringify(row ?? null)}`,
      );
    }
    assert(
      "the filtered alerts opened no session",
      afterFiltered === afterTwice,
      `sessions ${afterTwice}→${afterFiltered}`,
    );

    // Feature (LOB-82): a rule that writes no prompt gets the default investigate-before-edit one,
    // rendered over the alert's own title and facts.
    const defaultEvent = `lob82${runId}default`;
    const defaultPayload = alert(defaultEvent, `default prompt ${runId}`, {
      project: DEFAULT_PROMPT_PROJECT,
    });
    const defaulted = yield* Effect.promise(() =>
      post(defaultPayload, { requestId: `req-${runId}-default` }),
    );
    const normalized = sentryEvent(defaultPayload, {
      resource: "event_alert",
    });
    const defaultSession = defaulted.outcome?.sessionId;
    const defaultPrompt =
      defaultSession === undefined
        ? undefined
        : (yield* client.getSession({
            sessionId: defaultSession,
          })).entries.find((entry) => entry.kind === "user")?.text;
    assert(
      "a rule with no prompt opens its session with the default investigate-before-edit prompt",
      defaulted.status === 200 &&
        defaulted.outcome?.status === "processed" &&
        normalized !== undefined &&
        defaultPrompt === renderPrompt(SENTRY_PROMPT_TEMPLATE, normalized) &&
        defaultPrompt.includes("Investigate before you edit anything."),
      `status=${defaulted.status} prompt=${JSON.stringify(defaultPrompt ?? null)}`,
    );
    const afterDefault = yield* countForRepo;

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
      afterRefusals === afterDefault && refusedRows.length === 0,
      `sessions ${afterDefault}→${afterRefusals} rows=${JSON.stringify(refusedRows)}`,
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
    // session layer. The four alerts above that can start work (the first, its replay, the repeat
    // in its issue and the default-prompt one) spent four of this window's tokens already, and the
    // `linkback` phase's six (LOB-83: the lost-ack alert and its two redeliveries, the 503, the
    // hang and the one with no issue id) six more; the filtered ones spent none. `sentry.sh` sizes
    // the cap so two tokens are left for the burst's admitted ones.
    const burst = RATE_LIMIT + 4;
    const answers = [];
    for (let n = 1; n <= burst; n += 1) {
      const requestId = `req-${runId}-burst-${n}`;
      const burstEvent = `lob81${runId}burst${n}`;
      answers.push({
        requestId,
        eventId: burstEvent,
        answer: yield* Effect.promise(() =>
          post(
            alert(burstEvent, `burst ${n}`, {
              project: UNREGISTERED_PROJECT,
            }),
            { requestId },
          ),
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
      afterBurst === afterDefault,
      `sessions ${afterDefault}→${afterBurst}`,
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

  // LOB-82: the binding is a Postgres row, so the restarted process still knows the issue's session:
  // another event in it is a skip naming that session, and the row still names it.
  const repeatEvent = `${state.eventId}afterrestart`;
  const repeat = yield* Effect.promise(() =>
    post(alert(repeatEvent, state.title, { issue: issueOf(state.eventId) }), {
      requestId: `req-${state.runId}-repeat-after-restart`,
    }),
  );
  const afterRepeat = yield* countForRepo;
  assert(
    "after a restart, a new event in the same Sentry issue is a skip naming the open session",
    repeat.status === 200 &&
      repeat.outcome?.status === "skipped" &&
      repeat.outcome.reason ===
        boundReason(issueOf(state.eventId), state.sessionId, state.eventId) &&
      afterRepeat === state.sessions,
    `status=${repeat.status} body=${JSON.stringify(repeat.body)} sessions ${state.sessions}→${afterRepeat}`,
  );
  const binding = yield* bindingOf(issueOf(state.eventId));
  assert(
    "the Sentry issue's binding is readable after the restart",
    binding?.session_id === state.sessionId,
    `binding=${JSON.stringify(binding)}`,
  );

  // LOB-83: the note is Sentry's, not the process's, so the restart changes nothing about it: the
  // first alert's issue still holds its one note, and the replay and the repeat above added none.
  const restartedLedger = yield* Effect.promise(() =>
    ledgerFor(issueOf(state.eventId)),
  );
  assert(
    "after a restart, the first alert's issue still holds exactly one note",
    restartedLedger.notes.length === 1 &&
      restartedLedger.notes[0] === noteFor(state.sessionId) &&
      restartedLedger.posts === 1,
    `ledger=${JSON.stringify(restartedLedger)}`,
  );
  // The lost-acknowledgement case, replayed across the restart with its processed row gone: the
  // restarted process runs the write-back for the session the first one opened, finds its note.
  const linkback: unknown = yield* Effect.promise(() =>
    readFile(LINKBACK_STATE, "utf8").then(
      (text) => JSON.parse(text) as unknown,
      () => null,
    ),
  );
  const lostCase = yield* Schema.decodeUnknownEffect(
    Schema.NullOr(
      Schema.Struct({
        eventId: Schema.String,
        sessionId: Schema.String,
        runId: Schema.String,
      }),
    ),
  )(linkback);
  if (lostCase !== null) {
    const beforeLostReplay = yield* Effect.promise(() =>
      ledgerFor(LOSE_ACK_ISSUE),
    );
    yield* forgetDelivery(sentryEventRequestId(lostCase.eventId));
    const lostReplay = yield* Effect.promise(() =>
      post(
        alert(lostCase.eventId, `lose ack ${lostCase.runId}`, {
          issue: LOSE_ACK_ISSUE,
        }),
        { requestId: `req-${lostCase.runId}-lose-after-restart` },
      ),
    );
    const afterLostReplay = yield* Effect.promise(() =>
      ledgerFor(LOSE_ACK_ISSUE),
    );
    assert(
      "after a restart, a delivery replayed past its lost acknowledgement posts no second note",
      lostReplay.outcome?.status === "processed" &&
        lostReplay.outcome.replayed === false &&
        lostReplay.outcome.sessionId === lostCase.sessionId &&
        afterLostReplay.notes.length === 1 &&
        afterLostReplay.posts === 1 &&
        afterLostReplay.gets === beforeLostReplay.gets + 1,
      `status=${lostReplay.status} body=${JSON.stringify(lostReplay.body)} ledger=${JSON.stringify(afterLostReplay)}`,
    );
  }

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
  const freshSession = fresh.outcome?.sessionId;
  const freshLedger = yield* Effect.promise(() =>
    ledgerFor(issueOf(freshEvent)),
  );
  assert(
    "and the restarted process links it: one note naming its session on the new alert's issue",
    freshSession !== undefined &&
      freshLedger.notes.length === 1 &&
      freshLedger.notes[0] === noteFor(freshSession),
    `ledger=${JSON.stringify(freshLedger)}`,
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
