// The decomposition surface (LOB-201), driven with the real Effect RPC client: a specifier run's
// spec becomes proposed child issues through `proposeDecomposition`, and nothing but the session's
// own log is written.
//
//   bun decompose.ts      (via ./decompose.sh, which owns the API instance this drives)
//
//   none       a session with no spec is refused as `invalid_input`, and reports no proposals
//   spec       a card moved into `specifying`, a run started on it, and its `spec` call accepted
//   propose    `proposeDecomposition` answers one proposal per criterion, each with acceptance lines
//   read       `getSession` reports the same set as `proposedIssues`
//   nowhere    every table's row count is as it was, the log of every other session included, the
//              card did not move, and the session's own log gained one commit of the document
//
// Env: API_URL, EVIDENCE_DIR, EXPECT_SPEC (the spec the shell's faux specifier declares),
// DATABASE_URL (the scratch database the shell minted).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProposedIssues } from "@repo/domain/Decomposition";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { DefinitionId } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9423";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const ExpectSpec = Schema.fromJsonString(
  Schema.Struct({
    goal: Schema.String,
    acceptance: Schema.Array(Schema.String),
  }),
);
const SPEC = Schema.decodeSync(ExpectSpec)(process.env["EXPECT_SPEC"] ?? "");
const PERSON = "person:verify-api";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  sessionId: SessionId | null;
  spec: typeof SPEC;
  proposed: ProposedIssues | null;
  rows: Record<string, unknown>;
  newCommits: number;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  sessionId: null,
  spec: SPEC,
  proposed: null,
  rows: {},
  newCommits: 0,
  checks: {},
};
const assert = makeChecker(observed);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const sql = yield* SqlClient;

  /** Every table's rows, and the commits of every log but `sessionId`'s. */
  const rowCounts = (sessionId: SessionId) =>
    Effect.map(
      sql<Record<string, number>>`
        SELECT
          (SELECT count(*)::int FROM commits WHERE log_id <> ${sessionId}) AS other_commits,
          (SELECT count(*)::int FROM sessions) AS sessions,
          (SELECT count(*)::int FROM session_activity) AS session_activity,
          (SELECT count(*)::int FROM tasks) AS tasks,
          (SELECT count(*)::int FROM task_events) AS task_events,
          (SELECT count(*)::int FROM task_runs) AS task_runs,
          (SELECT count(*)::int FROM board_instances) AS board_instances,
          (SELECT count(*)::int FROM session_approvals) AS session_approvals,
          (SELECT count(*)::int FROM session_pages) AS session_pages,
          (SELECT count(*)::int FROM webhook_deliveries) AS webhook_deliveries,
          (SELECT count(*)::int FROM repos) AS repos,
          (SELECT count(*)::int FROM skills) AS skills
      `,
      (rows) => rows[0] ?? {},
    );
  const headSeq = (sessionId: SessionId) =>
    Effect.map(
      sql<{ seq: number }>`
        SELECT coalesce(max(seq), 0)::int AS seq FROM commits WHERE log_id = ${sessionId}
      `,
      (rows) => rows[0]?.seq ?? 0,
    );

  // --- none: a session with no spec has nothing to decompose ------------------------------------------
  const scratch = yield* client.createSession({ title: "no spec" });
  const noSpec = yield* Effect.flip(
    client.proposeDecomposition({ sessionId: scratch.id }),
  );
  const scratchSnapshot = yield* client.getSession({ sessionId: scratch.id });
  assert(
    "a session with no spec is refused invalid_input, and reports no proposals",
    noSpec._tag === "SessionError" &&
      noSpec.code === "invalid_input" &&
      scratchSnapshot.proposedIssues === undefined,
    `${noSpec._tag}${noSpec._tag === "SessionError" ? ` ${noSpec.code}: ${noSpec.message}` : ""}`,
  );

  // --- spec: a specifier run declares the card's spec --------------------------------------------------
  const board = yield* client.createBoard({
    repo: RepoSlug.make(`verify-api/decompose-${Date.now()}`),
    definitionId: DefinitionId.make("default"),
  });
  const created = yield* client.createTask({
    boardId: board.id,
    title: "a card to decompose",
    actor: PERSON,
  });
  const card = yield* client.moveTask({
    taskId: created.id,
    expectedRevision: created.revision,
    to: "specifying",
    actor: PERSON,
  });
  const run = yield* client.createSession({
    title: card.title,
    taskId: card.id,
    taskColumn: card.column,
  });
  observed.sessionId = run.id;
  yield* client.sendMessage({ sessionId: run.id, content: "specify it" });
  yield* waitUntil(
    Effect.map(client.getSession({ sessionId: run.id }), (snapshot) =>
      !snapshot.live.busy &&
      snapshot.entries.some(
        (entry) => entry.toolName === "spec" && entry.isError !== true,
      )
        ? true
        : undefined,
    ),
    "the specifying run to declare its spec and settle",
  );
  const spec = yield* client.getTaskSpec({ taskId: card.id });
  assert(
    "the specifier run's spec is the faux script's, with no gaps",
    spec !== null &&
      spec.goal === SPEC.goal &&
      JSON.stringify(spec.acceptance) === JSON.stringify(SPEC.acceptance) &&
      spec.gaps.length === 0,
    `spec=${JSON.stringify(spec)}`,
  );
  const cardBefore = yield* client.getTask({ taskId: card.id });

  // --- propose ---------------------------------------------------------------------------------------
  const rowsBefore = yield* rowCounts(run.id);
  const seq = yield* headSeq(run.id);
  const listedBefore = yield* client.listSessions({ limit: 250 });
  const proposed = yield* client.proposeDecomposition({ sessionId: run.id });
  observed.proposed = proposed;
  assert(
    "proposeDecomposition answers one proposal per criterion, each with acceptance lines",
    proposed.proposals.length >= 1 &&
      JSON.stringify(proposed.proposals.map((p) => p.title)) ===
        JSON.stringify(SPEC.acceptance) &&
      proposed.proposals.every((p) => p.acceptance.length > 0),
    `titles=${JSON.stringify(proposed.proposals.map((p) => p.title))}`,
  );

  // --- read ------------------------------------------------------------------------------------------
  const snapshot = yield* client.getSession({ sessionId: run.id });
  assert(
    "getSession reports the committed set as proposedIssues",
    JSON.stringify(snapshot.proposedIssues) === JSON.stringify(proposed),
    `proposedIssues=${JSON.stringify(snapshot.proposedIssues?.proposals.length ?? null)} proposals`,
  );

  // --- nowhere else ----------------------------------------------------------------------------------
  const rowsAfter = yield* rowCounts(run.id);
  observed.rows = { before: rowsBefore, after: rowsAfter };
  assert(
    "no other row moved: no session, card, event, run, page or delivery, and no other log",
    JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore),
    `before=${JSON.stringify(rowsBefore)} after=${JSON.stringify(rowsAfter)}`,
  );
  const listedAfter = yield* client.listSessions({ limit: 250 });
  const newSessions = listedAfter.sessions.filter(
    (entry) => !listedBefore.sessions.some((known) => known.id === entry.id),
  );
  assert(
    "the decomposition opened no session of its own",
    newSessions.length === 0,
    `new sessions: ${newSessions.map((entry) => entry.id).join(", ") || "none"}`,
  );
  const cardAfter = yield* client.getTask({ taskId: card.id });
  assert(
    "the card did not move and gained no revision",
    cardAfter.revision === cardBefore.revision &&
      cardAfter.column === cardBefore.column,
    `revision=${cardBefore.revision}->${cardAfter.revision} column=${cardAfter.column}`,
  );
  const newWrites = yield* sql<{ writes: string }>`
    SELECT writes::text AS writes FROM commits WHERE log_id = ${run.id} AND seq > ${seq} ORDER BY seq
  `;
  observed.newCommits = newWrites.length;
  const documentCommits = newWrites.filter((row) =>
    row.writes.includes("factory.proposedIssues"),
  ).length;
  assert(
    "the session's own log gained one commit of the document (and the call's spend)",
    documentCommits === 1,
    `new commits=${newWrites.length} of which factory.proposedIssues=${documentCommits}`,
  );
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
  path.join(EVIDENCE_DIR, "decompose.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
