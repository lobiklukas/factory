// The Jira adapter end to end (LOB-189): a Jira issue event in, one session and one issue comment.
//
//   bun jira.ts
//
// What runs is the real seam, not a model of it: `TriggerService` on the run's Postgres, the real
// `SessionService` behind its `TriggerSessions` port (so the session, its log and its first message
// are real), and the adapter's real `JiraWriteBack` over an Effect `HttpClient` pointed at
// `./jira-fake.ts` on loopback. Only Jira is fake.
//
// The checks:
//
//   1. a `jira:issue_created` delivery starts a session and names it
//   2. the session is the Jira issue's own words: title, and the rendered rule as its first message
//   3. the write-back posted exactly one comment, on the issue key, naming the session, as ADF
//   4. the same payload again is a replay: one session, still one comment (dedupe)
//   5. a `jira:issue_updated` delivery is skipped, with Jira's own event name in the reason
//   6. a label no rule maps is skipped, and neither skip created a session or a comment
//   7. a payload that is not a Jira issue is `undefined` rather than an event
//
// Env: DATABASE_URL (via DatabaseLive), SESSION_ROOT, JIRA_FAKE_URL, JIRA_FAKE_LEDGER,
// JIRA_TRIGGER_REPO, EVIDENCE_DIR.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import type { SessionId } from "@repo/domain/Session";
import type { TriggerDelivery, TriggerRule } from "@repo/domain/Trigger";
import { jiraDelivery, JiraWriteBack } from "@repo/core";
import {
  SessionService,
  SessionServiceLive,
  TriggerService,
  TriggerServiceLive,
  TriggerSessionsFromSessionService,
} from "@repo/core";
import { createModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { makeChecker } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const SESSION_ROOT = process.env["SESSION_ROOT"] ?? ".verify/run/jira/sessions";
/**
 * A per-run stamp. The repo and the payload timestamps carry it so the drive can be re-run against
 * the same database: a delivery id is stable for one run (which is what the replay check needs) and
 * new for the next one, and the repo starts with no sessions to count.
 */
const RUN_STAMP = Number(process.env["JIRA_RUN_STAMP"] ?? Date.now());
const REPO = RepoSlugSchema.make(
  `${process.env["JIRA_TRIGGER_REPO"] ?? "acme/verify-api-jira"}-${RUN_STAMP}`,
);
const FAKE_URL = process.env["JIRA_FAKE_URL"] ?? "http://127.0.0.1:9412";
const LEDGER =
  process.env["JIRA_FAKE_LEDGER"] ?? ".verify/run/jira/jira-ledger.json";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";

await mkdir(EVIDENCE_DIR, { recursive: true });
await mkdir(path.dirname(LEDGER), { recursive: true });

const rules: ReadonlyArray<TriggerRule> = [
  {
    label: "factory",
    repo: REPO,
    baseRef: "main",
    prompt: "Work on {{title}}:\n{{body}}",
  },
];

const observed: {
  sessionId: SessionId | null;
  replayedSessionId: SessionId | null;
  skipped: Array<{ why: string; status: string; reason: string | undefined }>;
  comments: unknown;
  ledger: unknown;
  checks: Record<string, CheckRecord>;
} = {
  sessionId: null,
  replayedSessionId: null,
  skipped: [],
  comments: null,
  ledger: null,
  checks: {},
};
const assert = makeChecker(observed);

/** The session layer, the seam, and the adapter's own write-back client — one runtime. */
const base = SessionServiceLive({
  model: createModelAccess("faux"),
  sessionRoot: SESSION_ROOT,
}).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)));

