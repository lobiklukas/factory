// The Jira adapter over HTTP (LOB-189, served by LOB-259): a signed Jira Cloud issue webhook posted
// at a running API's `POST /webhooks/jira`, one session and one issue comment out.
//
//   MODE=configured bun jira.ts     # the API booted with the secret and the write-back at the fake
//   MODE=unconfigured bun jira.ts   # the same API with `JIRA_WEBHOOK_SECRET` unset
//
// (`./jira.sh` boots the API and the fake and runs both.) What runs is the real thing: the route,
// its signature check, `TriggerService` on the API's Postgres, the real `SessionService`, and the
// real `JiraWriteBack` over HTTP to `./jira-fake.ts` on loopback. Only Jira is fake, and this
// driver is its sender: it signs the body the way Jira Cloud's admin webhooks do (`X-Hub-Signature:
// sha256=<hex HMAC of the body>`).
//
// The checks, `configured`:
//
//   1. a signed `jira:issue_created` delivery answers 200 `processed` and names the session
//   2. the session is the Jira issue's own words: title, and the rendered rule as its first message
//   3. the write-back posted exactly one comment, on the issue key, naming the session, as ADF
//   4. the write-back read the issue, then posted once, to Jira's own path, with Basic auth
//   5. the same body again answers `replayed`, and creates no second session and no second comment
//   6. a `jira:issue_updated` delivery is skipped, with Jira's own event name in the reason
//   7. a label no rule maps is skipped, and neither skip created a session or a comment
//   8. a missing, a wrong and an unprefixed signature are each 401, and record no delivery
//   9. a signed body that is not a Jira issue is 400
//  10. a comment that landed whose acknowledgement was lost fails the delivery (500 write-back); the
//      retry is processed, reuses the session, posts no second comment, and sends the prompt once
//
// `unconfigured`: a delivery signed with the empty key — what an unset secret degrades to — is 503
// naming `JIRA_WEBHOOK_SECRET`, and opens nothing.
//
// Env: API_URL, DATABASE_URL, JIRA_FAKE_LEDGER, JIRA_WEBHOOK_SECRET, JIRA_TRIGGER_REPO (the run's
// own repo; jira.sh passes the same value in TRIGGER_RULES), JIRA_RUN_STAMP, EVIDENCE_DIR.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHmac } from "node:crypto";
import { RepoSlug } from "@repo/domain/Session";
import { Effect } from "effect";
import {
  deliveryRows,
  field,
  postRaw,
  readLedger,
  sessionClient,
  sessionIdOf,
  sessionsOf,
  type Answer,
} from "./adapter-http.ts";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const MODE = process.env["MODE"] ?? "configured";
const API_URL = process.env["API_URL"] ?? "http://127.0.0.1:9424";
const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://factory:factory@localhost:5442/factory";
const LEDGER =
  process.env["JIRA_FAKE_LEDGER"] ?? ".verify/run/jira/jira-ledger.json";
const SECRET = process.env["JIRA_WEBHOOK_SECRET"] ?? "";
const RUN_STAMP = Number(process.env["JIRA_RUN_STAMP"] ?? Date.now());
const REPO = RepoSlug.make(
  process.env["JIRA_TRIGGER_REPO"] ?? `acme/verify-api-jira-${RUN_STAMP}`,
);
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/lob-259";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  mode: string;
  apiUrl: string;
  repo: string;
  deliveries: Array<{ what: string; status: number; body: unknown }>;
  comments: unknown;
  checks: Record<string, CheckRecord>;
} = {
  mode: MODE,
  apiUrl: API_URL,
  repo: REPO,
  deliveries: [],
  comments: null,
  checks: {},
};
const assert = makeChecker(observed);

type Ledger = {
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | undefined;
  }>;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly issue: string;
    readonly body: unknown;
  }>;
};
const ledger = (): Ledger => readLedger(LEDGER, { requests: [], comments: [] });

