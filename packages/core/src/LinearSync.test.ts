/**
 * Session → Linear (LOB-15): the state map, the comments, and the idempotency that makes a retry
 * safe.
 *
 * Linear is an in-process fake behind the Effect `HttpClient` seam: a small stateful issue that
 * answers the four GraphQL operations the sync sends — the issue read, `commentCreate`,
 * `issueUpdate` and `attachmentCreate` — and records every request. It is written from Linear's
 * documented schema, so it proves what this code sends and how it reads the answers, not that
 * Linear accepts them (`docs/testing-third-parties.md`). The cases that need a session's request id
 * and its PR link (which issue a PR belongs to) run against Postgres, as the rest of `core` does.
 *
 * Needs Postgres for the last block: `docker compose up -d --wait postgres`.
 */
import { randomBytes } from "node:crypto";
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionId } from "@repo/domain/Session";
import { SessionError } from "@repo/domain/Session";
import type { TriggerEvent } from "@repo/domain/Trigger";
import type { VerifyRecord } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { linearDelivery, linearIssueOfDelivery } from "./Linear";
import {
  DEFAULT_LINEAR_STATES,
  githubPullRequestLifecycle,
  type LinearConfig,
  linearConfigFromEnv,
  linearEvidenceLines,
  LinearIssueSync,
  LinearIssueSyncLive,
  type LinearIssueSyncShape,
  LinearSessionWriteBack,
  LinearTriggerWriteBack,
  type LinearWorkflowState,
  nextLinearState,
  syncPullRequestLifecycle,
} from "./LinearSync";
import { PrError } from "./pr";
import {
  pullRequestReport,
  SessionWriteBack,
  type PullRequestStepExit,
} from "./SessionWriteBack";
import {
  deliveryIdOfSession,
  sessionRequestIdOf,
  TriggerWriteBack,
} from "./TriggerService";

const sessionId = "ses_01j8z000000000000000000000" as SessionId;

const state = (
  id: string,
  name: string,
  type: string,
): LinearWorkflowState => ({ id, name, type });

const TODO = state("st-todo", "Todo", "unstarted");
const PROGRESS = state("st-progress", "In Progress", "started");
const REVIEW = state("st-review", "In Review", "started");
const DONE = state("st-done", "Done", "completed");
const CANCELED = state("st-canceled", "Canceled", "canceled");
const TEAM = [TODO, PROGRESS, REVIEW, DONE, CANCELED];

const config: LinearConfig = {
  apiUrl: "http://linear.test/graphql",
  apiKey: Redacted.make("lin_api_test"),
  states: DEFAULT_LINEAR_STATES,
  sessionUrlBase: "http://localhost:3000/sessions/",
};

const pr = { number: 7, url: "https://github.com/acme/widgets/pull/7" };

const ran = (exitCode: number): VerifyRecord => ({
  _tag: "VerifyReport",
  changed: ["apps/api/src/index.ts"],
  changedCount: 1,
  results: [
    {
      _tag: "VerifyRan",
      surface: "api",
      source: "skill",
      directory: ".pi/skills/verify-api",
      command: "./up.sh && bun drive.ts",
      exitCode,
      output: "ok",
      truncated: false,
    },
  ],
});

describe("nextLinearState", () => {
  const decide = (
    current: LinearWorkflowState,
    phase: "started" | "inReview" | "done",
    states: readonly LinearWorkflowState[] = TEAM,
  ) =>
    nextLinearState({
      current,
      states,
      mapping: DEFAULT_LINEAR_STATES,
      phase,
    });

  it("moves an unstarted issue to the mapped state", () => {
    expect(decide(TODO, "started")).toEqual({ _tag: "move", state: PROGRESS });
    expect(decide(PROGRESS, "inReview")).toEqual({
      _tag: "move",
      state: REVIEW,
    });
    expect(decide(REVIEW, "done")).toEqual({ _tag: "move", state: DONE });
  });

  it("matches the mapped name whatever its case", () => {
    expect(
      decide(TODO, "started", [TODO, state("x", "in progress", "started")]),
    ).toEqual({ _tag: "move", state: state("x", "in progress", "started") });
  });

  it("stays when the issue is already in the state", () => {
    expect(decide(PROGRESS, "started")._tag).toBe("stay");
  });

  it("moves forward only: a late started does not drag an issue out of review", () => {
    const decision = decide(REVIEW, "started");
    expect(decision._tag).toBe("stay");
  });

  it("never reopens an issue a person closed", () => {
    expect(decide(DONE, "inReview")._tag).toBe("stay");
    expect(decide(CANCELED, "started")._tag).toBe("stay");
    expect(decide(CANCELED, "done")._tag).toBe("stay");
  });

  it("names the missing state and the team's own when the map names one the team lacks", () => {
    expect(decide(TODO, "inReview", [TODO, PROGRESS, DONE])).toEqual({
      _tag: "missing",
      name: "In Review",
      available: ["Todo", "In Progress", "Done"],
    });
  });
});