// A layer's dependencies must be provided *to* it, not merged beside it: siblings in one
// `mergeAll` are built in the outer context and cannot see each other's outputs, so the write-back
// client takes the HTTP client explicitly.
const triggers = TriggerServiceLive({ rules }).pipe(
  Layer.provide(
    Layer.mergeAll(
      TriggerSessionsFromSessionService,
      JiraWriteBack({
        baseUrl: FAKE_URL,
        email: "factory@example.com",
        apiToken: Redacted.make("jira-token"),
        sessionUrlBase: "http://localhost:3000/sessions",
      }).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
  ),
  Layer.provideMerge(base),
);

const runtime = ManagedRuntime.make(triggers);

/** Jira Cloud's `jira:issue_created` payload. */
const jiraPayload = (over: {
  readonly timestamp?: number;
  readonly webhookEvent?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly key?: string;
}): Record<string, unknown> => ({
  timestamp: over.timestamp ?? RUN_STAMP,
  webhookEvent: over.webhookEvent ?? "jira:issue_created",
  issue_event_type_name:
    over.webhookEvent === undefined ||
    over.webhookEvent === "jira:issue_created"
      ? "issue_created"
      : "issue_updated",
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

const readLedger = (): Ledger => {
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
  } catch {
    return { requests: [], comments: [] };
  }
};

const delivery = (payload: unknown): TriggerDelivery => {
  const normalized = jiraDelivery(payload);
  if (normalized === undefined) {
    throw new Error(
      `the payload did not normalize: ${JSON.stringify(payload)}`,
    );
  }
  return normalized;
};

const deliver = (payload: unknown) =>
  Effect.gen(function* () {
    const service = yield* TriggerService;
    return yield* service.deliver(delivery(payload));
  });

const sessionCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ count: number }>`
    SELECT count(*)::int AS count FROM sessions WHERE repo = ${REPO}
  `;
  return rows[0]?.count ?? 0;
});

const firstMessage = (entries: ReadonlyArray<{ kind: string; text: string }>) =>
  entries.find((entry) => entry.kind === "user")?.text;

