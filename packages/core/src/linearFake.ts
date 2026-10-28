/**
 * An in-process Linear for tests (LOB-15, extended by LOB-202): one stateful issue behind the Effect
 * `HttpClient` seam, answering the GraphQL operations `LinearSync` sends as Linear's schema spells
 * them, and recording every request.
 *
 * LOB-15's four operations — the issue read, `commentCreate`, `issueUpdate`, `attachmentCreate` —
 * are the issue's own state. LOB-202 adds what a session's proposals need: the parent read that
 * carries the team and the children (`issueChildren`), `issueCreate` (a child of the issue, in its
 * team), the blocker's relations (`issueRelations`) and `issueRelationCreate`. It is written from
 * Linear's documented schema, so it proves what the code sends and how it reads the answers, not that
 * Linear accepts them: it does not validate that the team and parent exist or belong together, and it
 * renders no sub-issue (`docs/testing-third-parties.md`).
 *
 * LOB-45 adds the plan: the parent's children with their titles, states and descriptions
 * (`issuePlan`), children seeded by a case (`FakeOptions.children`), and the per-child writes a
 * re-scope and a close send — the issue read, `issueUpdate` and `commentCreate` on a child.
 *
 * T5 adds what a delegated run's questions and an issue's blockers need: the issue's blockers
 * (`FakeOptions.blockers`, read by `issueBlockers` as inverse relations), `agentSessionCreateOnIssue`
 * and `agentActivityCreate` (the elicitation), recorded as `agentSessions` and `activities`.
 *
 * A test file, not exported from the package: `LinearSync.test.ts` and `SessionService.test.ts` share
 * it so the approval cases run against the same fake the write-back cases do.
 */
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { LinearWorkflowState } from "./LinearSync";

export const state = (
  id: string,
  name: string,
  type: string,
): LinearWorkflowState => ({ id, name, type });

export const TODO = state("st-todo", "Todo", "unstarted");
export const PROGRESS = state("st-progress", "In Progress", "started");
export const REVIEW = state("st-review", "In Review", "started");
export const DONE = state("st-done", "Done", "completed");
export const CANCELED = state("st-canceled", "Canceled", "canceled");
export const TEAM = [TODO, PROGRESS, REVIEW, DONE, CANCELED];

/** A request the fake saw: the operation, its variables, and the key it carried. */
export type Seen = {
  readonly operation: string;
  readonly variables: Record<string, unknown>;
  readonly authorization: string | undefined;
};

export type FakeOptions = {
  /** The issue's identifier; per case on Postgres, because a session's request id is unique. */
  readonly identifier?: string;
  readonly start?: LinearWorkflowState;
  readonly states?: readonly LinearWorkflowState[];
  readonly comments?: readonly string[];
  /** Apply this mutation, then answer 500 the first time: the lost acknowledgement. */
  readonly loseAckOnce?: string;
  /** Answer this operation with GraphQL `errors` on HTTP 200. */
  readonly refuse?: string;
  /** Answer this mutation with `success: false`. */
  readonly unsuccessful?: string;
  /** Answer this mutation with `success: false` the first time only, applying nothing. */
  readonly unsuccessfulOnce?: string;
  /** Answer this operation the way Linear rate-limits: HTTP 400, `RATELIMITED`, this many times. */
  readonly rateLimit?: { readonly operation: string; readonly times: number };
  /** Never answer this operation, this many times (`Infinity`: never at all). */
  readonly hang?: { readonly operation: string; readonly times: number };
  /** Answer the `nth` (1-based) request of this operation with GraphQL `errors`, that once. */
  readonly refuseNth?: { readonly operation: string; readonly nth: number };
  /**
   * Issues that block this one (T5), each by the identifier a person reads and the state it is in
   * (default `In Progress`). The returned `blockers` are live: a case moves one to `DONE`.
   */
  readonly blockers?: ReadonlyArray<{
    readonly identifier: string;
    readonly state?: LinearWorkflowState;
    /** The relation's type (default `blocks`): a `related` issue holds nothing up. */
    readonly type?: string;
  }>;
  /** Children the parent already has (LOB-45): the plan a plan-freshness pass reads. */
  readonly children?: ReadonlyArray<{
    readonly title: string;
    readonly description?: string;
    readonly state?: LinearWorkflowState;
  }>;
};