describe("linearConfigFromEnv", () => {
  const env = {
    apiUrl: undefined,
    apiKey: undefined,
    stateStarted: undefined,
    stateInReview: undefined,
    stateDone: undefined,
    sessionUrlBase: undefined,
  };

  it("is no write-back without a key", () => {
    expect(linearConfigFromEnv(env)).toBeUndefined();
    expect(linearConfigFromEnv({ ...env, apiKey: "  " })).toBeUndefined();
  });

  it("defaults the endpoint and Linear's own state names", () => {
    const config = linearConfigFromEnv({ ...env, apiKey: "lin_api_x" });
    expect(config?.apiUrl).toBe("https://api.linear.app/graphql");
    expect(config?.states).toEqual(DEFAULT_LINEAR_STATES);
    expect(config === undefined ? "" : Redacted.value(config.apiKey)).toBe(
      "lin_api_x",
    );
  });

  it("takes a team's own state names, and a blank one is the default", () => {
    const config = linearConfigFromEnv({
      ...env,
      apiKey: "lin_api_x",
      stateStarted: " Doing ",
      stateInReview: "",
      stateDone: "Shipped",
    });
    expect(config?.states).toEqual({
      started: "Doing",
      inReview: "In Review",
      done: "Shipped",
    });
  });
});

describe("pullRequestReport", () => {
  it("reads both PR paths as the PR", () => {
    for (const outcome of ["opened", "already-open"] as const) {
      expect(pullRequestReport(Exit.succeed({ ...pr, outcome }))).toEqual({
        _tag: "opened",
        pr,
      });
    }
  });

  it("reads the two refusals as failed runs, with the numbers", () => {
    const overCap = pullRequestReport(
      Exit.succeed({
        outcome: "over-cap",
        limit: "files",
        cap: 50,
        measured: 73,
      }),
    );
    expect(overCap._tag).toBe("failed");
    if (overCap._tag !== "failed") return;
    expect(overCap.step).toBe("over-cap");
    expect(overCap.reason).toContain("73 files");
    expect(overCap.reason).toContain("cap of 50");

    const noChange = pullRequestReport(Exit.succeed({ outcome: "no-change" }));
    expect(noChange).toMatchObject({ _tag: "failed", step: "no-change" });
  });

  it("reads a typed error as a failed run that names it", () => {
    const report = pullRequestReport(
      Exit.fail(
        new PrError({
          operation: "createPullRequest",
          ref: "acme/widgets",
          message: "GitHub answered 403",
        }),
      ),
    );
    expect(report).toEqual({
      _tag: "failed",
      step: "pr-error",
      reason: "the pull request step failed (PrError): GitHub answered 403",
    });
  });

  it("reads a defect as a failed run too, and an interrupt as nothing", () => {
    const died: PullRequestStepExit = Exit.die(new Error("git vanished"));
    expect(pullRequestReport(died)).toMatchObject({
      _tag: "failed",
      step: "pr-error",
    });
    expect(pullRequestReport(Exit.interrupt(1))).toEqual({
      _tag: "interrupted",
    });
  });
});

describe("linearEvidenceLines", () => {
  it("says so when the session recorded no verification", () => {
    expect(linearEvidenceLines([])).toEqual([
      "No verification was recorded in the session.",
    ]);
  });

  it("reports the last verify call, not the first", () => {
    const lines = linearEvidenceLines([ran(1), ran(0)]).join("\n");
    expect(lines).toContain("the last of the session's 2 `verify` calls");
    expect(lines).toContain("`api` passed (exit 0)");
    expect(lines).not.toContain("failed");
  });

  it("names a failing surface as failed, with its exit code and command", () => {
    const lines = linearEvidenceLines([ran(2)]).join("\n");
    expect(lines).toContain("`api` failed (exit 2): `./up.sh && bun drive.ts`");
  });
});