const run = Effect.gen(function* () {
  const sessions = yield* SessionService;
  yield* sessions.registerRepo({ repo: REPO, defaultBaseRef: "main" });

  // 1 + 2: the create delivery starts one real session carrying Jira's own words.
  const created = yield* deliver(jiraPayload({}));
  observed.sessionId = created.sessionId ?? null;
  assert(
    "a Jira create delivery starts a session and names it",
    created.status === "processed" && created.sessionId !== undefined,
    `status=${created.status} session=${String(created.sessionId)} reason=${String(created.reason)}`,
  );
  if (created.sessionId === undefined) {
    return yield* Effect.die(new Error("no session: the rest proves nothing"));
  }
  const sessionId = created.sessionId;
  const read = yield* sessions.get(sessionId);
  assert(
    "the session is the Jira issue's own title",
    read.session.title === "The widget wobbles",
    `title=${JSON.stringify(read.session.title)}`,
  );
  assert(
    "and its first message is the rule's rendered prompt",
    firstMessage(read.entries) ===
      "Work on The widget wobbles:\nIt wobbles when it spins.",
    `first=${JSON.stringify(firstMessage(read.entries))}`,
  );

  // 3: one comment, on the issue key, naming the session, as an ADF document.
  const afterCreate = readLedger();
  const comment = afterCreate.comments[0];
  const body = JSON.stringify(comment?.body ?? null);
  assert(
    "the write-back posted exactly one comment on the Jira issue",
    afterCreate.comments.length === 1 && comment?.issue === "FAC-1",
    `comments=${afterCreate.comments.length} issue=${String(comment?.issue)}`,
  );
  assert(
    "the comment is an ADF document naming the session",
    body.includes('"type":"doc"') && body.includes(sessionId),
    body.slice(0, 120),
  );
  const createPosts = afterCreate.requests.filter(
    (request) => request.method === "POST",
  );
  assert(
    "the write-back read the issue, then posted once, to Jira's own path, with Basic auth",
    afterCreate.requests[0]?.method === "GET" &&
      createPosts.length === 1 &&
      createPosts[0]?.path === "/rest/api/3/issue/FAC-1/comment" &&
      (createPosts[0]?.authorization ?? "").startsWith("Basic "),
    `methods=${afterCreate.requests.map((request) => request.method).join(",")} path=${String(
      createPosts[0]?.path,
    )} auth=${String(createPosts[0]?.authorization).slice(0, 16)}…`,
  );

  // 4: the same delivery again is a replay — one session, still one comment. The seam answers
  // `replayed: true` without a session id (`webhook_deliveries` records the status, not the
  // session), so the replay is proved by the counts below plus the session the first call named.
  const replayed = yield* deliver(jiraPayload({}));
  observed.replayedSessionId = replayed.sessionId ?? null;
  const replayLedger = readLedger();
  assert(
    "the same payload again is a replay, not a second delivery",
    replayed.replayed === true &&
      (replayed.sessionId === undefined || replayed.sessionId === sessionId),
    `replayed=${String(replayed.replayed)} session=${String(replayed.sessionId)}`,
  );
  assert(
    "a replay creates no second session and no second comment",
    (yield* sessionCount) === 1 && replayLedger.comments.length === 1,
    `sessions=${yield* sessionCount} comments=${replayLedger.comments.length}`,
  );

  // 5: an update is not a create — Jira's own event name is in the reason.
  const updated = yield* deliver(
    jiraPayload({
      webhookEvent: "jira:issue_updated",
      timestamp: RUN_STAMP + 1,
    }),
  );
  observed.skipped.push({
    why: "update",
    status: updated.status,
    reason: updated.reason,
  });
  assert(
    "an update delivery is skipped, naming Jira's own event",
    updated.status === "skipped" &&
      (updated.reason ?? "").includes("jira:issue_updated"),
    `status=${updated.status} reason=${String(updated.reason)}`,
  );

  // 6: a label no rule maps is skipped with the labels that arrived.
  const unmapped = yield* deliver(
    jiraPayload({ labels: ["nobody"], timestamp: RUN_STAMP + 2 }),
  );
  observed.skipped.push({
    why: "unmappable",
    status: unmapped.status,
    reason: unmapped.reason,
  });
  assert(
    "an unmappable label is skipped with the labels that arrived",
    unmapped.status === "skipped" &&
      (unmapped.reason ?? "").includes("no rule matches labels [nobody]"),
    `status=${unmapped.status} reason=${String(unmapped.reason)}`,
  );
  assert(
    "neither skip created a session or a comment",
    (yield* sessionCount) === 1 && readLedger().comments.length === 1,
    `sessions=${yield* sessionCount} comments=${readLedger().comments.length}`,
  );

  // 7: a payload that is not a Jira issue is not an event at all.
  assert(
    "a payload with no issue does not normalize to a delivery",
    jiraDelivery({ webhookEvent: "jira:issue_created" }) === undefined,
    "jiraDelivery(no issue) === undefined",
  );

  // 8: the comment landed and its acknowledgement did not (the fake records it, then answers 500).
  // The seam gives the claim back, so the sender's retry runs the delivery again — and must find
  // its own comment rather than posting a second one.
  const lostPayload = jiraPayload({ key: "FAC-2", timestamp: RUN_STAMP + 3 });
  const lost = yield* Effect.exit(deliver(lostPayload));
  assert(
    "a delivery whose comment landed but whose answer was lost fails",
    lost._tag === "Failure",
    lost._tag === "Failure"
      ? String(lost.cause).includes("write-back")
        ? "write-back error"
        : String(lost.cause).slice(0, 120)
      : "the delivery answered success",
  );
  const retried = yield* deliver(lostPayload);
  const retryLedger = readLedger();
  const forIssue = (issue: string, method: string) =>
    retryLedger.requests.filter(
      (request) => request.method === method && request.path.includes(issue),
    ).length;
  assert(
    "the retry reads the issue's comments before it posts",
    forIssue("FAC-2", "GET") >= 1 && forIssue("FAC-2", "POST") === 1,
    `gets=${forIssue("FAC-2", "GET")} posts=${forIssue("FAC-2", "POST")}`,
  );
  assert(
    "and posts no second comment: the issue still carries exactly one",
    retryLedger.comments.filter((comment) => comment.issue === "FAC-2")
      .length === 1,
    `comments=${retryLedger.comments.filter((comment) => comment.issue === "FAC-2").length}`,
  );
  const retriedSession =
    retried.sessionId === undefined
      ? undefined
      : yield* sessions.get(retried.sessionId);
  const prompts =
    retriedSession?.entries.filter((entry) => entry.kind === "user").length ??
    0;
  assert(
    "the retry is processed and reuses the session the failed attempt opened",
    retried.status === "processed" && (yield* sessionCount) === 2,
    `status=${retried.status} sessions=${yield* sessionCount} prompts=${prompts} (the seam re-sends on a retry: LOB-218)`,
  );

  observed.comments = readLedger().comments;
  observed.ledger = readLedger().requests;
});

const exit = await runtime.runPromiseExit(run);
if (exit._tag === "Failure") {
  console.error(exit.cause);
}
await runtime.dispose();

const checks = Object.values(observed.checks);
const failed = checks.filter((check) => !check.passed).length;
await writeFile(
  path.join(EVIDENCE_DIR, "jira-observed.json"),
  `${JSON.stringify({ ...observed, failed }, null, 2)}\n`,
);
console.log(
  `\njira: ${checks.length - failed}/${checks.length} checks passed — evidence in ${EVIDENCE_DIR}`,
);
process.exit(failed === 0 && exit._tag === "Success" ? 0 : 1);
