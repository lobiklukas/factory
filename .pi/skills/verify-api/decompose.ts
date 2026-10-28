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
//   rerun      the same spec decomposed again answers a diff of nothing but `unchanged`, the same
//              proposals, and no second commit of the document (LOB-203)
//   nowhere    every table's content is as it was (a fingerprint, so an UPDATE counts), the log of
//              every other session included, the card did not move, and the session's own log
//              gained one commit of the document
//
// Not proven here: that no tracker request is made. This API instance holds no tracker credentials,
// so a request it did not make proves nothing; the proof is the core suite's HTTP ledger
// (`packages/core/src/SessionService.test.ts`, "proposing child issues from a spec"), which records
// every request the process could make and asserts it empty.
//
// Env: API_URL, EVIDENCE_DIR, EXPECT_SPEC (the spec the shell's faux specifier declares),
// DATABASE_URL (the scratch database the shell minted).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProposeDecompositionResult } from "@repo/domain/Decomposition";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { DefinitionId } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9424";
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
  proposed: ProposeDecompositionResult | null;
  rerun: ProposeDecompositionResult | null;
  rows: Record<string, unknown>;
  newCommits: number;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  sessionId: null,
  spec: SPEC,
  proposed: null,
  rerun: null,
  rows: {},
  newCommits: 0,
  checks: {},
};
const assert = makeChecker(observed);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const sql = yield* SqlClient;

  /**
   * A content fingerprint of every table in the schema — row count and an `md5` over every row in a
   * fixed order — but `sessionId`'s own log and activity row, which the decomposition writes by
   * design. An UPDATE moves a fingerprint where it would leave a row count alone, and the tables are
   * read from the catalog, so a table a later migration adds is covered too.
   */
  const fingerprint = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const tables = yield* sql<{ name: string }>`
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;
      const own: Record<string, string> = {
        commits: "log_id",
        session_activity: "session_id",
      };
      const prints: Record<string, string> = {};
      for (const { name } of tables) {
        const column = own[name];
        const rows =
          column === undefined
            ? yield* sql<{ print: string }>`
                SELECT count(*)::text || ':' || md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS print
                FROM ${sql(name)} t
              `
            : yield* sql<{ print: string }>`
                SELECT count(*)::text || ':' || md5(coalesce(string_agg(t::text, E'\n' ORDER BY t::text), '')) AS print
                FROM ${sql(name)} t WHERE ${sql(column)} <> ${sessionId}
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
  const rowsBefore = yield* fingerprint(run.id);
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
    JSON.stringify(snapshot.proposedIssues) ===
      JSON.stringify({ proposals: proposed.proposals }),
    `proposedIssues=${JSON.stringify(snapshot.proposedIssues?.proposals.length ?? null)} proposals`,
  );

  // --- nowhere else ----------------------------------------------------------------------------------
  const rowsAfter = yield* fingerprint(run.id);
  observed.rows = { before: rowsBefore, after: rowsAfter };
  assert(
    "no other row was inserted, deleted or updated: every table but the session's own log and activity row",
    Object.keys(rowsBefore).includes("sessions") &&
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

  // --- rerun: the same spec, decomposed again, is the same proposals (LOB-203) -------------------------
  const rerunSeq = yield* headSeq(run.id);
  const rerun = yield* client.proposeDecomposition({ sessionId: run.id });
  observed.rerun = rerun;
  assert(
    "decomposing the same spec again answers the same proposals as a diff of nothing but unchanged",
    JSON.stringify(rerun.proposals) === JSON.stringify(proposed.proposals) &&
      rerun.diff.added.length === 0 &&
      rerun.diff.updated.length === 0 &&
      rerun.diff.removed.length === 0 &&
      JSON.stringify(rerun.diff.unchanged) ===
        JSON.stringify(proposed.proposals.map((p) => p.title)),
    `diff=${JSON.stringify(rerun.diff)}`,
  );
  const rerunWrites = yield* sql<{ writes: string }>`
    SELECT writes::text AS writes FROM commits WHERE log_id = ${run.id} AND seq > ${rerunSeq} ORDER BY seq
  `;
  assert(
    "the rerun committed no second copy of the document",
    rerunWrites.every((row) => !row.writes.includes("factory.proposedIssues")),
    `new commits=${rerunWrites.length}, none writing factory.proposedIssues`,
  );
  const rerunSnapshot = yield* client.getSession({ sessionId: run.id });
  assert(
    "getSession still reports the one set",
    JSON.stringify(rerunSnapshot.proposedIssues) ===
      JSON.stringify(snapshot.proposedIssues),
    `proposedIssues=${rerunSnapshot.proposedIssues?.proposals.length ?? null} proposals`,
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