/** Jira Cloud's issue webhook, shaped as the docs describe it. */
const jiraPayload = (over: {
  readonly timestamp?: number;
  readonly webhookEvent?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly key?: string;
}): Record<string, unknown> => ({
  timestamp: over.timestamp ?? RUN_STAMP,
  webhookEvent: over.webhookEvent ?? "jira:issue_created",
  issue: {
    id: "10001",
    key: over.key ?? "FAC-1",
    fields: {
      summary: "The widget wobbles",
      description: "It wobbles when it spins.",
      labels: over.labels ?? ["factory"],
    },
  },
});

/** Jira's admin-webhook signature: `sha256=` and the body's hex HMAC under the webhook's secret. */
const sign = (raw: string, secret: string = SECRET): string =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

const post = async (
  what: string,
  body: unknown,
  signature: ((raw: string) => string | null) | null = sign,
): Promise<Answer> => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signed = signature?.(raw) ?? null;
  const answer = await postRaw(
    `${API_URL}/webhooks/jira`,
    raw,
    signed === null ? {} : { "x-hub-signature": signed },
  );
  observed.deliveries.push({ what, status: answer.status, body: answer.body });
  return answer;
};

/** The id the adapter derives for a payload (`jiraRequestId`): the event, the issue, the stamp. */
const requestIdOf = (key: string, timestamp: number, event = "create") =>
  `jira:${event}:${key}:${timestamp}`;

const firstMessage = (entries: ReadonlyArray<{ kind: string; text: string }>) =>
  entries.find((entry) => entry.kind === "user")?.text;

