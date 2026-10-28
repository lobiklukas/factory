// Plan freshness (LOB-45), driven against an API with `PLAN_FRESHNESS=merged` whose Linear is the
// loopback fake (`linear-api-fake.ts`) holding a fixture plan, with the real Effect RPC client for
// every read and the GitHub webhook signed the way GitHub signs it.
//
//   bun plan-freshness.ts      (via ./plan-freshness.sh, which owns the API and the fake)
//
//   setup      a card specified by one run (delegated from the fake's parent issue) and built by
//              another, whose PR the drive records as the factory's (`sessions.pr_url`)
//   merge      the signed merged delivery files exactly one revision on the spec's session, naming the
//              spec it was derived from and the plan it was shown; one call, charged to that session
//   nowhere    every table's fingerprint is as it was but the spec session's own log and activity row,
//              the delivery's dedupe row and the merged session's own workspace release (LOB-268);
//              no session opened; Linear saw one read and no write
//   again      a redelivery of the same merge files nothing, commits nothing and calls nothing
//   decline    declining sends nothing and calls nothing, and approving the declined set is refused
//   approve    a second merge's revision, approved, lands the add and the close once each; approving
//              it again sends nothing
//
// Env: API_URL, EVIDENCE_DIR, EXPECT_SPEC, LINEAR_FAKE_LEDGER, LINEAR_PARENT, GITHUB_WEBHOOK_SECRET,
// DATABASE_URL (the drive's scratch database).
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlanRevision } from "@repo/domain/PlanFreshness";
import { RpcApi } from "@repo/domain/Rpc";
import {
  RepoSlug,
  type SessionId,
  type SessionSnapshot,
} from "@repo/domain/Session";
import { DefinitionId } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9433";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const LEDGER = process.env["LINEAR_FAKE_LEDGER"] ?? "";
const PARENT = process.env["LINEAR_PARENT"] ?? "";
const SECRET = process.env["GITHUB_WEBHOOK_SECRET"] ?? "";
const PERSON = "person:verify-api";
const ExpectSpec = Schema.fromJsonString(
  Schema.Struct({
    goal: Schema.String,
    acceptance: Schema.Array(Schema.String),
  }),
);
const SPEC = Schema.decodeSync(ExpectSpec)(process.env["EXPECT_SPEC"] ?? "");
const READS = new Set([
  "issue",
  "issueChildren",
  "issueRelations",
  "issuePlan",
]);

await mkdir(EVIDENCE_DIR, { recursive: true });

type Ledger = {
  readonly requests: Array<{ readonly operation: string }>;
  readonly children: Array<{
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly state?: { readonly name: string; readonly type: string };
    readonly comments?: string[];
  }>;
};
const ledger = async (): Promise<Ledger> =>
  JSON.parse(await readFile(LEDGER, "utf8")) as Ledger;
const writesOf = (state: Ledger) =>
  state.requests.filter((request) => !READS.has(request.operation));

const observed: {
  apiUrl: string;
  parent: string;
  specSession: SessionId | null;
  buildSession: SessionId | null;
  deliveries: Record<string, unknown>;
  revisions: readonly PlanRevision[];
  rows: Record<string, unknown>;
  ledger: Ledger | null;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  parent: PARENT,
  specSession: null,
  buildSession: null,
  deliveries: {},
  revisions: [],
  rows: {},
  ledger: null,
  checks: {},
};
const assert = makeChecker(observed);

