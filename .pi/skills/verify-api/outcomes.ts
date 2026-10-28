// The outcome metrics over the real surfaces (LOB-44), driven with the real RPC client, a signed
// GitHub webhook and the CLI.
//
//   bun outcomes.ts      (via ./outcomes.sh, which boots the API this drives)
//
//   sessions   a Linear-delegated session and a direct one, in a repo of this run's own
//   merge      a signed `pull_request` merge of the delegated session's PR records the merge on its
//              row (`pr_merged_at`) and in its log (`factory.merge`); a redelivery commits nothing
//   revert     a signed merge of a person's PR whose body says `Reverts <repo>#1` records the revert
//   report     `factory outcomes --json --repo … --since …` answers the delegation's lead time as the
//              merge minus the session's creation, one reverted merge of one, one Linear and one
//              direct session of two, and the cost the index holds — every value with its window
//
// Env: API_URL, EVIDENCE_DIR, ROOT, OUTCOMES_WEBHOOK_SECRET, DATABASE_URL.
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OutcomeReport } from "@repo/domain/Outcomes";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { readSessionLog } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Layer } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9200";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const ROOT =
  process.env["ROOT"] ?? path.resolve(import.meta.dirname, "../../..");
const SECRET = process.env["OUTCOMES_WEBHOOK_SECRET"] ?? "";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  checks: Record<string, CheckRecord>;
  sessions: Record<string, string>;
  deliveries: Array<{ readonly pr: number; readonly status: number }>;
  report: OutcomeReport | null;
  merge: unknown;
} = {
  apiUrl: API_URL,
  checks: {},
  sessions: {},
  deliveries: [],
  report: null,
  merge: null,
};
const assert = makeChecker(observed);

const run = randomBytes(4).toString("hex");
const repo = RepoSlug.make(`verify/outcomes-${run}`);
const prUrl = (number: number) => `https://github.com/${repo}/pull/${number}`;
const since = new Date(Date.now() - 1_000).toISOString();