const program = Effect.gen(function* () {
  const client = yield* sessionClient;

  if (MODE === "unconfigured") {
    // The configured phase's sessions are still in the database; what must not move is the count.
    const before = yield* sessionsOf(client, REPO);
    const refused = yield* Effect.promise(() =>
      post("unset secret", jiraPayload({ key: "FAC-9" }), (raw) =>
        sign(raw, ""),
      ),
    );
    assert(
      "with JIRA_WEBHOOK_SECRET unset the route is 503 not-configured, naming the variable",
      refused.status === 503 &&
        field(refused, "code") === "not-configured" &&
        JSON.stringify(refused.body).includes("JIRA_WEBHOOK_SECRET"),
      `status=${refused.status} body=${JSON.stringify(refused.body)}`,
    );
    const rows = yield* Effect.promise(() =>
      deliveryRows(DATABASE_URL, [requestIdOf("FAC-9", RUN_STAMP)]),
    );
    assert(
      "and it records no delivery and opens no session",
      rows.length === 0 && (yield* sessionsOf(client, REPO)) === before,
      `rows=${rows.length} sessions=${before}→${yield* sessionsOf(client, REPO)}`,
    );
    return;
  }

  yield* client.registerRepo({ repo: REPO, defaultBaseRef: "main" });

  // 1 + 2: the signed create delivery starts one real session carrying Jira's own words.
  const created = yield* Effect.promise(() => post("created", jiraPayload({})));
  const sessionId = sessionIdOf(created);
  assert(
    "a signed jira:issue_created delivery is processed and names the session",
    created.status === 200 &&
      field(created, "status") === "processed" &&
      field(created, "replayed") === false &&
      sessionId !== undefined,
    `status=${created.status} body=${JSON.stringify(created.body)}`,
  );
  if (sessionId === undefined) {
    return yield* Effect.die(new Error("no session: the rest proves nothing"));
  }
  const read = yield* client.getSession({ sessionId });
  assert(
    "the session is the Jira issue's own title, in the rule's repo",
    read.session.title === "The widget wobbles" && read.session.repo === REPO,
    `title=${JSON.stringify(read.session.title)} repo=${String(read.session.repo)}`,
  );
  assert(
    "and its first message is the rule's rendered prompt",
    firstMessage(read.entries) ===
      "Work on The widget wobbles:\nIt wobbles when it spins.",
    `first=${JSON.stringify(firstMessage(read.entries))}`,
  );

  // 3 + 4: one comment, on the issue key, naming the session, as an ADF document.
  const afterCreate = ledger();
  const comment = afterCreate.comments[0];
  const body = JSON.stringify(comment?.body ?? null);
  assert(
    "the write-back posted exactly one comment on the Jira issue, as ADF naming the session",
    afterCreate.comments.length === 1 &&
      comment?.issue === "FAC-1" &&
      body.includes('"type":"doc"') &&
      body.includes(sessionId) &&
      body.includes(`http://localhost:3000/sessions/${sessionId}`),
    `comments=${afterCreate.comments.length} issue=${String(comment?.issue)} ${body.slice(0, 100)}`,
  );
  const posts = afterCreate.requests.filter(
    (request) => request.method === "POST",
  );
  assert(
    "the write-back read the issue, then posted once, to Jira's own path, with Basic auth",
    afterCreate.requests[0]?.method === "GET" &&
      posts.length === 1 &&
      posts[0]?.path === "/rest/api/3/issue/FAC-1/comment" &&
      (posts[0]?.authorization ?? "").startsWith("Basic "),
    `methods=${afterCreate.requests.map((request) => request.method).join(",")} path=${String(posts[0]?.path)}`,
  );

  // 5: the same body again is a replay — one session, still one comment.
  const replayed = yield* Effect.promise(() =>
    post("replayed", jiraPayload({})),
  );
  assert(
    "the same body again is a replay, with no second session and no second comment",
    replayed.status === 200 &&
      field(replayed, "replayed") === true &&
      (yield* sessionsOf(client, REPO)) === 1 &&
      ledger().comments.length === 1,
    `status=${replayed.status} replayed=${String(field(replayed, "replayed"))} sessions=${yield* sessionsOf(client, REPO)} comments=${ledger().comments.length}`,
  );

  // 6 + 7: an update is not a create; a label no rule maps is skipped with what arrived.
  const updated = yield* Effect.promise(() =>
    post(
      "updated",
      jiraPayload({
        webhookEvent: "jira:issue_updated",
        timestamp: RUN_STAMP + 1,
      }),
    ),
  );
  assert(
    "a jira:issue_updated delivery is skipped, naming Jira's own event",
    updated.status === 200 &&
      field(updated, "status") === "skipped" &&
      String(field(updated, "reason")).includes("jira:issue_updated"),
    `status=${updated.status} reason=${String(field(updated, "reason"))}`,
  );
  const unmapped = yield* Effect.promise(() =>
    post(
      "unmapped",
      jiraPayload({ labels: ["nobody"], timestamp: RUN_STAMP + 2 }),
    ),
  );
  assert(
    "a label no rule maps is skipped with the labels that arrived",
    unmapped.status === 200 &&
      field(unmapped, "status") === "skipped" &&
      String(field(unmapped, "reason")).includes(
        "no rule matches labels [nobody]",
      ),
    `status=${unmapped.status} reason=${String(field(unmapped, "reason"))}`,
  );
  assert(
    "neither skip created a session or a comment",
    (yield* sessionsOf(client, REPO)) === 1 && ledger().comments.length === 1,
    `sessions=${yield* sessionsOf(client, REPO)} comments=${ledger().comments.length}`,
  );

  // 8: a delivery that does not authenticate is refused before anything is recorded.
  const refusedPayload = jiraPayload({
    key: "FAC-7",
    timestamp: RUN_STAMP + 7,
  });
  const missing = yield* Effect.promise(() =>
    post("unsigned", refusedPayload, null),
  );
  const wrong = yield* Effect.promise(() =>
    post("wrong secret", refusedPayload, (raw) => sign(raw, "another")),
  );
  const unprefixed = yield* Effect.promise(() =>
    post("unprefixed", refusedPayload, (raw) =>
      sign(raw).slice("sha256=".length),
    ),
  );
  const refusedRows = yield* Effect.promise(() =>
    deliveryRows(DATABASE_URL, [requestIdOf("FAC-7", RUN_STAMP + 7)]),
  );
  assert(
    "a missing, a wrong and an unprefixed signature are each 401, with their reasons",
    missing.status === 401 &&
      field(missing, "code") === "missing-signature" &&
      wrong.status === 401 &&
      field(wrong, "code") === "bad-signature" &&
      unprefixed.status === 401 &&
      field(unprefixed, "code") === "bad-signature",
    `${missing.status}/${wrong.status}/${unprefixed.status}`,
  );
  assert(
    "and a refused delivery records nothing and opens nothing",
    refusedRows.length === 0 && (yield* sessionsOf(client, REPO)) === 1,
    `rows=${refusedRows.length} sessions=${yield* sessionsOf(client, REPO)}`,
  );

  // 9: signed, but not a Jira issue.
  const notIssue = yield* Effect.promise(() =>
    post("not an issue", { webhookEvent: "jira:issue_created" }),
  );
  assert(
    "a signed body that is not a Jira issue is 400 bad-payload",
    notIssue.status === 400 && field(notIssue, "code") === "bad-payload",
    `status=${notIssue.status} body=${JSON.stringify(notIssue.body)}`,
  );

  // 10: the comment landed and its acknowledgement did not (the fake records it, then answers 500).
  // The seam gives the claim back, so the sender's retry runs the delivery again — and must find its
  // own comment rather than posting a second one.
  const lostPayload = jiraPayload({ key: "FAC-2", timestamp: RUN_STAMP + 3 });
  const lost = yield* Effect.promise(() => post("lost ack", lostPayload));
  assert(
    "a delivery whose comment landed but whose answer was lost is 500 write-back",
    lost.status === 500 && field(lost, "code") === "write-back",
    `status=${lost.status} body=${JSON.stringify(lost.body)}`,
  );
  const retried = yield* Effect.promise(() => post("retry", lostPayload));
  const retriedId = sessionIdOf(retried);
  const retryLedger = ledger();
  const forIssue = (method: string) =>
    retryLedger.requests.filter(
      (request) => request.method === method && request.path.includes("FAC-2"),
    ).length;
  assert(
    "the retry is processed and reuses the session the failed attempt opened",
    retried.status === 200 &&
      field(retried, "status") === "processed" &&
      (yield* sessionsOf(client, REPO)) === 2,
    `status=${retried.status} sessions=${yield* sessionsOf(client, REPO)}`,
  );
  assert(
    "the retry read the issue's comments and posted no second one: the issue carries exactly one",
    forIssue("GET") >= 1 &&
      forIssue("POST") === 1 &&
      retryLedger.comments.filter((entry) => entry.issue === "FAC-2").length ===
        1,
    `gets=${forIssue("GET")} posts=${forIssue("POST")} comments=${retryLedger.comments.filter((entry) => entry.issue === "FAC-2").length}`,
  );
  // Read the session once it has settled: a second prompt sent while the first run is busy waits in
  // the inbox, not in the transcript, so an immediate read would count one either way.
  const settled =
    retriedId === undefined
      ? undefined
      : yield* waitUntil(
          client
            .getSession({ sessionId: retriedId })
            .pipe(
              Effect.map((snapshot) =>
                !snapshot.live.busy && snapshot.queued.length === 0
                  ? snapshot
                  : undefined,
              ),
            ),
          "the retried session to settle",
        );
  const prompts =
    settled?.entries.filter((entry) => entry.kind === "user").length ?? 0;
  assert(
    "and the prompt is sent once: the settled session holds exactly one user message",
    prompts === 1,
    `prompts=${prompts}`,
  );

  observed.comments = ledger().comments;
});

const exit = await Effect.runPromiseExit(
  program.pipe(Effect.provide(protocolFor(API_URL)), Effect.scoped),
);
if (exit._tag === "Failure") console.error(exit.cause);

const checks = Object.values(observed.checks);
const failed = checks.filter((check) => !check.passed).length;
await writeFile(
  path.join(EVIDENCE_DIR, `jira-${MODE}-observed.json`),
  `${JSON.stringify({ ...observed, failed }, null, 2)}\n`,
);
console.log(
  `\njira (${MODE}): ${checks.length - failed}/${checks.length} checks passed — evidence in ${EVIDENCE_DIR}`,
);
process.exit(failed === 0 && exit._tag === "Success" ? 0 : 1);
