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
import { createHmac, randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { HttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import { SessionError } from "@repo/domain/Session";
import {
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  type TaskId,
} from "@repo/domain/Task";
import {
  externalRefOf,
  type TriggerEvent,
  type TriggerRule,
} from "@repo/domain/Trigger";
import type { VerifyRecord } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  linearDelivery,
  linearIssueOfDelivery,
  linearIssueOfExternalRef,
} from "./Linear";
import {
  DEFAULT_LINEAR_STATES,
  githubPullRequestLifecycle,
  handleGitHubPullRequestWebhook,
  type LinearConfig,
  linearConfigFromEnv,
  linearEvidenceLines,
  linearFailureKind,
  LinearIssueSync,
  LinearIssueSyncLive,
  type LinearIssueSyncShape,
  LinearSessionWriteBack,
  LinearTriggerWriteBack,
  type LinearWorkflowState,
  nextLinearState,
  syncPullRequestLifecycle,
  verifyGitHubSignature,
} from "./LinearSync";
import {
  CANCELED,
  DONE,
  makeLinear,
  PROGRESS,
  REVIEW,
  state,
  TEAM,
  TODO,
} from "./linearFake";
import { mintSessionId } from "./ids";
import { PrError } from "./pr";
import { proposalIssueBody, proposalMarker } from "./ProposalTracker";
import {
  pullRequestReport,
  SessionWriteBack,
  type PullRequestStepExit,
} from "./SessionWriteBack";
import { TaskService, TaskServiceLive } from "./TaskService";
import {
  deliveryIdOfSession,
  NoCards,
  sessionRequestIdOf,
  TriggerService,
  TriggerServiceLive,
  TriggerSessions,
  TriggerWriteBack,
} from "./TriggerService";

const sessionId = "ses_01j8z000000000000000000000" as SessionId;

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
  it("round-trips from a Linear event to a card's external ref and back (LOB-254)", () => {
    const ref = externalRefOf({ source: "linear", key: "iss-uuid-1" });
    expect(ref).toBe("linear:iss-uuid-1");
    expect(linearIssueOfExternalRef(ref)).toBe("iss-uuid-1");
    // Any other source's ref, a bare key, the bare prefix and no ref name no Linear issue.
    for (const other of ["jira:ENG-1", "LOB-42", "linear:", null, undefined]) {
      expect(linearIssueOfExternalRef(other)).toBeUndefined();
    }
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

  it("names the PR by its page, and keeps GitHub's API resource beside it", () => {
    // GitHub's real payload: `url` is the API resource, `html_url` the page. The page is the PR's
    // link (what the step records); the resource is kept only to match a session recorded before.
    const api = "https://api.github.com/repos/acme/widgets/pulls/7";
    expect(
      githubPullRequestLifecycle({
        action: "closed",
        pull_request: { number: 7, url: api, html_url: pr.url, merged: true },
      }),
    ).toEqual({ _tag: "merged", pr, apiUrl: api });
  });
});

const withSync = <A, E>(
  fake: ReturnType<typeof makeLinear>,
  body: (sync: LinearIssueSyncShape) => Effect.Effect<A, E>,
  over: Partial<LinearConfig> = {},
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const sync = yield* LinearIssueSync;
      return yield* body(sync);
    }).pipe(
      Effect.provide(
        LinearIssueSyncLive({ ...config, ...over }).pipe(
          Layer.provide(fake.layer),
        ),
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
      `factory:${sessionId}:${linearFailureKind("no-change", "the run changed no file against its base branch")}`,
    );
    // The task is neither done nor in review: a failure moves no state.
    expect(fake.issue.state).toEqual(PROGRESS);
    expect(fake.writes("issueUpdate")).toEqual([]);
  });

  it("a different failure of the same step still explains itself; the same one again does not", async () => {
    const fake = makeLinear({ start: PROGRESS });
    const fail = (reason: string) =>
      withSync(fake, (sync) =>
        sync.failed({ issueId: "ENG-42", sessionId, step: "pr-error", reason }),
      );
    await fail("the pull request step failed (PrError): GitHub answered 403");
    await fail("the pull request step failed (PrError): GitHub answered 422");
    await fail("the pull request step failed (PrError): GitHub answered 422");
    expect(fake.issue.comments).toHaveLength(2);
    expect(fake.issue.comments[1]).toContain("GitHub answered 422");
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

  it("Linear's rate limit (HTTP 400, RATELIMITED) is transient: retried, and the write lands", async () => {
    const fake = makeLinear({ rateLimit: { operation: "issue", times: 1 } });
    const exit = await withSync(fake, (sync) =>
      sync.started({ issueId: "ENG-42", sessionId }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.seen.filter((s) => s.operation === "issue")).toHaveLength(2);
    expect(fake.issue.state).toEqual(PROGRESS);
  });

  it("a rate limit that outlasts the retries says so", async () => {
    const fake = makeLinear({ rateLimit: { operation: "issue", times: 9 } });
    const exit = await withSync(fake, (sync) =>
      sync.started({ issueId: "ENG-42", sessionId }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("RATELIMITED");
    // Two retries, then the answer.
    expect(fake.seen).toHaveLength(3);
  });

  it("a request Linear never answers times out as transient, and the retry lands", async () => {
    const fake = makeLinear({ hang: { operation: "issueUpdate", times: 1 } });
    const exit = await withSync(
      fake,
      (sync) => sync.started({ issueId: "ENG-42", sessionId }),
      { requestTimeout: "50 millis" },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.issue.state).toEqual(PROGRESS);
  });

  it("a Linear that never answers fails within its bound rather than stalling the caller", async () => {
    const fake = makeLinear({ hang: { operation: "issue", times: Infinity } });
    const exit = await withSync(
      fake,
      (sync) => sync.started({ issueId: "ENG-42", sessionId }),
      { requestTimeout: "50 millis" },
    );
    // Three attempts of 50ms each, then the answer — the case's own timeout is the stall check.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("did not answer issue within 50ms");
    expect(fake.seen).toHaveLength(3);
  }, 5_000);

  it("one issue's stalled write does not hold up another issue's", async () => {
    const fake = makeLinear({ hang: { operation: "issue", times: Infinity } });
    const other = makeLinear({ identifier: "ENG-43" });
    // One Linear, two issues: a request is the stalled issue's unless it names the other one.
    const both = HttpClient.make((request) =>
      (request.body._tag === "Uint8Array" &&
      new TextDecoder().decode(request.body.body).includes("ENG-43")
        ? other.client
        : fake.client
      ).execute(request),
    );
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sync = yield* LinearIssueSync;
        // The stalled issue is in flight, holding its own lock, when the other one writes.
        yield* Effect.forkChild(sync.started({ issueId: "ENG-42", sessionId }));
        yield* Effect.sleep("20 millis");
        return yield* sync.started({ issueId: "ENG-43", sessionId });
      }).pipe(
        Effect.provide(
          LinearIssueSyncLive({ ...config, requestTimeout: "30 seconds" }).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, both)),
          ),
        ),
        Effect.timeout("2 seconds"),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(other.issue.state).toEqual(PROGRESS);
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

describe("child issues under a delegating issue (LOB-202)", () => {
  const child = {
    issueId: "ENG-42",
    marker: proposalMarker(sessionId, "Schema"),
    title: "Schema",
    description: `the body\n\n\`${proposalMarker(sessionId, "Schema")}\``,
  };

  it("creates a child in the parent's team, addressed by the parent's id rather than its identifier", async () => {
    const fake = makeLinear();
    const exit = await withSync(fake, (sync) => sync.createChild(child));
    expect(exit).toEqual(
      Exit.succeed({ id: "iss-child-1", identifier: "ENG-101" }),
    );
    expect(fake.writes()).toEqual([
      {
        operation: "issueCreate",
        variables: {
          input: {
            teamId: fake.teamId,
            parentId: "iss-uuid-1",
            title: "Schema",
            description: child.description,
          },
        },
        authorization: "lin_api_test",
      },
    ]);
  });

  it("answers the child whose description carries the marker instead of creating another", async () => {
    const fake = makeLinear();
    const first = await withSync(fake, (sync) => sync.createChild(child));
    const again = await withSync(fake, (sync) => sync.createChild(child));
    expect(again).toEqual(first);
    expect(fake.writes("issueCreate")).toHaveLength(1);
    // Another proposal of the same session is another marker, so it is created.
    const other = await withSync(fake, (sync) =>
      sync.createChild({
        ...child,
        title: "Service",
        marker: proposalMarker(sessionId, "Service"),
        description: "the other body",
      }),
    );
    expect(Exit.isSuccess(other)).toBe(true);
    expect(fake.children).toHaveLength(2);
  });

  it("retries a rate-limited create and creates once", async () => {
    const fake = makeLinear({
      rateLimit: { operation: "issueCreate", times: 1 },
    });
    const exit = await withSync(fake, (sync) => sync.createChild(child));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.children).toHaveLength(1);
  });

  it("fails a refused or unsuccessful create as a non-transient LinearSyncError, once", async () => {
    for (const options of [
      { refuse: "issueCreate" },
      { unsuccessful: "issueCreate" },
    ]) {
      const fake = makeLinear(options);
      const exit = await withSync(fake, (sync) => sync.createChild(child));
      expect(Exit.isFailure(exit)).toBe(true);
      const error = Option.getOrThrow(Exit.findErrorOption(exit));
      expect(error).toMatchObject({
        _tag: "LinearSyncError",
        operation: "issueCreate",
        transient: false,
      });
      // A refusal is not retried: one request, no child.
      expect(fake.writes("issueCreate")).toHaveLength(1);
      expect(fake.children).toHaveLength(0);
    }
  });

  it("fails an issue Linear shows this key as a LinearSyncError and writes nothing", async () => {
    const fake = makeLinear();
    const exit = await withSync(fake, (sync) =>
      sync.createChild({ ...child, issueId: "ENG-404" }),
    );
    expect(Option.getOrThrow(Exit.findErrorOption(exit))).toMatchObject({
      operation: "issueChildren",
    });
    expect(fake.writes()).toEqual([]);
  });

  /** Two children the fake made, so the ids a relation names are issues it knows. */
  const twoChildren = async (fake: ReturnType<typeof makeLinear>) => {
    for (const title of ["Schema", "Service"]) {
      await withSync(fake, (sync) =>
        sync.createChild({
          ...child,
          title,
          marker: proposalMarker(sessionId, title),
          description: title,
        }),
      );
    }
    const [blocker, blocked] = fake.children;
    if (blocker === undefined || blocked === undefined) {
      throw new Error("the fake made no children");
    }
    return { blocker, blocked };
  };

  it("relates a blocker to the issue it blocks once, and finds the edge on every later ask", async () => {
    const fake = makeLinear();
    const { blocker, blocked } = await twoChildren(fake);
    const creates = fake.writes().length;
    const first = await withSync(fake, (sync) =>
      sync.blocks({ blocker, blocked }),
    );
    const second = await withSync(fake, (sync) =>
      sync.blocks({ blocker, blocked }),
    );
    expect(first).toEqual(Exit.succeed({ created: true }));
    expect(second).toEqual(Exit.succeed({ created: false }));
    expect(fake.writes().slice(creates)).toEqual([
      {
        operation: "issueRelationCreate",
        variables: {
          input: {
            issueId: blocker.id,
            relatedIssueId: blocked.id,
            type: "blocks",
          },
        },
        authorization: "lin_api_test",
      },
    ]);
    // The reverse is another edge, not the one already there.
    const reverse = await withSync(fake, (sync) =>
      sync.blocks({ blocker: blocked, blocked: blocker }),
    );
    expect(reverse).toEqual(Exit.succeed({ created: true }));
  });

  it("does not take a lost acknowledgement for a missing edge", async () => {
    const fake = makeLinear({ loseAckOnce: "issueRelationCreate" });
    const { blocker, blocked } = await twoChildren(fake);
    const exit = await withSync(fake, (sync) =>
      sync.blocks({ blocker, blocked }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.relations).toHaveLength(1);
  });
});

describe("the proposal marker and body (LOB-202)", () => {
  it("names a proposal by its session and its title, not by its position", () => {
    const marker = proposalMarker(sessionId, "Add the schema");
    expect(marker).toMatch(/^factory:ses_[0-9a-z]{26}:proposal:[0-9a-f]{12}$/);
    // The validator's own notion of the same title.
    expect(proposalMarker(sessionId, "  add   THE schema ")).toBe(marker);
    expect(proposalMarker(sessionId, "Add the service")).not.toBe(marker);
    expect(
      proposalMarker(
        "ses_01j8z000000000000000000001" as SessionId,
        "Add the schema",
      ),
    ).not.toBe(marker);
  });

  it("writes the goal, the change and the acceptance lines as a checklist", () => {
    expect(
      proposalIssueBody({
        title: "T",
        goal: "the goal",
        change: "the change",
        acceptance: ["one", "two"],
        blockedBy: [],
      }),
    ).toBe(
      "the goal\n\n**Change**\n\nthe change\n\n**Acceptance**\n\n- [ ] one\n- [ ] two",
    );
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

  it("does not fail the delivery when Linear refuses: the move is a mirror, and it is logged", async () => {
    const fake = makeLinear({ refuse: "issue" });
    const exit = await write(fake, "linear");
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.seen).toHaveLength(1);
  });
});

describe("the session write-back and the PR lifecycle, on Postgres", () => {
  const runId = randomBytes(6).toString("hex");
  const runtime = ManagedRuntime.make(DatabaseLive);

  /** The trigger case's repo and delivery: `TriggerService` writes both, so the suite removes them. */
  const triggerSlug = `acme/linear-trigger-${runId}`;
  const triggerDelivery = `linear:TRG-${runId}:mapped`;

  // The rows have no log behind them, so they leave with the suite rather than waiting for a
  // rebuild in another suite to find them.
  afterAll(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`DELETE FROM sessions WHERE id LIKE ${`ses_lws_%_${runId}`}`;
        yield* sql`DELETE FROM webhook_deliveries WHERE request_id = ${triggerDelivery}`;
        yield* sql`DELETE FROM repos WHERE slug = ${triggerSlug}`;
        // A card case's session is a canonical id (its run joins a real card), so it is named.
        for (const id of cardSessions) {
          yield* sql`DELETE FROM task_runs WHERE session_id = ${id}`;
          yield* sql`DELETE FROM sessions WHERE id = ${id}`;
        }
      }),
    );
    await runtime.dispose();
  });

  /** Every session a case seeded: `run` puts them back before each body reads them. */
  const seeded = new Map<
    string,
    { readonly requestId: string | null; readonly prUrl: string }
  >();

  /**
   * A session row for a case. It has no log behind it, so another suite's rebuild test — which
   * empties `sessions` and refills it from its own logs — can delete it at any moment; `run` upserts
   * every seeded row in the transaction the body runs in, which holds them until the body is done.
   */
  const seedSession = (id: string, requestId: string | null, prUrl: string) => {
    seeded.set(id, { requestId, prUrl });
    return Promise.resolve();
  };

  /** The run → card links `run` upserts, by session id (LOB-254). */
  const cards = new Map<string, TaskId>();
  const cardSessions: Array<SessionId> = [];

  /**
   * A session that is a run of a card filed under `externalRef` (LOB-254). The board and the card are
   * made by the real `TaskService`, so their ids are canonical, their `created` events are logged and
   * the repo is registered — rows any other suite's `listBoards` or rebuild reads as it reads its own.
   * The session id is minted for the same reason: the run row's id is the session's, and a card's
   * runs are decoded by whoever reads the card. The `task_runs` row has no log behind it, so `run`
   * upserts it beside the session, for the reason `seedSession` gives.
   */
  const seedCardRun = async (
    name: string,
    externalRef: string,
    requestId: string | null,
    prUrl: string,
  ): Promise<SessionId> => {
    const slug = `acme/lws-card-${name}-${runId}` as RepoSlug;
    const taskId = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO repos (slug) VALUES (${slug}) ON CONFLICT (slug) DO NOTHING`;
        const tasks = yield* TaskService;
        const board = yield* tasks.createBoard({
          repo: slug,
          definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        });
        const filed = yield* tasks.file({
          boardId: board.id,
          title: "a card filed from a tracker",
          externalRef,
          actor: "trigger:linear",
        });
        return filed.task.id;
      }).pipe(
        Effect.provide(
          TaskServiceLive.pipe(
            Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
          ),
        ),
      ),
    );
    const id = await runtime.runPromise(mintSessionId);
    cards.set(id, taskId);
    cardSessions.push(id);
    await seedSession(id, requestId, prUrl);
    return id;
  };

  /** Run against the fake Linear and the real database, with both write-backs wired. */
  const run = <A, E>(
    fake: ReturnType<typeof makeLinear>,
    body: Effect.Effect<A, E, LinearIssueSync | SqlClient>,
  ) =>
    runtime.runPromiseExit(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            // `DO UPDATE` rather than `DO NOTHING`: it locks a row that already exists, so a
            // concurrent `DELETE FROM sessions` waits for this transaction instead of removing the
            // row between this read and the body's.
            for (const [id, row] of seeded) {
              yield* sql`
                INSERT INTO sessions (id, title, request_id, pr_url)
                VALUES (${id}, 'linear write-back case', ${row.requestId}, ${row.prUrl})
                ON CONFLICT (id) DO UPDATE SET pr_url = EXCLUDED.pr_url
              `;
            }
            for (const [id, task] of cards) {
              yield* sql`
                INSERT INTO task_runs (id, task_id, session_id, "column")
                VALUES (${id}, ${task}, ${id}, 'building')
                ON CONFLICT (session_id) DO NOTHING
              `;
            }
            return yield* body;
          }),
        );
      }).pipe(
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

  it("follows a card's run to the issue the card was filed from (LOB-254)", async () => {
    // The run's own request id names no issue: a card-mode delivery opened no session, so the card's
    // external ref is the only binding. A mutation that drops the card join reports nothing here.
    const issue = `ENG-card-${runId}`;
    const id = await seedCardRun(
      "linear",
      `linear:${issue}`,
      `client-card-${runId}`,
      `${pr.url}-c-${runId}`,
    );
    const fake = makeLinear({ identifier: issue, start: TODO });
    await run(fake, report(id, Exit.succeed({ ...pr, outcome: "opened" })));
    await run(
      fake,
      report(id, Exit.succeed({ ...pr, outcome: "already-open" as const })),
    );
    expect(fake.issue.state).toEqual(REVIEW);
    expect(fake.issue.comments).toHaveLength(1);
    expect(fake.issue.comments[0]).toContain(`factory:${id}:pr`);

    const merged = makeLinear({ identifier: issue, start: REVIEW });
    const count = await run(
      merged,
      syncPullRequestLifecycle({
        _tag: "merged",
        pr: { number: 7, url: `${pr.url}-c-${runId}` },
      }),
    );
    expect(Exit.isSuccess(count) ? count.value : -1).toBe(1);
    expect(merged.issue.state).toEqual(DONE);
  });

  it("a card filed from anything but Linear reports nothing", async () => {
    const issue = `ENG-jira-${runId}`;
    const id = await seedCardRun(
      "jira",
      `jira:${issue}`,
      `client-jira-${runId}`,
      `${pr.url}-j-${runId}`,
    );
    const fake = makeLinear({ identifier: issue, start: TODO });
    await run(fake, report(id, Exit.succeed({ ...pr, outcome: "opened" })));
    expect(fake.seen).toEqual([]);
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
  it("a refused started move does not make Linear's redelivery prompt the session again", async () => {
    // The seam, on the real delivery store, with a counting session layer and Linear refusing every
    // read: before the move was best effort, the refusal failed the delivery, gave its claim back,
    // and every redelivery sent the rule's prompt to the same session once more.
    const slug = triggerSlug as RepoSlug;
    const rules: ReadonlyArray<TriggerRule> = [
      { label: "factory", repo: slug, prompt: "{{key}}: {{title}}" },
    ];
    const sent: string[] = [];
    const created: SessionId[] = [];
    const fake = makeLinear({ identifier: `TRG-${runId}`, refuse: "issue" });
    const seam = ManagedRuntime.make(
      TriggerServiceLive({ rules }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              TriggerSessions,
              TriggerSessions.of({
                create: () =>
                  Effect.sync(() => {
                    // The real layer dedupes on the request id; one session is all a retry can get.
                    if (created.length === 0) {
                      created.push(`ses_${"1".padStart(26, "0")}` as SessionId);
                    }
                    return { id: created[0] as SessionId };
                  }),
                send: (input) =>
                  Effect.sync(() => {
                    sent.push(input.content);
                  }),
              }),
            ),
            LinearTriggerWriteBack.pipe(
              Layer.provide(LinearIssueSyncLive(config)),
              Layer.provide(fake.layer),
            ),
            NoCards,
          ),
        ),
        Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      ),
    );
    try {
      const delivered = await seam.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`INSERT INTO repos (slug) VALUES (${slug}) ON CONFLICT (slug) DO NOTHING`;
          const trigger = yield* TriggerService;
          const delivery = {
            requestId: triggerDelivery,
            event: {
              source: "linear",
              key: `TRG-${runId}`,
              action: "create",
              title: "Close the loop",
              body: "",
              labels: ["factory"],
            },
          } as const;
          const first = yield* trigger.deliver(delivery);
          const again = yield* trigger.deliver(delivery);
          return { first, again };
        }),
      );
      expect(delivered.first).toMatchObject({
        status: "processed",
        replayed: false,
      });
      expect(delivered.again.replayed).toBe(true);
      expect(sent).toEqual([`TRG-${runId}: Close the loop`]);
      // The move was tried once, refused, and not retried by a redelivery.
      expect(fake.seen).toHaveLength(1);
    } finally {
      await seam.dispose();
    }
  });

  describe("POST /webhooks/github (handleGitHubPullRequestWebhook)", () => {
    const secret = "gh-webhook-secret";
    const sign = (raw: string, key = secret) =>
      `sha256=${createHmac("sha256", key).update(raw).digest("hex")}`;
    const body = (action: string, merged: boolean, url: string) =>
      JSON.stringify({
        action,
        pull_request: { number: 7, html_url: url, merged },
      });
    const hook = (
      fake: ReturnType<typeof makeLinear>,
      input: Partial<Parameters<typeof handleGitHubPullRequestWebhook>[0]> & {
        readonly raw: string;
      },
    ) =>
      run(
        fake,
        handleGitHubPullRequestWebhook({
          secret,
          signature: sign(input.raw),
          event: "pull_request",
          ...input,
        }),
      ).then((exit) => (Exit.isSuccess(exit) ? exit.value : undefined));

    it("verifies GitHub's X-Hub-Signature-256", () => {
      const raw = body("closed", true, pr.url);
      expect(verifyGitHubSignature(raw, sign(raw), secret)).toBe(true);
      expect(verifyGitHubSignature(raw, sign(raw, "other"), secret)).toBe(
        false,
      );
      expect(
        verifyGitHubSignature(raw, sign(raw).replace("sha256=", ""), secret),
      ).toBe(false);
      expect(verifyGitHubSignature(raw, undefined, secret)).toBe(false);
      expect(verifyGitHubSignature(raw, "sha256=zz", secret)).toBe(false);
    });

    it("refuses with no secret, a bad signature, and a body with no PR; ignores other events", async () => {
      const fake = makeLinear({ start: REVIEW });
      const raw = body("closed", true, pr.url);
      expect((await hook(fake, { raw, secret: undefined }))?.status).toBe(503);
      expect(
        (await hook(fake, { raw, signature: sign(raw, "wrong") }))?.status,
      ).toBe(401);
      expect((await hook(fake, { raw, event: "ping" }))?.status).toBe(202);
      expect((await hook(fake, { raw: "{}" }))?.status).toBe(400);
      expect((await hook(fake, { raw: "not json" }))?.status).toBe(400);
      expect(fake.seen).toEqual([]);
    });

    it("a merged PR's event moves its issue to Done; a new commit's writes nothing", async () => {
      const url = `${pr.url}-gh-${runId}`;
      const id = `ses_lws_gh_${runId}`;
      await seedSession(id, `trigger:linear:${key(id)}:mapped`, url);
      const fake = makeLinear({ identifier: key(id), start: REVIEW });

      const pushed = await hook(fake, { raw: body("synchronize", false, url) });
      expect(pushed).toEqual({
        status: 200,
        body: { ok: true, event: "synchronize", synced: 0 },
      });
      expect(fake.seen).toEqual([]);

      const merged = await hook(fake, { raw: body("closed", true, url) });
      expect(merged).toEqual({
        status: 200,
        body: { ok: true, event: "merged", synced: 1 },
      });
      expect(fake.issue.state).toEqual(DONE);
    });

    it.each([
      ["the page (`html_url`), as the step records it", "page"],
      [
        "the API resource (`url`), as a session recorded before LOB-15 holds it",
        "api",
      ],
    ] as const)(
      "matches GitHub's real payload, where `url` and `html_url` differ: a session recording %s",
      async (_, recorded) => {
        const page = `${pr.url}-real-${recorded}-${runId}`;
        const api = `https://api.github.com/repos/acme/widgets/pulls/7-real-${recorded}-${runId}`;
        const id = `ses_lws_gh${recorded}_${runId}`;
        await seedSession(
          id,
          `trigger:linear:${key(id)}:mapped`,
          recorded === "page" ? page : api,
        );
        const fake = makeLinear({ identifier: key(id), start: REVIEW });
        const raw = JSON.stringify({
          action: "closed",
          pull_request: { number: 7, url: api, html_url: page, merged: true },
        });
        expect(await hook(fake, { raw })).toEqual({
          status: 200,
          body: { ok: true, event: "merged", synced: 1 },
        });
        expect(fake.issue.state).toEqual(DONE);
      },
    );

    it("a sync Linear refuses is a 500 the delivery log shows", async () => {
      const url = `${pr.url}-gh500-${runId}`;
      const id = `ses_lws_gh500_${runId}`;
      await seedSession(id, `trigger:linear:${key(id)}:mapped`, url);
      const fake = makeLinear({ identifier: key(id), refuse: "issue" });
      const answer = await hook(fake, { raw: body("closed", true, url) });
      expect(answer?.status).toBe(500);
      expect(answer?.body).toMatchObject({ ok: false, code: "write-back" });
    });
  });
});