describe("the issue a session belongs to", () => {
  it("round-trips from a mapped Linear delivery to the session's request id and back", () => {
    const delivery = linearDelivery(
      {
        action: "create",
        type: "Issue",
        data: { id: "iss-uuid-1", title: "t", labels: [{ name: "factory" }] },
      },
      [
        {
          label: "factory",
          repo: "acme/widgets" as never,
          prompt: "{{title}}",
        },
      ],
    );
    expect(delivery?.requestId).toBe("linear:iss-uuid-1:mapped");
    const stored = sessionRequestIdOf(delivery?.requestId ?? "");
    expect(linearIssueOfDelivery(deliveryIdOfSession(stored))).toBe(
      "iss-uuid-1",
    );
  });

  it("is no issue for a session no Linear issue opened", () => {
    expect(deliveryIdOfSession(null)).toBeUndefined();
    expect(deliveryIdOfSession("client-retry-1")).toBeUndefined();
    expect(
      linearIssueOfDelivery(deliveryIdOfSession("trigger:jira:x:1")),
    ).toBeUndefined();
    // An unmapped Linear key started nothing, so it names no issue's session.
    expect(
      linearIssueOfDelivery("linear:iss-1:unmapped:no-labels"),
    ).toBeUndefined();
  });
});

describe("githubPullRequestLifecycle", () => {
  const body = (action: string, merged: boolean) => ({
    action,
    pull_request: { number: 7, html_url: pr.url, merged },
  });

  it("reads a merge, an unmerged close, and anything else", () => {
    expect(githubPullRequestLifecycle(body("closed", true))).toEqual({
      _tag: "merged",
      pr,
    });
    expect(githubPullRequestLifecycle(body("closed", false))).toEqual({
      _tag: "closed",
      pr,
    });
    // A new commit is a PR event the issue's state does not follow.
    expect(githubPullRequestLifecycle(body("synchronize", false))).toEqual({
      _tag: "other",
      action: "synchronize",
    });
    expect(githubPullRequestLifecycle({ action: "closed" })).toBeUndefined();
  });
});

/** A request the fake saw: the operation, its variables, and the key it carried. */
type Seen = {
  readonly operation: string;
  readonly variables: Record<string, unknown>;
  readonly authorization: string | undefined;
};

