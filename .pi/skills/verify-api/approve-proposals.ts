// The approval surface (LOB-202), driven with the real Effect RPC client against an API whose Linear
// is the loopback fake (`linear-api-fake.ts`): a specifier run delegated from a Linear issue
// proposes three child issues, and `approveProposals` creates only the approved ones — as children
// of the delegating issue, in its team — with the `blockedBy` edges that have both ends created.
//
//   bun approve-proposals.ts      (via ./approve-proposals.sh, which owns the API and the fake)
//
//   propose    `proposeDecomposition` answers the scripted three: B blocked by A, C by A and B
//   approve    approving A and C sends exactly two `issueCreate`s, each with the parent's team and
//              id, and exactly one `issueRelationCreate` (A blocks C); B is untouched
//   again      approving the same set sends nothing; B is still uncreated in `getSession`
//   later      approving B creates it and the two edges that were waiting for it
//   refused    a decomposed session no Linear issue opened is refused, and the ledger does not move
//
// The ledger is the fake's own file, read between calls: every request the API made, in order.
//
// Env: API_URL, EVIDENCE_DIR, EXPECT_SPEC, LINEAR_FAKE_LEDGER, LINEAR_PARENT (the delegating issue's
// identifier), DATABASE_URL (the drive's scratch database).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApproveProposalsResult } from "@repo/domain/Decomposition";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { DefinitionId } from "@repo/domain/Task";
import { Effect, Layer, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9428";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const LEDGER = process.env["LINEAR_FAKE_LEDGER"] ?? "";
const PARENT = process.env["LINEAR_PARENT"] ?? "";
const PERSON = "person:verify-api";
const ExpectSpec = Schema.fromJsonString(
  Schema.Struct({
    goal: Schema.String,
    acceptance: Schema.Array(Schema.String),
  }),
);
const SPEC = Schema.decodeSync(ExpectSpec)(process.env["EXPECT_SPEC"] ?? "");

await mkdir(EVIDENCE_DIR, { recursive: true });

type LedgerRequest = {
  readonly operation: string;
  readonly variables: { readonly input?: Record<string, unknown> };
};
type Ledger = {
  readonly requests: LedgerRequest[];
  readonly children: Array<{
    readonly id: string;
    readonly identifier: string;
    readonly teamId: string;
    readonly parentId: string;
    readonly title: string;
  }>;
  readonly relations: Array<{
    readonly issueId: string;
    readonly relatedIssueId: string;
    readonly type: string;
  }>;
};
const ledger = async (): Promise<Ledger> =>
  JSON.parse(await readFile(LEDGER, "utf8")) as Ledger;
const count = (state: Ledger, operation: string): number =>
  state.requests.filter((request) => request.operation === operation).length;

const observed: {
  apiUrl: string;
  parent: string;
  sessionId: SessionId | null;
  approvals: Record<string, ApproveProposalsResult | string>;
  ledger: Ledger | null;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  parent: PARENT,
  sessionId: null,
  approvals: {},
  ledger: null,
  checks: {},
};
const assert = makeChecker(observed);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);

  /** A specifier run on a card of its own, spec declared, optionally delegated from `issue`. */
  const specified = (title: string, issue: string | undefined) =>
    Effect.gen(function* () {
      const board = yield* client.createBoard({
        repo: RepoSlug.make(`verify-api/approve-${Date.now()}-${title}`),
        definitionId: DefinitionId.make("default"),
      });
      const created = yield* client.createTask({
        boardId: board.id,
        title,
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
        // The record the trigger seam writes when a Linear delivery opens a session.
        ...(issue === undefined
          ? {}
          : { requestId: `trigger:linear:${issue}:mapped` }),
      });
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
      return run.id;
    });

  const sessionId = yield* specified("delegated", PARENT);
  observed.sessionId = sessionId;

  // --- propose -------------------------------------------------------------------------------------------
  const proposed = yield* client.proposeDecomposition({ sessionId });
  assert(
    "proposeDecomposition answers the scripted three, with their edges",
    proposed.proposals.length === 3 &&
      JSON.stringify(proposed.proposals.map((p) => p.blockedBy)) ===
        JSON.stringify([[], [0], [0, 1]]),
    `titles=${JSON.stringify(proposed.proposals.map((p) => p.title))}`,
  );
  const beforeApproval = yield* Effect.promise(ledger);
  assert(
    "nothing was sent to Linear by proposing",
    beforeApproval.requests.length === 0,
    `requests=${beforeApproval.requests.length}`,
  );

  // --- approve -------------------------------------------------------------------------------------------
  const first = yield* client.approveProposals({ sessionId, approved: [0, 2] });
  observed.approvals["first [0,2]"] = first;
  const afterFirst = yield* Effect.promise(ledger);
  const creates = afterFirst.requests.filter(
    (request) => request.operation === "issueCreate",
  );
  const parentId = `uuid-${PARENT}`;
  assert(
    "approving two of three sends exactly two issueCreate, each with the parent's team and id",
    creates.length === 2 &&
      creates.every(
        (request) =>
          request.variables.input?.["parentId"] === parentId &&
          request.variables.input?.["teamId"] === `team-${PARENT}`,
      ) &&
      JSON.stringify(creates.map((c) => c.variables.input?.["title"])) ===
        JSON.stringify([
          proposed.proposals[0]?.title,
          proposed.proposals[2]?.title,
        ]),
    `issueCreate=${creates.length} titles=${JSON.stringify(creates.map((c) => c.variables.input?.["title"]))}`,
  );
  const [childA, childC] = afterFirst.children;
  assert(
    "the one edge with both ends approved is exactly one issueRelationCreate (A blocks C)",
    count(afterFirst, "issueRelationCreate") === 1 &&
      afterFirst.relations.length === 1 &&
      afterFirst.relations[0]?.issueId === childA?.id &&
      afterFirst.relations[0]?.relatedIssueId === childC?.id &&
      afterFirst.relations[0]?.type === "blocks",
    `relations=${JSON.stringify(afterFirst.relations)}`,
  );
  const snapshotFirst = yield* client.getSession({ sessionId });
  const recorded = snapshotFirst.proposedIssues?.proposals.map(
    (proposal) => proposal.created?.id ?? null,
  );
  assert(
    "each created id is recorded in factory.proposedIssues, and the unapproved proposal has none",
    JSON.stringify(recorded) ===
      JSON.stringify([childA?.id ?? "?", null, childC?.id ?? "?"]),
    `recorded=${JSON.stringify(recorded)}`,
  );

  // --- again -----------------------------------------------------------------------------------------------
  const second = yield* client.approveProposals({
    sessionId,
    approved: [0, 2],
  });
  observed.approvals["again [0,2]"] = second;
  const afterSecond = yield* Effect.promise(ledger);
  const writesOf = (state: Ledger) =>
    state.requests.filter((request) =>
      ["issueCreate", "issueRelationCreate"].includes(request.operation),
    ).length;
  const snapshotSecond = yield* client.getSession({ sessionId });
  assert(
    "approving the same set again sends no issueCreate and no write at all, and B stays uncreated",
    count(afterSecond, "issueCreate") === 2 &&
      writesOf(afterSecond) === writesOf(afterFirst) &&
      second.created.length === 0 &&
      snapshotSecond.proposedIssues?.proposals[1]?.created === undefined,
    `issueCreate=${count(afterSecond, "issueCreate")} created=${JSON.stringify(second.created)}`,
  );

  // --- later -----------------------------------------------------------------------------------------------
  const third = yield* client.approveProposals({ sessionId, approved: [1] });
  observed.approvals["later [1]"] = third;
  const afterThird = yield* Effect.promise(ledger);
  assert(
    "approving B later creates it and the two edges that were waiting for it",
    count(afterThird, "issueCreate") === 3 &&
      count(afterThird, "issueRelationCreate") === 3 &&
      third.created.length === 1 &&
      third.created[0] === 1 &&
      third.related === 2,
    `issueCreate=${count(afterThird, "issueCreate")} issueRelationCreate=${count(afterThird, "issueRelationCreate")}`,
  );

  // --- rerun (LOB-203): the same spec, proposed and approved again, creates nothing ---------------------------
  const rerun = yield* client.proposeDecomposition({ sessionId });
  const fourth = yield* client.approveProposals({
    sessionId,
    approved: [0, 1, 2],
  });
  observed.approvals["rerun [0,1,2]"] = fourth;
  const afterFourth = yield* Effect.promise(ledger);
  const snapshotFourth = yield* client.getSession({ sessionId });
  assert(
    "decomposing the same spec again and approving everything sends not one more write, and every id is still recorded",
    rerun.diff.added.length === 0 &&
      rerun.diff.updated.length === 0 &&
      rerun.diff.removed.length === 0 &&
      fourth.created.length === 0 &&
      fourth.related === 0 &&
      writesOf(afterFourth) === writesOf(afterThird) &&
      afterFourth.children.length === afterThird.children.length &&
      afterFourth.relations.length === afterThird.relations.length &&
      snapshotFourth.proposedIssues?.proposals.every(
        (proposal) =>
          proposal.created !== undefined &&
          afterFourth.children.find((child) => child.title === proposal.title)
            ?.id === proposal.created.id,
      ) === true,
    `diff=${JSON.stringify(rerun.diff)} created=${JSON.stringify(fourth.created)} writes=${writesOf(afterThird)}->${writesOf(afterFourth)}`,
  );

  // --- refused ---------------------------------------------------------------------------------------------
  const undelegated = yield* specified("undelegated", undefined);
  yield* client.proposeDecomposition({ sessionId: undelegated });
  const before = yield* Effect.promise(ledger);
  const refused = yield* Effect.flip(
    client.approveProposals({ sessionId: undelegated, approved: [0] }),
  );
  const after = yield* Effect.promise(ledger);
  observed.approvals["refused"] =
    refused._tag === "ApproveProposalsError"
      ? `${refused.reason}: ${refused.message}`
      : refused._tag;
  assert(
    "a decomposed session no Linear issue opened is refused no_delegating_issue, with no request",
    refused._tag === "ApproveProposalsError" &&
      refused.reason === "no_delegating_issue" &&
      after.requests.length === before.requests.length,
    `${observed.approvals["refused"]} requests=${before.requests.length}->${after.requests.length}`,
  );
  observed.ledger = after;
});

try {
  await Effect.runPromise(
    program.pipe(
      Effect.provide(Layer.mergeAll(protocolFor(API_URL))),
      Effect.scoped,
    ),
  );
} catch (error) {
  assert("the drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, "approve-proposals.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