/** POST a signed `pull_request` merge of `pr` to the webhook, as GitHub delivers it. */
const deliverMerge = async (pr: string, number: number) => {
  const raw = JSON.stringify({
    action: "closed",
    pull_request: { html_url: pr, number, merged: true },
  });
  const response = await fetch(`${API_URL}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
    },
    body: raw,
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

/** What a session has spent, over every model its ledger names. */
const spendOf = (snapshot: SessionSnapshot): number =>
  snapshot.usage.models.reduce(
    (total, model) => total + model.usage.costTotal,
    0,
  );

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const sql = yield* SqlClient;

  /**
   * Every table's content — row count and an `md5` over every row — but what a merge's pass writes
   * by design: the spec session's own log and activity row, the delivery's dedupe row, and the
   * merged session's `sessions` and activity rows, which the merge's workspace release (LOB-268)
   * writes whatever the plan does.
   */
  const fingerprint = (spec: SessionId, build: SessionId, pr: string) =>
    Effect.gen(function* () {
      const tables = yield* sql<{ name: string }>`
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;
      const own: Record<string, readonly [string, string, string]> = {
        commits: ["log_id", spec, spec],
        session_activity: ["session_id", spec, build],
        sessions: ["id", build, build],
        webhook_deliveries: [
          "request_id",
          `plan-freshness:${spec}:${pr}`,
          `plan-freshness:${spec}:${pr}`,
        ],
      };
      const prints: Record<string, string> = {};
      for (const { name } of tables) {
        const excluded = own[name];
        const rows =
          excluded === undefined
            ? yield* sql<{ print: string }>`
                SELECT count(*)::text || ':' || md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS print
                FROM ${sql(name)} t
              `
            : yield* sql<{ print: string }>`
                SELECT count(*)::text || ':' || md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS print
                FROM ${sql(name)} t
                WHERE ${sql(excluded[0])} <> ${excluded[1]} AND ${sql(excluded[0])} <> ${excluded[2]}
              `;
        prints[name] = rows[0]?.print ?? "";
      }
      return prints;
    });
  const headSeq = (sessionId: SessionId) =>
    Effect.map(
      sql<{ seq: number }>`
        SELECT coalesce(max(seq), 0)::int AS seq FROM commits WHERE log_id = ${sessionId}
      `,
      (rows) => rows[0]?.seq ?? 0,
    );
  const commitsSince = (sessionId: SessionId, seq: number) =>
    sql<{ writes: string }>`
      SELECT writes::text AS writes FROM commits WHERE log_id = ${sessionId} AND seq > ${seq} ORDER BY seq
    `;

  // --- setup -------------------------------------------------------------------------------------------
  const board = yield* client.createBoard({
    repo: RepoSlug.make(`verify-api/plan-${Date.now()}`),
    definitionId: DefinitionId.make("default"),
  });
  const created = yield* client.createTask({
    boardId: board.id,
    title: "a card whose plan goes stale",
    actor: PERSON,
  });
  const card = yield* client.moveTask({
    taskId: created.id,
    expectedRevision: created.revision,
    to: "specifying",
    actor: PERSON,
  });
  const specRun = yield* client.createSession({
    title: card.title,
    taskId: card.id,
    taskColumn: card.column,
    requestId: `trigger:linear:${PARENT}:mapped`,
  });
  observed.specSession = specRun.id;
  yield* client.sendMessage({ sessionId: specRun.id, content: "specify it" });
  yield* waitUntil(
    Effect.map(client.getSession({ sessionId: specRun.id }), (snapshot) =>
      !snapshot.live.busy &&
      snapshot.entries.some(
        (entry) => entry.toolName === "spec" && entry.isError !== true,
      )
        ? true
        : undefined,
    ),
    "the specifying run to declare its spec and settle",
  );
  const buildRun = yield* client.createSession({
    title: card.title,
    taskId: card.id,
    taskColumn: card.column,
  });
  observed.buildSession = buildRun.id;
  const pr = `https://github.com/verify-api/plan-${Date.now()}/pull/7`;
  // The record the PR step writes when the factory opens a PR (LOB-177).
  yield* sql`UPDATE sessions SET pr_url = ${pr} WHERE id = ${buildRun.id}`;

  // --- merge -------------------------------------------------------------------------------------------
  const rowsBefore = yield* fingerprint(specRun.id, buildRun.id, pr);
  const seqBefore = yield* headSeq(specRun.id);
  const listedBefore = yield* client.listSessions({ limit: 250 });
  const spentBefore = spendOf(
    yield* client.getSession({ sessionId: specRun.id }),
  );
  const first = yield* Effect.promise(() => deliverMerge(pr, 7));
  observed.deliveries["merge"] = first;
  const afterMerge = yield* client.getSession({ sessionId: specRun.id });
  const revisions = afterMerge.planRevisions ?? [];
  const [revision] = revisions;
  assert(
    "the merged delivery files exactly one revision, on the spec's session",
    revisions.length === 1 &&
      revision?.key === `merged:${pr}` &&
      revision.decision === "pending" &&
      JSON.stringify(first.body["planFreshness"]).includes('"proposed"'),
    `status=${first.status} planFreshness=${JSON.stringify(first.body["planFreshness"])} revisions=${revisions.length}`,
  );
  assert(
    "the revision names the spec it was derived from, and the plan it was shown",
    revision?.spec.sessionId === specRun.id &&
      revision.spec.goal === SPEC.goal &&
      revision.spec.digest.length === 16 &&
      JSON.stringify(revision.issues.map((one) => [one.title, one.closed])) ===
        JSON.stringify([
          ["the schema exists", true],
          ["a dashboard nobody asked for", false],
        ]),
    `spec=${JSON.stringify(revision?.spec)} issues=${JSON.stringify(revision?.issues.map((one) => one.identifier))}`,
  );
  assert(
    "the faux's reading proposes the missing criterion and the obsolete issue, each through the validator",
    JSON.stringify(
      revision?.proposals.map((one) =>
        one.kind === "add" ? [one.kind, one.title] : [one.kind, one.issue],
      ),
    ) ===
      JSON.stringify([
        ["add", "the RPC answers"],
        ["close", `${PARENT}-S2`],
      ]),
    `proposals=${JSON.stringify(revision?.proposals)}`,
  );
  const buildSnapshot = yield* client.getSession({ sessionId: buildRun.id });
  assert(
    "the session whose PR merged lists no revision of its own",
    buildSnapshot.planRevisions === undefined,
    `build planRevisions=${JSON.stringify(buildSnapshot.planRevisions ?? null)}`,
  );
  const spentAfter = spendOf(afterMerge);
  assert(
    "one call, charged to the spec session's ledger, within the bound",
    Math.abs(spentAfter - spentBefore - 0.01) < 1e-9,
    `spent=${spentBefore}->${spentAfter}`,
  );

  // --- nowhere else ------------------------------------------------------------------------------------
  const rowsAfter = yield* fingerprint(specRun.id, buildRun.id, pr);
  observed.rows = { before: rowsBefore, after: rowsAfter };
  assert(
    "no other row was inserted, deleted or updated by the pass",
    Object.keys(rowsBefore).includes("webhook_deliveries") &&
      JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore),
    `changed: ${
      Object.keys(rowsAfter)
        .filter((name) => rowsAfter[name] !== rowsBefore[name])
        .join(", ") || "none"
    }`,
  );
  const claim = yield* sql<{ status: string }>`
    SELECT status FROM webhook_deliveries WHERE request_id = ${`plan-freshness:${specRun.id}:${pr}`}
  `;
  assert(
    "the delivery's dedupe row is the seam's own, processed",
    claim.length === 1 && claim[0]?.status === "processed",
    `claim=${JSON.stringify(claim)}`,
  );
  const listedAfter = yield* client.listSessions({ limit: 250 });
  const opened = listedAfter.sessions.filter(
    (entry) => !listedBefore.sessions.some((known) => known.id === entry.id),
  );
  assert(
    "the pass opened no session",
    opened.length === 0,
    `new sessions: ${opened.map((entry) => entry.id).join(", ") || "none"}`,
  );
  const afterPass = yield* Effect.promise(ledger);
  assert(
    "Linear saw one read of the plan and no write",
    JSON.stringify(afterPass.requests.map((one) => one.operation)) ===
      JSON.stringify(["issuePlan"]),
    `requests=${JSON.stringify(afterPass.requests.map((one) => one.operation))}`,
  );
  const passCommits = yield* commitsSince(specRun.id, seqBefore);
  assert(
    "the spec session's log gained one commit of factory.planRevisions",
    passCommits.filter((row) => row.writes.includes("factory.planRevisions"))
      .length === 1,
    `new commits=${passCommits.length}`,
  );

  // --- again -------------------------------------------------------------------------------------------
  const seqAgain = yield* headSeq(specRun.id);
  const again = yield* Effect.promise(() => deliverMerge(pr, 7));
  observed.deliveries["redelivery"] = again;
  const afterAgain = yield* client.getSession({ sessionId: specRun.id });
  const againCommits = yield* commitsSince(specRun.id, seqAgain);
  const afterAgainLedger = yield* Effect.promise(ledger);
  assert(
    "a redelivery of the same merge files nothing, commits nothing, calls nothing and reads nothing",
    JSON.stringify(again.body["planFreshness"]).includes('"replayed"') &&
      (afterAgain.planRevisions ?? []).length === 1 &&
      againCommits.length === 0 &&
      spendOf(afterAgain) === spentAfter &&
      afterAgainLedger.requests.length === afterPass.requests.length,
    `planFreshness=${JSON.stringify(again.body["planFreshness"])} commits=${againCommits.length}`,
  );

  // --- decline -----------------------------------------------------------------------------------------
  const declined = yield* client.declinePlanRevision({
    sessionId: specRun.id,
    key: `merged:${pr}`,
  });
  const refused = yield* Effect.flip(
    client.approvePlanRevision({
      sessionId: specRun.id,
      key: `merged:${pr}`,
      approved: [0, 1],
    }),
  );
  const afterDecline = yield* client.getSession({ sessionId: specRun.id });
  const afterDeclineLedger = yield* Effect.promise(ledger);
  assert(
    "declining sends nothing and calls nothing, and the declined set cannot be approved",
    declined.decision === "declined" &&
      refused._tag === "ApproveProposalsError" &&
      refused.reason === "declined" &&
      spendOf(afterDecline) === spentAfter &&
      afterDeclineLedger.requests.length === afterPass.requests.length,
    `decision=${declined.decision} refused=${refused._tag === "ApproveProposalsError" ? refused.reason : refused._tag}`,
  );

  // --- approve -----------------------------------------------------------------------------------------
  const pr2 = `${pr}0`;
  yield* sql`UPDATE sessions SET pr_url = ${pr2} WHERE id = ${buildRun.id}`;
  const second = yield* Effect.promise(() => deliverMerge(pr2, 70));
  observed.deliveries["second merge"] = second;
  const approved = yield* client.approvePlanRevision({
    sessionId: specRun.id,
    key: `merged:${pr2}`,
    approved: [0, 1],
  });
  const afterApprove = yield* Effect.promise(ledger);
  const closed = afterApprove.children.find(
    (one) => one.identifier === `${PARENT}-S2`,
  );
  const added = afterApprove.children.find(
    (one) => one.title === "the RPC answers",
  );
  assert(
    "approving lands the add as a child and the close as a comment and a canceled state, once each",
    JSON.stringify(approved.applied) === JSON.stringify([0, 1]) &&
      writesOf(afterApprove).length === 3 &&
      closed?.state?.type === "canceled" &&
      (closed.comments ?? []).length === 1 &&
      added !== undefined &&
      approved.revision.proposals[0]?.applied?.identifier === added.identifier,
    `applied=${JSON.stringify(approved.applied)} writes=${JSON.stringify(writesOf(afterApprove).map((one) => one.operation))}`,
  );
  const twice = yield* client.approvePlanRevision({
    sessionId: specRun.id,
    key: `merged:${pr2}`,
    approved: [0, 1],
  });
  const afterTwice = yield* Effect.promise(ledger);
  assert(
    "approving the same revision again sends no write",
    twice.applied.length === 0 &&
      writesOf(afterTwice).length === writesOf(afterApprove).length,
    `applied=${JSON.stringify(twice.applied)}`,
  );
  observed.revisions =
    (yield* client.getSession({ sessionId: specRun.id })).planRevisions ?? [];
  observed.ledger = afterTwice;
});

try {
  await Effect.runPromise(
    program.pipe(
      Effect.provide(Layer.mergeAll(protocolFor(API_URL), DatabaseLive)),
      Effect.scoped,
    ),
  );
} catch (error) {
  assert("the drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, "plan-freshness.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