/** An issue the fake made for an `issueCreate`, or a child a case seeded. */
export type CreatedChild = {
  readonly id: string;
  readonly identifier: string;
  readonly teamId: string;
  readonly parentId: string;
  title: string;
  description: string;
  /** Where the child is (LOB-45): `issueUpdate` with a `stateId` moves it. */
  state: LinearWorkflowState;
  readonly comments: string[];
};

/** The operations that only read: what `writes()` leaves out. */
const READS = new Set([
  "issue",
  "issueBlockers",
  "issueChildren",
  "issueRelations",
  "issuePlan",
]);

const Json = Schema.fromJsonString(Schema.Unknown);
const RequestBody = Schema.Struct({
  query: Schema.String,
  variables: Schema.Record(Schema.String, Schema.Unknown),
});

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

/** One Linear issue, stateful, answering the sync's four operations as Linear's schema spells them. */
export const makeLinear = (options: FakeOptions = {}) => {
  const states = options.states ?? TEAM;
  const issue = {
    id:
      options.identifier === undefined
        ? "iss-uuid-1"
        : `iss-${options.identifier}`,
    identifier: options.identifier ?? "ENG-42",
    state: options.start ?? TODO,
    comments: [...(options.comments ?? [])],
    attachments: [] as Array<{ url: string; title: string }>,
  };
  /** The team the issue belongs to — what `issueCreate` must be given (LOB-202). */
  const teamId = "team-uuid-1";
  const prefix = issue.identifier.split("-")[0] ?? "ENG";
  const children: CreatedChild[] = (options.children ?? []).map(
    (child, index) => ({
      id: `iss-seed-${index + 1}`,
      identifier: `${prefix}-${10 + index + 1}`,
      teamId,
      parentId: issue.id,
      title: child.title,
      description: child.description ?? "",
      state: child.state ?? TODO,
      comments: [],
    }),
  );
  const relations: Array<{
    issueId: string;
    relatedIssueId: string;
    type: string;
  }> = [];
  /** The issues blocking this one (T5); a case moves one by setting its `state`. */
  const blockers = (options.blockers ?? []).map((blocker, index) => ({
    id: `iss-blocker-${index + 1}`,
    identifier: blocker.identifier,
    state: blocker.state ?? PROGRESS,
    type: blocker.type ?? "blocks",
  }));
  /** The agent sessions `agentSessionCreateOnIssue` opened (T5), by issue. */
  const agentSessions: Array<{
    readonly id: string;
    readonly issueId: string;
  }> = [];
  /** Every `agentActivityCreate` that landed (T5): the session and the typed content. */
  const activities: Array<{
    readonly agentSessionId: string;
    readonly content: Record<string, unknown>;
  }> = [];
  const counts = new Map<string, number>();
  const seen: Seen[] = [];
  const lost = new Set<string>();
  const refusedOnce = new Set<string>();
  let limitsLeft = options.rateLimit?.times ?? 0;
  let hangsLeft = options.hang?.times ?? 0;

  const operationOf = (query: string): string =>
    query.includes("agentSessionCreateOnIssue")
      ? "agentSessionCreateOnIssue"
      : query.includes("agentActivityCreate")
        ? "agentActivityCreate"
        : query.includes("FactoryBlockers")
          ? "issueBlockers"
          : query.includes("commentCreate")
            ? "commentCreate"
            : query.includes("issueUpdate")
              ? "issueUpdate"
              : query.includes("attachmentCreate")
                ? "attachmentCreate"
                : query.includes("issueRelationCreate")
                  ? "issueRelationCreate"
                  : query.includes("issueCreate")
                    ? "issueCreate"
                    : query.includes("FactoryParent")
                      ? "issueChildren"
                      : query.includes("FactoryRelations")
                        ? "issueRelations"
                        : query.includes("FactoryPlan")
                          ? "issuePlan"
                          : "issue";
  const isParent = (id: unknown) => id === issue.id || id === issue.identifier;
  const everyIssue = () => [
    { id: issue.id, identifier: issue.identifier },
    ...children,
  ];

  const childOf = (id: unknown) =>
    children.find((child) => child.id === id || child.identifier === id);

  const answer = (operation: string, variables: Record<string, unknown>) => {
    const input = asRecord(variables["input"]);
    const child =
      operation === "commentCreate"
        ? childOf(input["issueId"])
        : childOf(variables["id"]);
    if (child !== undefined && operation === "issue") {
      return {
        issue: {
          id: child.id,
          identifier: child.identifier,
          state: child.state,
          team: { states: { nodes: states } },
          comments: { nodes: child.comments.map((body) => ({ body })) },
          attachments: { nodes: [] },
        },
      };
    }
    if (child !== undefined && operation === "commentCreate") {
      child.comments.push(String(input["body"]));
      return { commentCreate: { success: true } };
    }
    if (child !== undefined && operation === "issueUpdate") {
      if (typeof input["title"] === "string") child.title = input["title"];
      if (typeof input["description"] === "string") {
        child.description = input["description"];
      }
      if (input["stateId"] !== undefined) {
        const next = states.find((s) => s.id === input["stateId"]);
        if (next === undefined) return { issueUpdate: { success: false } };
        child.state = next;
      }
      return { issueUpdate: { success: true } };
    }
    switch (operation) {
      case "issueBlockers":
        return {
          issue: isParent(variables["id"])
            ? {
                id: issue.id,
                identifier: issue.identifier,
                inverseRelations: {
                  nodes: blockers.map((blocker) => ({
                    type: blocker.type,
                    issue: {
                      id: blocker.id,
                      identifier: blocker.identifier,
                      state: { type: blocker.state.type },
                    },
                  })),
                },
              }
            : null,
        };
      case "agentSessionCreateOnIssue": {
        const made = {
          id: `agent-session-${agentSessions.length + 1}`,
          issueId: String(input["issueId"]),
        };
        agentSessions.push(made);
        return {
          agentSessionCreateOnIssue: {
            success: true,
            agentSession: { id: made.id },
          },
        };
      }
      case "agentActivityCreate":
        activities.push({
          agentSessionId: String(input["agentSessionId"]),
          content: asRecord(input["content"]),
        });
        return { agentActivityCreate: { success: true } };
      case "issuePlan":
        return {
          issue: isParent(variables["id"])
            ? {
                id: issue.id,
                identifier: issue.identifier,
                children: {
                  nodes: children.map((one) => ({
                    id: one.id,
                    identifier: one.identifier,
                    title: one.title,
                    description: one.description,
                    state: { name: one.state.name, type: one.state.type },
                  })),
                },
              }
            : null,
        };
      case "issue":
        return {
          issue:
            variables["id"] === issue.id || variables["id"] === issue.identifier
              ? {
                  id: issue.id,
                  identifier: issue.identifier,
                  state: issue.state,
                  team: { states: { nodes: states } },
                  comments: {
                    nodes: issue.comments.map((body) => ({ body })),
                  },
                  attachments: {
                    nodes: issue.attachments.map(({ url }) => ({ url })),
                  },
                }
              : null,
        };
      case "issueChildren":
        return {
          issue: isParent(variables["id"])
            ? {
                id: issue.id,
                identifier: issue.identifier,
                team: { id: teamId },
                children: {
                  nodes: children.map((child) => ({
                    id: child.id,
                    identifier: child.identifier,
                    description: child.description,
                  })),
                },
              }
            : null,
        };
      case "issueCreate": {
        const made: CreatedChild = {
          id: `iss-child-${children.length + 1}`,
          identifier: `${prefix}-${100 + children.length + 1}`,
          teamId: String(input["teamId"]),
          parentId: String(input["parentId"]),
          title: String(input["title"]),
          description:
            typeof input["description"] === "string"
              ? input["description"]
              : "",
          state: TODO,
          comments: [],
        };
        children.push(made);
        return {
          issueCreate: {
            success: true,
            issue: { id: made.id, identifier: made.identifier },
          },
        };
      }
      case "issueRelations": {
        const known = everyIssue().find((one) => one.id === variables["id"]);
        return {
          issue:
            known === undefined
              ? null
              : {
                  id: known.id,
                  identifier: known.identifier,
                  relations: {
                    nodes: relations
                      .filter((relation) => relation.issueId === known.id)
                      .map((relation) => ({
                        type: relation.type,
                        relatedIssue: { id: relation.relatedIssueId },
                      })),
                  },
                },
        };
      }
      case "issueRelationCreate":
        relations.push({
          issueId: String(input["issueId"]),
          relatedIssueId: String(input["relatedIssueId"]),
          type: String(input["type"]),
        });
        return { issueRelationCreate: { success: true } };
      case "commentCreate":
        issue.comments.push(String(input["body"]));
        return { commentCreate: { success: true } };
      case "issueUpdate": {
        const next = states.find((s) => s.id === input["stateId"]);
        if (next !== undefined) issue.state = next;
        return { issueUpdate: { success: next !== undefined } };
      }
      default:
        issue.attachments.push({
          url: String(input["url"]),
          title: String(input["title"]),
        });
        return { attachmentCreate: { success: true } };
    }
  };

  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const raw =
        request.body._tag === "Uint8Array"
          ? new TextDecoder().decode(request.body.body)
          : "{}";
      const body = yield* Schema.decodeEffect(
        Schema.fromJsonString(RequestBody),
      )(raw);
      const operation = operationOf(body.query);
      seen.push({
        operation,
        variables: body.variables,
        authorization: request.headers["authorization"],
      });
      const reply = (status: number, payload: unknown) =>
        Schema.encodeEffect(Json)(payload).pipe(
          Effect.map((text) =>
            HttpClientResponse.fromWeb(
              request,
              new Response(text, {
                status,
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        );
      const nth = (counts.get(operation) ?? 0) + 1;
      counts.set(operation, nth);
      if (options.hang?.operation === operation && hangsLeft > 0) {
        hangsLeft -= 1;
        return yield* Effect.never;
      }
      if (options.rateLimit?.operation === operation && limitsLeft > 0) {
        limitsLeft -= 1;
        return yield* reply(400, {
          data: null,
          errors: [
            {
              message: "Rate limit exceeded",
              extensions: { code: "RATELIMITED" },
            },
          ],
        });
      }
      if (
        options.refuseNth?.operation === operation &&
        options.refuseNth.nth === nth
      ) {
        return yield* reply(200, {
          data: null,
          errors: [{ message: "Team is archived" }],
        });
      }
      if (options.refuse === operation) {
        return yield* reply(200, {
          data: null,
          errors: [{ message: "Entity not found" }],
        });
      }
      if (
        options.unsuccessfulOnce === operation &&
        !refusedOnce.has(operation)
      ) {
        refusedOnce.add(operation);
        return yield* reply(200, {
          data: { [operation]: { success: false } },
        });
      }
      if (options.unsuccessful === operation) {
        return yield* reply(200, {
          data: { [operation]: { success: false } },
        });
      }
      const data = answer(operation, body.variables);
      if (options.loseAckOnce === operation && !lost.has(operation)) {
        lost.add(operation);
        return yield* reply(500, { error: "upstream timeout" });
      }
      return yield* reply(200, { data });
    }).pipe(Effect.orDie),
  );
  const layer = Layer.succeed(HttpClient.HttpClient, client);
  const writes = (operation?: string) =>
    seen.filter((s) =>
      operation === undefined
        ? !READS.has(s.operation)
        : s.operation === operation,
    );
  return {
    issue,
    teamId,
    children,
    relations,
    blockers,
    agentSessions,
    activities,
    seen,
    writes,
    client,
    layer,
  };
};