type FakeOptions = {
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
};

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
const makeLinear = (options: FakeOptions = {}) => {
  const states = options.states ?? TEAM;
  const issue = {
    id: "iss-uuid-1",
    identifier: options.identifier ?? "ENG-42",
    state: options.start ?? TODO,
    comments: [...(options.comments ?? [])],
    attachments: [] as Array<{ url: string; title: string }>,
  };
  const seen: Seen[] = [];
  const lost = new Set<string>();

  const operationOf = (query: string): string =>
    query.includes("commentCreate")
      ? "commentCreate"
      : query.includes("issueUpdate")
        ? "issueUpdate"
        : query.includes("attachmentCreate")
          ? "attachmentCreate"
          : "issue";

  const answer = (operation: string, variables: Record<string, unknown>) => {
    const input = asRecord(variables["input"]);
    switch (operation) {
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

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
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
        if (options.refuse === operation) {
          return yield* reply(200, {
            data: null,
            errors: [{ message: "Entity not found" }],
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
    ),
  );
  const writes = (operation?: string) =>
    seen.filter((s) =>
      operation === undefined
        ? s.operation !== "issue"
        : s.operation === operation,
    );
  return { issue, seen, writes, layer };
};

const withSync = <A, E>(
  fake: ReturnType<typeof makeLinear>,
  body: (sync: LinearIssueSyncShape) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const sync = yield* LinearIssueSync;
      return yield* body(sync);
    }).pipe(
      Effect.provide(
        LinearIssueSyncLive(config).pipe(Layer.provide(fake.layer)),
      ),
    ),
  );

describe("LinearIssueSyncLive", () => {
  it("moves a started session's issue to In Progress, as the configured key", async () => {
    const fake = makeLinear();
    const exit = await withSync(fake, (sync) =>
      sync.started({ issueId: "ENG-42", sessionId }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.issue.state).toEqual(PROGRESS);
    expect(fake.writes()).toEqual([
      {
        operation: "issueUpdate",
        variables: { id: "iss-uuid-1", input: { stateId: PROGRESS.id } },
        authorization: "lin_api_test",
      },
    ]);
  });

  it("opens the loop: attaches the PR, comments its link and evidence, reaches In Review", async () => {
    const fake = makeLinear({ start: PROGRESS });
    const exit = await withSync(fake, (sync) =>
      sync.pullRequestOpened({
        issueId: "ENG-42",
        sessionId,
        pr,
        evidence: [ran(0)],
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.issue.state).toEqual(REVIEW);
    expect(fake.issue.attachments).toEqual([
      { url: pr.url, title: "Pull request #7" },
    ]);
    expect(fake.issue.comments).toHaveLength(1);
    const comment = fake.issue.comments[0] ?? "";
    expect(comment).toContain(`[#7](${pr.url})`);
    expect(comment).toContain(
      `[${sessionId}](http://localhost:3000/sessions/${sessionId})`,
    );
    expect(comment).toContain("`api` passed (exit 0)");
    expect(comment).toContain(`\`factory:${sessionId}:pr\``);
    expect(fake.writes().map((s) => s.operation)).toEqual([
      "attachmentCreate",
      "commentCreate",
      "issueUpdate",
    ]);
  });

  it("writes nothing the second time: a retried PR report reads, and stops", async () => {
    const fake = makeLinear({ start: PROGRESS });
    const report = (sync: LinearIssueSyncShape) =>
      sync.pullRequestOpened({
        issueId: "ENG-42",
        sessionId,
        pr,
        evidence: [],
      });
    await withSync(fake, report);
    const before = fake.writes().length;
    const exit = await withSync(fake, report);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.writes()).toHaveLength(before);
    expect(fake.issue.comments).toHaveLength(1);
    expect(fake.issue.attachments).toHaveLength(1);
  });

  it("a comment that landed and lost its acknowledgement is not posted twice by the retry", async () => {
    const fake = makeLinear({
      start: PROGRESS,
      loseAckOnce: "commentCreate",
    });
    const exit = await withSync(fake, (sync) =>
      sync.pullRequestOpened({
        issueId: "ENG-42",
        sessionId,
        pr,
        evidence: [],
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.writes("commentCreate")).toHaveLength(1);
    expect(fake.issue.comments).toHaveLength(1);
    // The retry re-read the issue (two reads) and went on to the state.
    expect(fake.seen.filter((s) => s.operation === "issue")).toHaveLength(2);
    expect(fake.issue.state).toEqual(REVIEW);
  });

  it("a late started does not move an issue already in review back", async () => {
    const fake = makeLinear({ start: REVIEW });
    await withSync(fake, (sync) =>
      sync.started({ issueId: "ENG-42", sessionId }),
    );
    expect(fake.writes()).toEqual([]);
    expect(fake.issue.state).toEqual(REVIEW);
  });

  it("a failed run leaves one explanatory comment, and a retry of it leaves none more", async () => {
    const fake = makeLinear({ start: PROGRESS });
    const fail = (sync: LinearIssueSyncShape) =>
      sync.failed({
        issueId: "ENG-42",
        sessionId,
        step: "no-change",
        reason: "the run changed no file against its base branch",
      });
    await withSync(fake, fail);
    await withSync(fake, fail);
    expect(fake.issue.comments).toHaveLength(1);
    expect(fake.issue.comments[0]).toContain(
      "did not produce a pull request: the run changed no file against its base branch.",
    );
    expect(fake.issue.comments[0]).toContain(
      `factory:${sessionId}:failed:no-change`,
    );
    // The task is neither done nor in review: a failure moves no state.
    expect(fake.issue.state).toEqual(PROGRESS);
    expect(fake.writes("issueUpdate")).toEqual([]);
  });

  it("a different failure of the same session still explains itself", async () => {
    const fake = makeLinear({ start: PROGRESS });
    await withSync(fake, (sync) =>
      sync.failed({
        issueId: "ENG-42",
        sessionId,
        step: "no-change",
        reason: "a",
      }),
    );
    await withSync(fake, (sync) =>
      sync.failed({
        issueId: "ENG-42",
        sessionId,
        step: "over-cap",
        reason: "b",
      }),
    );
    expect(fake.issue.comments).toHaveLength(2);
  });

  it("moves a merged PR's issue to Done", async () => {
    const fake = makeLinear({ start: REVIEW });
    await withSync(fake, (sync) =>
      sync.merged({ issueId: "ENG-42", sessionId, pr }),
    );
    expect(fake.issue.state).toEqual(DONE);
    expect(fake.issue.comments).toEqual([]);
  });

  it("fails, naming the team's states, when the map names one the team does not have", async () => {
    const fake = makeLinear({
      start: PROGRESS,
      states: [TODO, PROGRESS, DONE],
    });
    const exit = await withSync(fake, (sync) =>
      sync.pullRequestOpened({
        issueId: "ENG-42",
        sessionId,
        pr,
        evidence: [],
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
    expect(JSON.stringify(error)).toContain(
      'no workflow state named \\"In Review\\" (it has: Todo, In Progress, Done)',
    );
    // The link still landed: the state is the last write, and a retry finds the comment.
    expect(fake.issue.comments).toHaveLength(1);
  });

  it("a GraphQL refusal on HTTP 200 is a failure, and is not retried", async () => {
    const fake = makeLinear({ refuse: "issue" });
    const exit = await withSync(fake, (sync) =>
      sync.started({ issueId: "ENG-42", sessionId }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("Entity not found");
    expect(fake.seen).toHaveLength(1);
  });

  it("a mutation answered success: false is a failure", async () => {
    const fake = makeLinear({ unsuccessful: "issueUpdate" });
    const exit = await withSync(fake, (sync) =>
      sync.started({ issueId: "ENG-42", sessionId }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("success: false");
  });

  it("an issue the key cannot read is a failure that names it", async () => {
    const fake = makeLinear();
    const exit = await withSync(fake, (sync) =>
      sync.started({ issueId: "ENG-999", sessionId }),
    );
    expect(JSON.stringify(exit)).toContain("Linear has no issue ENG-999");
  });
});

describe("LinearTriggerWriteBack", () => {
  const event = (source: TriggerEvent["source"]): TriggerEvent => ({
    source,
    key: "ENG-42",
    action: "create",
    title: "t",
    body: "",
    labels: ["factory"],
  });
  const write = (
    fake: ReturnType<typeof makeLinear>,
    source: TriggerEvent["source"],
  ) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const port = yield* TriggerWriteBack;
        yield* port.write({ event: event(source), sessionId });
      }).pipe(
        Effect.provide(
          LinearTriggerWriteBack.pipe(
            Layer.provide(LinearIssueSyncLive(config)),
            Layer.provide(fake.layer),
          ),
        ),
      ),
    );

  it("moves a Linear delivery's issue to started, and leaves any other source alone", async () => {
    const fake = makeLinear();
    expect(Exit.isSuccess(await write(fake, "generic"))).toBe(true);
    expect(fake.seen).toEqual([]);
    expect(Exit.isSuccess(await write(fake, "linear"))).toBe(true);
    expect(fake.issue.state).toEqual(PROGRESS);
  });

  it("fails the delivery as a write-back when Linear refuses, so the claim is given back", async () => {
    const fake = makeLinear({ refuse: "issue" });
    const exit = await write(fake, "linear");
    expect(JSON.stringify(exit)).toContain('"code":"write-back"');
  });
});

describe("the session write-back and the PR lifecycle, on Postgres", () => {
  const runId = randomBytes(6).toString("hex");
  const runtime = ManagedRuntime.make(DatabaseLive);

  // The rows have no log behind them, so they leave with the suite rather than waiting for a
  // rebuild in another suite to find them.
  afterAll(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`DELETE FROM sessions WHERE id LIKE ${`ses_lws_%_${runId}`}`;
      }),
    );
    await runtime.dispose();
  });

  const seedSession = (id: string, requestId: string | null, prUrl: string) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`
          INSERT INTO sessions (id, title, request_id, pr_url)
          VALUES (${id}, 'linear write-back case', ${requestId}, ${prUrl})
        `;
      }),
    );

  /** Run against the fake Linear and the real database, with both write-backs wired. */
  const run = <A, E>(
    fake: ReturnType<typeof makeLinear>,
    body: Effect.Effect<A, E, LinearIssueSync | SqlClient>,
  ) =>
    runtime.runPromiseExit(
      body.pipe(
        Effect.provide(
          LinearIssueSyncLive(config).pipe(Layer.provide(fake.layer)),
        ),
      ),
    );

  /** The issue a case's session was delegated from: one per session, like the real binding. */
  const key = (id: string): string => `ENG-${id}`;

  const report = (id: string, result: PullRequestStepExit) =>
    Effect.gen(function* () {
      const writeBack = yield* SessionWriteBack;
      yield* writeBack.pullRequest({
        sessionId: id as SessionId,
        result,
        evidence: Effect.succeed([ran(0)]),
      });
    }).pipe(Effect.provide(LinearSessionWriteBack));

  it("mirrors a delegated session's PR on its issue, and only once across retries", async () => {
    const id = `ses_lws_pr_${runId}`;
    await seedSession(
      id,
      `trigger:linear:${key(id)}:mapped`,
      `${pr.url}-${runId}`,
    );
    const fake = makeLinear({ identifier: key(id), start: PROGRESS });
    const opened = Exit.succeed({ ...pr, outcome: "opened" as const });
    await run(fake, report(id, opened));
    await run(
      fake,
      report(id, Exit.succeed({ ...pr, outcome: "already-open" as const })),
    );
    expect(fake.issue.state).toEqual(REVIEW);
    expect(fake.issue.comments).toHaveLength(1);
    expect(fake.issue.comments[0]).toContain("`api` passed (exit 0)");
  });

  it("explains a failed PR step on the issue", async () => {
    const id = `ses_lws_fail_${runId}`;
    await seedSession(
      id,
      `trigger:linear:${key(id)}:mapped`,
      `${pr.url}-f-${runId}`,
    );
    const fake = makeLinear({ identifier: key(id), start: PROGRESS });
    await run(
      fake,
      report(
        id,
        Exit.fail(new SessionError({ code: "storage", message: "disk full" })),
      ),
    );
    expect(fake.issue.comments).toHaveLength(1);
    expect(fake.issue.comments[0]).toContain(
      "the pull request step failed (SessionError): disk full",
    );
  });

  it("reports nothing for a session no Linear issue opened", async () => {
    const id = `ses_lws_none_${runId}`;
    await seedSession(id, `client-${runId}`, `${pr.url}-n-${runId}`);
    const fake = makeLinear({ identifier: key(id), start: PROGRESS });
    await run(fake, report(id, Exit.succeed({ ...pr, outcome: "opened" })));
    expect(fake.seen).toEqual([]);
  });

  it("a Linear failure does not fail the report: it is logged, and the PR step's answer stands", async () => {
    const id = `ses_lws_refused_${runId}`;
    await seedSession(
      id,
      `trigger:linear:${key(id)}:mapped`,
      `${pr.url}-r-${runId}`,
    );
    const fake = makeLinear({ identifier: key(id), refuse: "issue" });
    const exit = await run(
      fake,
      report(id, Exit.succeed({ ...pr, outcome: "opened" })),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.seen).toHaveLength(1);
  });

  it("a merge moves the PR's issue to Done, an unmerged close explains itself, a new commit does nothing", async () => {
    const url = `${pr.url}-m-${runId}`;
    const id = `ses_lws_merge_${runId}`;
    await seedSession(id, `trigger:linear:${key(id)}:mapped`, url);
    const link = { number: 7, url };

    const pushed = makeLinear({ identifier: key(id), start: REVIEW });
    const none = await run(
      pushed,
      syncPullRequestLifecycle({ _tag: "other", action: "synchronize" }),
    );
    expect(Exit.isSuccess(none) ? none.value : -1).toBe(0);
    expect(pushed.seen).toEqual([]);

    const merged = makeLinear({ identifier: key(id), start: REVIEW });
    const count = await run(
      merged,
      syncPullRequestLifecycle({ _tag: "merged", pr: link }),
    );
    expect(Exit.isSuccess(count) ? count.value : -1).toBe(1);
    expect(merged.issue.state).toEqual(DONE);

    const closed = makeLinear({ identifier: key(id), start: REVIEW });
    await run(closed, syncPullRequestLifecycle({ _tag: "closed", pr: link }));
    expect(closed.issue.state).toEqual(REVIEW);
    expect(closed.issue.comments[0]).toContain(
      "pull request #7 was closed without being merged",
    );
  });

  it("a PR the factory did not open touches no issue", async () => {
    const fake = makeLinear({ start: REVIEW });
    const exit = await run(
      fake,
      syncPullRequestLifecycle({
        _tag: "merged",
        pr: { number: 1, url: `https://github.com/acme/other/pull/${runId}` },
      }),
    );
    expect(Exit.isSuccess(exit) ? exit.value : -1).toBe(0);
    expect(fake.seen).toEqual([]);
  });
});