const deliver = async (body: unknown) => {
  const raw = JSON.stringify(body);
  const response = await fetch(`${API_URL}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
    },
    body: raw,
  });
  await response.text();
  return response.status;
};

const merged = (number: number, mergedAt: string, body: string | null) => ({
  action: "closed",
  pull_request: {
    number,
    html_url: prUrl(number),
    merged: true,
    merged_at: mergedAt,
    merge_commit_sha: "0123456789abcdef0123456789abcdef01234567",
    body,
  },
});

const cli = async (args: readonly string[]) => {
  const child = Bun.spawn(
    [
      "bun",
      path.join(ROOT, "apps/cli/src/index.ts"),
      "outcomes",
      "--api",
      API_URL,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};

/** A session's merge columns and creation, in epoch milliseconds, and its log's commit count. */
const rowOf = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      readonly createdMs: number;
      readonly mergedMs: number | null;
      readonly revertedMs: number | null;
      readonly commits: number;
    }>`
      SELECT
        (extract(epoch FROM created_at) * 1000)::double precision AS created_ms,
        (extract(epoch FROM pr_merged_at) * 1000)::double precision AS merged_ms,
        (extract(epoch FROM pr_reverted_at) * 1000)::double precision AS reverted_ms,
        (SELECT count(*)::int FROM commits WHERE log_id = ${id}) AS commits
      FROM sessions WHERE id = ${id}
    `;
    return rows[0];
  });

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const sql = yield* SqlClient;
  const fixture = path.resolve(import.meta.dirname, "fixtures", "repo");
  yield* client.registerRepo({
    repo,
    localPath: fixture,
    defaultBaseRef: "main",
  });
  const delegated = yield* client.createSession({
    title: "outcomes: a delegated issue",
    repo,
    baseRef: "main",
    requestId: `trigger:linear:VER-${run}:mapped`,
  });
  const direct = yield* client.createSession({
    title: "outcomes: a direct session",
    repo,
    baseRef: "main",
  });
  observed.sessions = { delegated: delegated.id, direct: direct.id };
  // The PR step is `pr-rpc.sh`'s to prove; here the link is what the merge is matched by.
  yield* sql`UPDATE sessions SET pr_url = ${prUrl(1)} WHERE id = ${delegated.id}`;

  // --- merge -----------------------------------------------------------------------------------
  const mergedAt = new Date(Date.now() + 2_000).toISOString();
  const status = yield* Effect.promise(() =>
    deliver(merged(1, mergedAt, null)),
  );
  observed.deliveries.push({ pr: 1, status });
  const recorded = yield* waitUntil(
    rowOf(delegated.id).pipe(
      Effect.map((row) => (row?.mergedMs != null ? row : undefined)),
    ),
    "the merge to be recorded",
  );
  assert(
    "merge: a signed merge records the merge time on the session's row",
    recorded.mergedMs === Date.parse(mergedAt),
    `pr_merged_at=${new Date(recorded.mergedMs ?? 0).toISOString()} delivered=${mergedAt} status=${status}`,
  );
  const again = yield* Effect.promise(() =>
    deliver(merged(1, new Date(Date.now() + 60_000).toISOString(), null)),
  );
  observed.deliveries.push({ pr: 1, status: again });
  const after = yield* rowOf(delegated.id);
  assert(
    "merge: a redelivery commits nothing and the first merge stands",
    after?.commits === recorded.commits &&
      after?.mergedMs === recorded.mergedMs,
    `commits=${recorded.commits}->${after?.commits} merged=${after?.mergedMs}`,
  );

  // --- revert ----------------------------------------------------------------------------------
  const revertedAt = new Date(Date.now() + 3_000).toISOString();
  const reverting = yield* Effect.promise(() =>
    deliver(
      merged(
        2,
        revertedAt,
        `Reverts ${repo}#1\n\nThe change broke the widget.`,
      ),
    ),
  );
  observed.deliveries.push({ pr: 2, status: reverting });
  const reverted = yield* waitUntil(
    rowOf(delegated.id).pipe(
      Effect.map((row) => (row?.revertedMs != null ? row : undefined)),
    ),
    "the revert to be recorded",
  );
  assert(
    "revert: a merged `Reverts <repo>#1` PR records the revert on PR 1's session",
    reverted.revertedMs === Date.parse(revertedAt),
    `pr_reverted_at=${new Date(reverted.revertedMs ?? 0).toISOString()}`,
  );
  const log = yield* Effect.acquireUseRelease(
    Effect.promise(() => PostgresStorage.reader(sql, delegated.id)),
    readSessionLog,
    (storage) => Effect.promise(() => storage.dispose()),
  );
  observed.merge = log.merge ?? null;
  assert(
    "log: the session's own log holds both facts (factory.merge)",
    log.merge?.mergedAt === mergedAt &&
      log.merge.url === prUrl(1) &&
      log.merge.revert?.by === prUrl(2) &&
      log.merge.revert.at === revertedAt,
    JSON.stringify(log.merge),
  );

  // --- report ----------------------------------------------------------------------------------
  const until = new Date(Date.now() + 60_000).toISOString();
  const json = yield* Effect.promise(() =>
    cli(["--repo", repo, "--since", since, "--until", until, "--json"]),
  );
  const table = yield* Effect.promise(() =>
    cli(["--repo", repo, "--since", since, "--until", until]),
  );
  yield* Effect.promise(() =>
    writeFile(
      path.join(EVIDENCE_DIR, "outcomes-report.txt"),
      table.stdout + table.stderr,
    ),
  );
  assert(
    "report: the CLI answered",
    json.code === 0 && table.code === 0,
    `json=${json.code} table=${table.code} ${json.stderr}`,
  );
  const report = JSON.parse(json.stdout) as OutcomeReport;
  observed.report = report;
  const valueOf = (metric: string, name: string) =>
    report.values.find(
      (value) => value.metric === metric && value.name === name,
    );
  assert(
    "report: every value carries the window asked for and a denominator",
    report.window.since === since &&
      report.window.until === until &&
      report.values.every(
        (value) =>
          value.window.since === since &&
          value.window.until === until &&
          value.denominator.of !== "" &&
          value.source !== "",
      ),
    `${report.values.length} values over ${report.window.since}..${report.window.until}`,
  );
  const lead = valueOf("lead_time", "delegation.median");
  const expected = (Date.parse(mergedAt) - recorded.createdMs) / 1000;
  assert(
    "report: delegation lead time is the recorded merge minus the session's creation, over one issue",
    lead?.denominator.count === 1 &&
      lead.value !== null &&
      Math.abs(lead.value - expected) < 1e-6,
    `value=${lead?.value} expected=${expected} of ${lead?.denominator.count}`,
  );
  const revertedValue = valueOf("defect_pressure", "merges.reverted");
  assert(
    "report: one reverted merge of one",
    revertedValue?.value === 1 && revertedValue.denominator.count === 1,
    `${revertedValue?.value} of ${revertedValue?.denominator.count}`,
  );
  const linear = valueOf("adoption", "sessions.linear");
  const directCount = valueOf("adoption", "sessions.direct");
  assert(
    "report: adoption counts one Linear and one direct session of two",
    linear?.value === 1 &&
      directCount?.value === 1 &&
      linear.denominator.count === 2,
    `linear=${linear?.value} direct=${directCount?.value} of ${linear?.denominator.count}`,
  );
  const cost = yield* sql<{ readonly total: number }>`
    SELECT COALESCE(sum(cost_total), 0)::double precision AS total
    FROM session_activity WHERE session_id = ANY(${[delegated.id, direct.id]}::text[])
  `;
  const total = valueOf("cost", "total");
  assert(
    "report: cost reconciles with session_activity.cost_total",
    total?.value === (cost[0]?.total ?? Number.NaN) &&
      total?.denominator.count === 2,
    `report=${total?.value} column=${cost[0]?.total}`,
  );
});

const exit = await Effect.runPromiseExit(
  Effect.scoped(program).pipe(
    Effect.provide(Layer.mergeAll(protocolFor(API_URL), DatabaseLive)),
  ),
);
if (exit._tag === "Failure") {
  assert("drive: completed", false, String(exit.cause));
}
await writeFile(
  path.join(EVIDENCE_DIR, "outcomes.json"),
  JSON.stringify(observed, null, 2),
);
const failed = Object.values(observed.checks).filter((check) => !check.passed);
process.exit(failed.length === 0 ? 0 : 1);
