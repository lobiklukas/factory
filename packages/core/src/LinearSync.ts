/**
 * Session → Linear (LOB-15): the issue a session was delegated from learns what the session did.
 *
 * LOB-164 made a labelled Linear issue open a session; nothing went back, so the issue sat in
 * whatever state a person left it while a PR opened somewhere else. This module is the outbound
 * half, and it is deliberately small (docs/board.md B11: "a small, declarative map", outbound-only,
 * idempotent, the tracker owns issue text and the factory owns lifecycle):
 *
 * - **On session start** the issue moves to the configured *started* state (`In Progress`).
 * - **When the PR opens** the PR is attached to the issue, one comment carries its link and the
 *   session's verification evidence, and the issue moves to *in review* (`In Review`).
 * - **When a run fails** — the PR step refused (a diff over the cap, a branch with no change) or
 *   errored — one comment says why. The state does not move: the task is not done and not in
 *   review, and a comment is how "never silently" reaches someone watching the issue.
 * - **When the PR merges** the issue moves to *done*. A PR closed without merging is a failure
 *   comment, like any other run that ended without a change landing. GitHub says which happened
 *   through a signed `pull_request` webhook (`handleGitHubPullRequestWebhook`, served at
 *   `POST /webhooks/github` by `apps/api`).
 *
 * **The issue's state is the task's, never the review's.** Mastra Factory keeps a PR's review as
 * its own item with its own completion rules, and LOB-15 keeps that separation: there is no
 * "approved" or "changes requested" state in the map, nothing here records a review verdict on the
 * issue, and a new commit on the PR (`synchronize`) changes nothing on it — so there is no stale
 * approval on the issue for a new commit to leave behind. The merge is the one PR event that moves
 * the issue, because the merge is the task's completion gate (B4: `review → done` is "a human
 * merge"), not a review verdict.
 *
 * **What this does not do: re-review.** The other half of that separation — a review recorded as
 * its own item, invalidated by a new commit so a stale approval forces a re-review — needs a review
 * record, and the factory keeps none yet (the review itself is GitHub's, D16). It is not built here;
 * it belongs with the review item (LOB-36, whose acceptance already says a `synchronize` event
 * invalidates the previous verdict and a stale approval never survives a push). LOB-15's review
 * criterion is therefore **partially met**: the issue's state is the task's and no review verdict
 * reaches it; re-review on a new commit is LOB-36's.
 *
 * **Every write is idempotent, so a retry is always safe.** That is what makes "no duplicate
 * comments on retry" a property rather than a hope, and it is the same rule Jira, GitHub and Slack
 * follow (`Jira.ts`): each operation reads the issue first — its state, its team's states, its
 * comments and its attachments — and writes only what is missing.
 *
 * - A comment carries a marker line, `factory:<session id>:<kind>`, and is posted only when no
 *   comment on the issue carries it. One kind per event (`pr`, `failed:<step>`), so a retried PR
 *   step posts nothing, a second distinct failure still explains itself, and a PR opened after a
 *   failed attempt still gets its link.
 * - The PR attachment is created only when no attachment has its URL.
 * - A state moves **forward only**, along the map's order (started → in review → done), and never
 *   out of a state Linear calls `completed` or `canceled`: a retried `started` after the PR opened
 *   does not drag the issue back to In Progress, and an issue a person closed is not reopened by a
 *   mirror. `nextLinearState` is that rule, pure.
 *
 * Operations on one issue are serialized within one `LinearIssueSyncLive` (one permit per issue),
 * so two reports for one issue cannot both read "no comment yet"; `apps/api` builds that layer once
 * and hands it to every consumer. Across processes the read and the write are not atomic — the
 * window is two reports landing in the same instant, which `docs/testing-third-parties.md` records.
 *
 * **Every request is bounded** (`requestTimeout`), because both callers wait on it: the PR step
 * reports before it answers, and the trigger seam moves the issue before it answers Linear's
 * webhook. A Linear that never answers is a transient failure after a few seconds, not a stall.
 *
 * **Auth is a Linear API key**, sent verbatim as `Authorization` — Linear's documented form for a
 * personal key; an OAuth token is sent as `Bearer <token>`, so a deployment holding one sets the
 * variable to that. No key configured means no write-back (`linearConfigFromEnv` answers
 * `undefined`), exactly as an unconfigured Jira or Slack adapter: "no tracker" is a state the
 * process can be in.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import type { SessionId } from "@repo/domain/Session";
import type { VerifyRecord } from "@repo/harness";
import { linearIssueOfDelivery } from "./Linear";
import { pullRequestReport, SessionWriteBack } from "./SessionWriteBack";
import { deliveryIdOfSession, TriggerWriteBack } from "./TriggerService";

/** Linear's GraphQL endpoint. */
export const LINEAR_API_URL = "https://api.linear.app/graphql";

/** The three lifecycle phases the map names, in the only order an issue moves through them. */
export const LINEAR_PHASES = ["started", "inReview", "done"] as const;
export type LinearPhase = (typeof LINEAR_PHASES)[number];

/** A phase → the name of the workflow state it means in the issue's team. */
export type LinearStates = { readonly [Phase in LinearPhase]: string };

/** Linear's own default workflow names; a team that renamed them configures its names. */
export const DEFAULT_LINEAR_STATES: LinearStates = {
  started: "In Progress",
  inReview: "In Review",
  done: "Done",
};

export type LinearConfig = {
  /** The GraphQL endpoint; `LINEAR_API_URL` unless a drive points it at a fake. */
  readonly apiUrl: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly states: LinearStates;
  /** Where a reader finds a session, so the comment links it. Absent: the id alone. */
  readonly sessionUrlBase?: string;
  /**
   * How long one GraphQL request may take before it counts as a transient failure
   * (`LINEAR_REQUEST_TIMEOUT`, 5 seconds; a test shortens it). Without it a Linear that accepts the connection and
   * never answers would hold the caller for as long as `fetch` waits, which is forever.
   */
  readonly requestTimeout?: Duration.Input;
};

/** The default bound on one Linear request. */
export const LINEAR_REQUEST_TIMEOUT: Duration.Input = "5 seconds";

/** The environment a deployment configures the write-back with. */
export type LinearEnv = {
  readonly apiUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly stateStarted: string | undefined;
  readonly stateInReview: string | undefined;
  readonly stateDone: string | undefined;
  readonly sessionUrlBase: string | undefined;
};

/**
 * A config from environment-shaped values, or `undefined` when the deployment set no key. A state
 * name left unset is Linear's default name; a blank one is too, because a blank state name could
 * never match and would only fail every write later.
 */
export const linearConfigFromEnv = (
  env: LinearEnv,
): LinearConfig | undefined => {
  const apiKey = env.apiKey?.trim();
  if (!apiKey) return undefined;
  const name = (value: string | undefined, fallback: string): string => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : fallback;
  };
  const sessionUrlBase = env.sessionUrlBase?.trim();
  return {
    apiUrl: name(env.apiUrl, LINEAR_API_URL),
    apiKey: Redacted.make(apiKey),
    states: {
      started: name(env.stateStarted, DEFAULT_LINEAR_STATES.started),
      inReview: name(env.stateInReview, DEFAULT_LINEAR_STATES.inReview),
      done: name(env.stateDone, DEFAULT_LINEAR_STATES.done),
    },
    ...(sessionUrlBase ? { sessionUrlBase } : {}),
  };
};

/** A Linear write could not be made. `transient` is what the retry reads. */
export class LinearSyncError extends Schema.TaggedError<LinearSyncError>()(
  "LinearSyncError",
  {
    issueId: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    transient: Schema.Boolean,
  },
) {}

/** One workflow state, as Linear's `WorkflowState` spells it. */
export const LinearWorkflowState = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** `triage | backlog | unstarted | started | completed | canceled`. */
  type: Schema.String,
});
export type LinearWorkflowState = typeof LinearWorkflowState.Type;

const LinearIssueView = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  state: LinearWorkflowState,
  team: Schema.Struct({
    states: Schema.Struct({ nodes: Schema.Array(LinearWorkflowState) }),
  }),
  comments: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ body: Schema.String })),
  }),
  attachments: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ url: Schema.String })),
  }),
});
type LinearIssueView = typeof LinearIssueView.Type;

const IssueData = Schema.Struct({ issue: Schema.NullOr(LinearIssueView) });
/** A mutation's answer: `data` keyed by the mutation's field, each carrying Linear's `success`. */
const MutationData = Schema.Record(Schema.String, Schema.Unknown);
const MutationResult = Schema.Struct({ success: Schema.Boolean });

/** GraphQL's envelope: `data`, or `errors`, or both. */
const Envelope = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Unknown)),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
        extensions: Schema.optional(
          Schema.Struct({ code: Schema.optional(Schema.String) }),
        ),
      }),
    ),
  ),
});
type Envelope = typeof Envelope.Type;

/**
 * Linear's rate-limit signal. It is not `429`: "with GraphQL requests, response http status code
 * will be 400, but you can catch these by inspecting the errors in the response body containing the
 * RATELIMITED error code" (Linear's rate-limiting docs). So the body of a non-2xx answer is read
 * too, and an error carrying this code is transient whatever the status says.
 */
export const LINEAR_RATE_LIMITED = "RATELIMITED";

const rateLimited = (envelope: Envelope | undefined): boolean =>
  (envelope?.errors ?? []).some(
    (error) => error.extensions?.code === LINEAR_RATE_LIMITED,
  );

/**
 * The one read every operation starts with: everything a write needs to decide whether it is
 * already done. One page of each list — Linear's connections answer 50 by default and up to 250.
 */
export const LINEAR_ISSUE_QUERY = `query FactoryIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    state { id name type }
    team { states(first: 100) { nodes { id name type } } }
    comments(first: 250) { nodes { body } }
    attachments(first: 250) { nodes { url } }
  }
}`;

export const LINEAR_COMMENT_CREATE = `mutation FactoryComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

export const LINEAR_ISSUE_UPDATE = `mutation FactoryIssueState($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

export const LINEAR_ATTACHMENT_CREATE = `mutation FactoryAttachment($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success }
}`;

/** What `nextLinearState` decided. */
export type LinearStateDecision =
  | { readonly _tag: "move"; readonly state: LinearWorkflowState }
  | { readonly _tag: "stay"; readonly why: string }
  | {
      readonly _tag: "missing";
      readonly name: string;
      readonly available: readonly string[];
    };

const sameName = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * Where a phase moves an issue, if anywhere: forward only, never out of a closed state.
 *
 * A closed issue (`completed`, `canceled`) stays closed — a person decided it, and a mirror that
 * reopened it would be the tracker and the factory fighting over one field. An issue already at or
 * past the phase stays put, which is what makes a late or retried report harmless. A state the map
 * names that the team does not have is `missing`: a configuration mistake the caller reports with
 * the names the team does have, rather than a silent skip.
 */
export const nextLinearState = (input: {
  readonly current: LinearWorkflowState;
  readonly states: readonly LinearWorkflowState[];
  readonly mapping: LinearStates;
  readonly phase: LinearPhase;
}): LinearStateDecision => {
  const { current, mapping, phase } = input;
  if (current.type === "completed" || current.type === "canceled") {
    return {
      _tag: "stay",
      why: `the issue is ${current.name} (${current.type}); a closed issue is not reopened`,
    };
  }
  const wanted = mapping[phase];
  const target = input.states.find((state) => sameName(state.name, wanted));
  if (target === undefined) {
    return {
      _tag: "missing",
      name: wanted,
      available: input.states.map((state) => state.name),
    };
  }
  if (target.id === current.id) {
    return { _tag: "stay", why: `the issue is already ${current.name}` };
  }
  const rank = (name: string): number =>
    LINEAR_PHASES.findIndex((candidate) => sameName(mapping[candidate], name));
  if (rank(current.name) >= LINEAR_PHASES.indexOf(phase)) {
    return {
      _tag: "stay",
      why: `the issue is already past ${wanted} (${current.name})`,
    };
  }
  return { _tag: "move", state: target };
};

/** The line a comment is recognized by on a retry. */
export const linearMarker = (sessionId: SessionId, kind: string): string =>
  `factory:${sessionId}:${kind}`;

/**
 * A failure comment's marker kind: the step, and a short digest of the reason. An exact retry of
 * the same failure finds its comment and posts nothing; a *different* failure of the same step —
 * a 403 fixed and then a 422, an over-cap retry with other numbers — is a new reason and explains
 * itself, which a kind of the step alone would have swallowed.
 */
export const linearFailureKind = (step: string, reason: string): string =>
  `failed:${step}:${createHash("sha256").update(reason).digest("hex").slice(0, 8)}`;

const sessionRef = (config: LinearConfig, sessionId: SessionId): string =>
  config.sessionUrlBase === undefined
    ? `\`${sessionId}\``
    : `[${sessionId}](${config.sessionUrlBase.replace(/\/+$/, "")}/${sessionId})`;

/** Text for inline code: a backtick inside would end the span early. */
const code = (text: string): string => `\`${text.replaceAll("`", "'")}\``;

/**
 * The session's verification, as a reader of the issue needs it: the *last* `verify` call's
 * results, one line each. Earlier calls are the run iterating; the last is what the PR carries.
 * No call at all is said, not omitted — a PR with no evidence is a fact a reviewer should see.
 */
export const linearEvidenceLines = (
  records: readonly VerifyRecord[],
): readonly string[] => {
  const latest = records.at(-1);
  if (latest === undefined)
    return ["No verification was recorded in the session."];
  const of =
    records.length === 1
      ? "the session's one `verify` call"
      : `the last of the session's ${records.length} \`verify\` calls`;
  if (latest._tag === "VerifyUnmeasured")
    return [
      `Nothing was verified (${latest.reason}, ${of}): ${latest.message}`,
    ];
  if (latest.results.length === 0)
    return [`Nothing was verified (${of}): the run changed no paths.`];
  return [
    `Verification (${of}):`,
    ...latest.results.map((result) => {
      switch (result._tag) {
        case "VerifyRan":
          return `- ${code(result.surface)} ${result.exitCode === 0 ? "passed" : "failed"} (exit ${result.exitCode}): ${code(result.command)} in ${code(result.directory)}`;
        case "VerifyUnrunnable":
          return `- ${code(result.surface)} could not run (${result.code}): ${result.message}`;
        case "VerifyNoEvidence":
          return `- ${code(result.surface)} has no evidence: ${result.message}`;
      }
    }),
  ];
};

/** The PR comment: the link, the session, the evidence, and the marker a retry finds. */
export const linearPullRequestComment = (
  config: LinearConfig,
  input: {
    readonly sessionId: SessionId;
    readonly pr: { readonly number: number; readonly url: string };
    readonly evidence: readonly VerifyRecord[];
  },
): string =>
  [
    `Factory opened a pull request for this issue: [#${input.pr.number}](${input.pr.url})`,
    "",
    `Session: ${sessionRef(config, input.sessionId)}`,
    "",
    ...linearEvidenceLines(input.evidence),
    "",
    code(linearMarker(input.sessionId, "pr")),
  ].join("\n");

/** A failed run's comment: what stopped it, in words a person can act on. */
export const linearFailureComment = (
  config: LinearConfig,
  input: {
    readonly sessionId: SessionId;
    readonly step: string;
    readonly reason: string;
  },
): string =>
  [
    `Factory's run for this issue did not produce a pull request: ${input.reason}.`,
    "",
    `Session: ${sessionRef(config, input.sessionId)}`,
    "",
    code(
      linearMarker(
        input.sessionId,
        linearFailureKind(input.step, input.reason),
      ),
    ),
  ].join("\n");

type PullRequestLink = { readonly number: number; readonly url: string };

export type LinearIssueSyncShape = {
  /** The session started: move the issue to the started state. */
  readonly started: (input: {
    readonly issueId: string;
    readonly sessionId: SessionId;
  }) => Effect.Effect<void, LinearSyncError>;
  /** The PR opened: attach it, comment its link and evidence, move the issue to in review. */
  readonly pullRequestOpened: (input: {
    readonly issueId: string;
    readonly sessionId: SessionId;
    readonly pr: PullRequestLink;
    readonly evidence: readonly VerifyRecord[];
  }) => Effect.Effect<void, LinearSyncError>;
  /** The run ended without a PR: one comment naming why, deduped by the step and its reason. */
  readonly failed: (input: {
    readonly issueId: string;
    readonly sessionId: SessionId;
    readonly step: string;
    readonly reason: string;
  }) => Effect.Effect<void, LinearSyncError>;
  /** The PR merged: move the issue to done. */
  readonly merged: (input: {
    readonly issueId: string;
    readonly sessionId: SessionId;
    readonly pr: PullRequestLink;
  }) => Effect.Effect<void, LinearSyncError>;
};

export class LinearIssueSync extends Context.Service<
  LinearIssueSync,
  LinearIssueSyncShape
>()("@repo/core/LinearIssueSync") {}

/** What one operation writes, once the issue has been read. */
type Writes = {
  readonly comment?: { readonly marker: string; readonly body: string };
  readonly attachment?: { readonly url: string; readonly title: string };
  readonly phase?: LinearPhase;
};

/**
 * A transient failure is retried twice, a little apart; anything else is the answer. Retrying is
 * safe because every operation re-reads the issue before it writes (see the module comment).
 */
const RETRY = { schedule: Schedule.exponential("100 millis"), times: 2 };

/** An answer's body as GraphQL's envelope, or `undefined` when it is not one. */
const readEnvelope = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Envelope | undefined> =>
  HttpClientResponse.schemaBodyJson(Envelope)(response).pipe(
    Effect.orElseSucceed(() => undefined),
  );

/**
 * The sync over Linear's GraphQL API, through the Effect `HttpClient` every control-plane client
 * uses, so a test fakes it with no interception library.
 *
 * GraphQL answers a refused operation with HTTP `200` and an `errors` list, and a mutation that did
 * not apply with `success: false`; both are failures here, as is any non-2xx. A transport error, a
 * request that outlives `requestTimeout`, `429`, `5xx` and Linear's `RATELIMITED` (on a `400`) are
 * transient; a refusal is not, and is not retried.
 *
 * Operations on one issue are serialized (one permit per issue), so two reports for one issue
 * cannot both read "no comment yet"; operations on different issues do not wait on each other, so
 * one slow issue cannot hold up another's write.
 */
export const LinearIssueSyncLive = (
  config: LinearConfig,
): Layer.Layer<LinearIssueSync, never, HttpClient.HttpClient> =>
  Layer.effect(
    LinearIssueSync,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      /**
       * One permit per issue, held only while someone uses it: an entry counts the operations that
       * hold or wait for its permit and leaves the map when the last one is done, so a long-running
       * process keeps a lock per issue *in flight*, not per issue it ever touched. The count moves
       * in `Effect.sync`, which nothing interleaves with, and the release runs on interruption too.
       */
      const locks = new Map<
        string,
        { readonly semaphore: Semaphore.Semaphore; users: number }
      >();
      const withIssueLock = <A, E>(
        issueId: string,
        effect: Effect.Effect<A, E>,
      ): Effect.Effect<A, E> =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const entry = locks.get(issueId) ?? {
              semaphore: Semaphore.makeUnsafe(1),
              users: 0,
            };
            entry.users += 1;
            locks.set(issueId, entry);
            return entry;
          }),
          (entry) => entry.semaphore.withPermits(1)(effect),
          (entry) =>
            Effect.sync(() => {
              entry.users -= 1;
              if (entry.users === 0) locks.delete(issueId);
            }),
        );
      const timeout = config.requestTimeout ?? LINEAR_REQUEST_TIMEOUT;
      const headers = {
        authorization: Redacted.value(config.apiKey),
        accept: "application/json",
      };

      const graphql = (
        operation: string,
        issueId: string,
        query: string,
        variables: Record<string, unknown>,
      ): Effect.Effect<unknown, LinearSyncError> =>
        Effect.gen(function* () {
          const fail = (message: string, transient = false) =>
            new LinearSyncError({ issueId, operation, message, transient });
          const request = yield* HttpClientRequest.post(config.apiUrl, {
            headers,
          }).pipe(
            HttpClientRequest.bodyJson({ query, variables }),
            Effect.mapError(() => fail("the request could not be encoded")),
          );
          // The whole exchange is bounded, the body included: a Linear that sends headers and then
          // stalls is as stuck as one that never answers.
          const exchange = Effect.gen(function* () {
            const response = yield* http
              .execute(request)
              .pipe(
                Effect.mapError(() =>
                  fail(`Linear could not be reached for ${operation}`, true),
                ),
              );
            if (response.status < 200 || response.status > 299) {
              const refused = yield* readEnvelope(response);
              const limited = rateLimited(refused);
              return yield* fail(
                limited
                  ? `Linear rate-limited ${operation} (HTTP ${response.status}, ${LINEAR_RATE_LIMITED})`
                  : `Linear answered HTTP ${response.status} for ${operation}`,
                limited || response.status === 429 || response.status >= 500,
              );
            }
            return yield* HttpClientResponse.schemaBodyJson(Envelope)(
              response,
            ).pipe(
              Effect.mapError(() =>
                fail(`Linear's answer to ${operation} could not be read`),
              ),
            );
          });
          const envelope = yield* exchange.pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  fail(
                    `Linear did not answer ${operation} within ${Duration.toMillis(timeout)}ms`,
                    true,
                  ),
                ),
            }),
          );
          const errors = envelope.errors ?? [];
          if (errors.length > 0) {
            return yield* fail(
              `Linear refused ${operation}: ${errors.map((error) => error.message).join("; ")}`,
              rateLimited(envelope),
            );
          }
          return envelope.data;
        });

      const readIssue = (
        issueId: string,
      ): Effect.Effect<LinearIssueView, LinearSyncError> =>
        Effect.gen(function* () {
          const data = yield* graphql("issue", issueId, LINEAR_ISSUE_QUERY, {
            id: issueId,
          });
          const decoded = yield* Schema.decodeUnknownEffect(IssueData)(
            data,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new LinearSyncError({
                  issueId,
                  operation: "issue",
                  message: `Linear's issue could not be read: ${cause.message}`,
                  transient: false,
                }),
            ),
          );
          if (decoded.issue === null) {
            return yield* new LinearSyncError({
              issueId,
              operation: "issue",
              message: `Linear has no issue ${issueId} this key can read`,
              transient: false,
            });
          }
          return decoded.issue;
        });

      const mutate = (
        operation: string,
        issueId: string,
        query: string,
        variables: Record<string, unknown>,
      ): Effect.Effect<void, LinearSyncError> =>
        Effect.gen(function* () {
          const data = yield* graphql(operation, issueId, query, variables);
          const fail = (message: string) =>
            new LinearSyncError({
              issueId,
              operation,
              message,
              transient: false,
            });
          const decoded = yield* Schema.decodeUnknownEffect(MutationData)(
            data,
          ).pipe(
            Effect.flatMap((fields) =>
              Schema.decodeUnknownEffect(MutationResult)(fields[operation]),
            ),
            Effect.mapError(() =>
              fail(`Linear's answer to ${operation} could not be read`),
            ),
          );
          if (!decoded.success) {
            return yield* fail(
              `Linear answered success: false to ${operation}`,
            );
          }
        });

      /** Read once, then write only what the read says is missing, in a fixed order. */
      const apply = (
        operation: string,
        issueId: string,
        writes: Writes,
      ): Effect.Effect<void, LinearSyncError> =>
        withIssueLock(
          issueId,
          Effect.gen(function* () {
            const issue = yield* readIssue(issueId);
            if (
              writes.attachment !== undefined &&
              !issue.attachments.nodes.some(
                (node) => node.url === writes.attachment?.url,
              )
            ) {
              yield* mutate(
                "attachmentCreate",
                issueId,
                LINEAR_ATTACHMENT_CREATE,
                {
                  input: {
                    issueId: issue.id,
                    url: writes.attachment.url,
                    title: writes.attachment.title,
                  },
                },
              );
            }
            if (
              writes.comment !== undefined &&
              !issue.comments.nodes.some((node) =>
                node.body.includes(writes.comment?.marker ?? ""),
              )
            ) {
              yield* mutate("commentCreate", issueId, LINEAR_COMMENT_CREATE, {
                input: { issueId: issue.id, body: writes.comment.body },
              });
            }
            if (writes.phase !== undefined) {
              const decision = nextLinearState({
                current: issue.state,
                states: issue.team.states.nodes,
                mapping: config.states,
                phase: writes.phase,
              });
              switch (decision._tag) {
                case "missing":
                  return yield* new LinearSyncError({
                    issueId,
                    operation,
                    message: `${issue.identifier}'s team has no workflow state named "${decision.name}" (it has: ${decision.available.join(", ")})`,
                    transient: false,
                  });
                case "stay":
                  yield* Effect.logDebug(
                    `linear: ${issue.identifier} stays: ${decision.why}`,
                  );
                  break;
                case "move":
                  yield* mutate("issueUpdate", issueId, LINEAR_ISSUE_UPDATE, {
                    id: issue.id,
                    input: { stateId: decision.state.id },
                  });
                  yield* Effect.logInfo(
                    `linear: ${issue.identifier} ${issue.state.name} → ${decision.state.name} (${operation})`,
                  );
                  break;
              }
            }
          }),
        ).pipe(
          Effect.retry({
            ...RETRY,
            while: (error: LinearSyncError) => error.transient,
          }),
        );

      return LinearIssueSync.of({
        started: (input) =>
          apply("started", input.issueId, { phase: "started" }),
        pullRequestOpened: (input) =>
          apply("pullRequestOpened", input.issueId, {
            attachment: {
              url: input.pr.url,
              title: `Pull request #${input.pr.number}`,
            },
            comment: {
              marker: linearMarker(input.sessionId, "pr"),
              body: linearPullRequestComment(config, input),
            },
            phase: "inReview",
          }),
        failed: (input) =>
          apply("failed", input.issueId, {
            comment: {
              marker: linearMarker(
                input.sessionId,
                linearFailureKind(input.step, input.reason),
              ),
              body: linearFailureComment(config, input),
            },
          }),
        merged: (input) => apply("merged", input.issueId, { phase: "done" }),
      });
    }),
  );

/**
 * How long the trigger seam waits for the *started* move before it answers anyway. Linear expects a
 * webhook answered within seconds, and the move is a mirror: an answer that waited longer than this
 * would be a redelivery of a session that already exists.
 */
export const LINEAR_STARTED_BUDGET: Duration.Input = "4 seconds";

/**
 * The trigger seam's write-back, filled by the sync: a Linear delivery that opened a session moves
 * its issue to the started state. Any other source is not this adapter's to answer, so it passes —
 * the Linear and generic routes share one seam (`apps/api`'s `Webhook.ts`).
 *
 * **Best effort: a failed or slow move is logged, never the delivery's failure.** The seam calls the
 * write-back after it has created the session and sent it the rule's prompt, and a failed delivery
 * gives its claim back so the sender retries — which would send the prompt to the same session
 * again on every redelivery, and a permanent failure (a state the team lacks, a key without write
 * scope) would make that every time. The started state is a mirror, not the product: the session
 * runs either way, and the PR step's own report moves the issue past *started* (forward only), so a
 * move missed here is converged by the next one rather than retried by a redelivery.
 */
export const LinearTriggerWriteBack: Layer.Layer<
  TriggerWriteBack,
  never,
  LinearIssueSync
> = Layer.effect(
  TriggerWriteBack,
  Effect.gen(function* () {
    const sync = yield* LinearIssueSync;
    return TriggerWriteBack.of({
      write: (input) =>
        input.event.source !== "linear"
          ? Effect.void
          : sync
              .started({ issueId: input.event.key, sessionId: input.sessionId })
              .pipe(
                Effect.timeoutOrElse({
                  duration: LINEAR_STARTED_BUDGET,
                  orElse: () =>
                    Effect.logWarning(
                      `linear: ${input.event.key} was not moved to started within ${Duration.toMillis(LINEAR_STARTED_BUDGET)}ms; the session runs, and the PR step's report moves it on`,
                    ),
                }),
                Effect.catchTag("LinearSyncError", (error) =>
                  Effect.logError(
                    `linear: could not move ${error.issueId} to started for ${input.sessionId} (${error.operation}): ${error.message}`,
                  ),
                ),
              ),
    });
  }),
);

/**
 * The sync of a deployment with no Linear key: every operation writes nothing. It is what lets the
 * consumers be wired the same way whether or not a key is set (`apps/api`'s `LinearSync.ts`).
 */
export const NoLinearIssueSync = Layer.succeed(
  LinearIssueSync,
  LinearIssueSync.of({
    started: () => Effect.void,
    pullRequestOpened: () => Effect.void,
    failed: () => Effect.void,
    merged: () => Effect.void,
  }),
);

const storageError =
  (issueId: string, operation: string) =>
  (cause: { readonly message: string }): LinearSyncError =>
    new LinearSyncError({
      issueId,
      operation,
      message: `${operation}: ${cause.message}`,
      transient: false,
    });

/**
 * The Linear issue a session was delegated from, or `undefined` for a session no Linear delivery
 * opened. The session's own request id is the record — `trigger:linear:<issue>:mapped`, written by
 * the seam when the issue's delivery opened it — so the binding needs no table of its own.
 */
const issueOfSession = (
  sql: SqlClient,
  sessionId: SessionId,
): Effect.Effect<string | undefined, LinearSyncError> =>
  sql<{ readonly requestId: string | null }>`
    SELECT request_id FROM sessions WHERE id = ${sessionId}
  `.pipe(
    Effect.map((rows) =>
      linearIssueOfDelivery(deliveryIdOfSession(rows[0]?.requestId)),
    ),
    Effect.mapError(storageError(sessionId, "read the session's issue")),
  );

/**
 * The session layer's write-back, filled by the sync: the PR step's exit, mirrored on the issue the
 * session was delegated from — the PR and its evidence, or the failure and its reason.
 *
 * A session no Linear issue opened is not reported. A sync that could not finish is logged, not
 * raised (`SessionWriteBack`: a mirror cannot fail the step); its writes are idempotent, so the next
 * report of the same step completes it.
 *
 * Its output type reads `never`: a `Context.Reference` key carries no identifier type, so providing
 * one adds nothing a requirement could name — which is also why a layer that omits it still builds.
 */
export const LinearSessionWriteBack = Layer.effect(
  SessionWriteBack,
  Effect.gen(function* () {
    const sync = yield* LinearIssueSync;
    const sql = yield* SqlClient;
    return {
      pullRequest: (input) =>
        Effect.gen(function* () {
          const report = pullRequestReport(input.result);
          if (report._tag === "interrupted") return;
          const issueId = yield* issueOfSession(sql, input.sessionId);
          if (issueId === undefined) return;
          if (report._tag === "opened") {
            const evidence = yield* input.evidence;
            yield* sync.pullRequestOpened({
              issueId,
              sessionId: input.sessionId,
              pr: report.pr,
              evidence,
            });
          } else {
            yield* sync.failed({
              issueId,
              sessionId: input.sessionId,
              step: report.step,
              reason: report.reason,
            });
          }
        }).pipe(
          Effect.catchTag("LinearSyncError", (error) =>
            Effect.logError(
              `linear: could not mirror ${input.sessionId}'s PR step on ${error.issueId} (${error.operation}): ${error.message}`,
            ),
          ),
        ),
    };
  }),
);

/** A GitHub `pull_request` event, as far as the issue cares. */
export type PullRequestLifecycle =
  | {
      readonly _tag: "merged" | "closed";
      /** The PR by its page (`html_url`): what the PR step records in `sessions.pr_url`. */
      readonly pr: PullRequestLink;
      /**
       * The PR's API resource (`pull_request.url`). Matched as well as the page, because a session
       * whose PR was opened before the step recorded the page (LOB-15) holds this one instead.
       */
      readonly apiUrl?: string;
    }
  | { readonly _tag: "other"; readonly action: string };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * A GitHub `pull_request` webhook payload, read for the one thing the issue's state follows: did
 * the PR merge, close unmerged, or do something else (`synchronize` — a new commit — `edited`,
 * `review_requested`, …). `undefined` is a payload that names no pull request.
 *
 * Only `closed` is ever more than `other`: GitHub sends a merge as `action: "closed"` with
 * `pull_request.merged: true`, and an unmerged close as the same action with `merged: false`.
 */
export const githubPullRequestLifecycle = (
  payload: unknown,
): PullRequestLifecycle | undefined => {
  const body = asRecord(payload);
  const pr = asRecord(body?.["pull_request"]);
  const url = pr?.["html_url"];
  const number = pr?.["number"];
  if (typeof url !== "string" || typeof number !== "number") return undefined;
  const action = typeof body?.["action"] === "string" ? body["action"] : "";
  if (action !== "closed") return { _tag: "other", action };
  const apiUrl = pr?.["url"];
  return {
    _tag: pr?.["merged"] === true ? "merged" : "closed",
    pr: { number, url },
    ...(typeof apiUrl === "string" && apiUrl !== url ? { apiUrl } : {}),
  };
};

/**
 * Mirror one PR event on the issues of the sessions that opened that PR: a merge moves each to
 * done, an unmerged close explains itself, and anything else — a new commit included — writes
 * nothing, because the issue's state is the task's and the review is not (module comment).
 *
 * Answers how many issues it wrote to. The sessions are found by the PR link the step recorded
 * (`sessions.pr_url`, LOB-177), so a PR the factory did not open touches no issue.
 */
export const syncPullRequestLifecycle = (
  event: PullRequestLifecycle,
): Effect.Effect<number, LinearSyncError, LinearIssueSync | SqlClient> =>
  Effect.gen(function* () {
    if (event._tag === "other") return 0;
    const sync = yield* LinearIssueSync;
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      readonly id: SessionId;
      readonly requestId: string | null;
    }>`
      SELECT id, request_id FROM sessions
      WHERE pr_url = ${event.pr.url} OR pr_url = ${event.apiUrl ?? event.pr.url}
    `.pipe(
      Effect.mapError(storageError(event.pr.url, "read the PR's sessions")),
    );
    let synced = 0;
    for (const row of rows) {
      const issueId = linearIssueOfDelivery(deliveryIdOfSession(row.requestId));
      if (issueId === undefined) continue;
      yield* event._tag === "merged"
        ? sync.merged({ issueId, sessionId: row.id, pr: event.pr })
        : sync.failed({
            issueId,
            sessionId: row.id,
            step: "pr-closed",
            reason: `pull request #${event.pr.number} was closed without being merged`,
          });
      synced += 1;
    }
    return synced;
  });

/** The header GitHub signs a webhook body into: `sha256=<hex HMAC-SHA256 of the raw body>`. */
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";

/** The header naming which event a GitHub delivery is (`pull_request`, `ping`, …). */
export const GITHUB_EVENT_HEADER = "x-github-event";

/** Whether `signature` is GitHub's `X-Hub-Signature-256` for `raw` under `secret`. */
export const verifyGitHubSignature = (
  raw: string,
  signature: string | undefined,
  secret: string,
): boolean => {
  if (signature === undefined || !signature.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(signature.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/** A webhook's answer: the status and the JSON body a route sends. */
export type GitHubWebhookAnswer = {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
};

const JsonBody = Schema.fromJsonString(Schema.Unknown);

/**
 * One GitHub webhook delivery, taken as far as the Linear mirror needs: the PR's merge moves its
 * issue to done, an unmerged close explains itself, and every other event or action writes nothing.
 * This is what `POST /webhooks/github` runs (`apps/api`), kept here so a test and the drive run the
 * same code the route does.
 *
 * In the order each step refuses more, as the trigger routes do: no secret configured is `503`
 * (an unsigned route would let anyone who can reach the port move issues to done), a wrong or
 * missing `X-Hub-Signature-256` is `401`, an event other than `pull_request` is `202` and ignored
 * (`ping` included), and a body that names no pull request is `400`.
 *
 * Every write is idempotent (module comment), so GitHub's redelivery of an event — by hand, from the
 * delivery log — is safe. A failed sync is `500` and logged, so the delivery log shows it.
 */
export const handleGitHubPullRequestWebhook = (input: {
  readonly secret: string | undefined;
  readonly raw: string;
  readonly signature: string | undefined;
  readonly event: string | undefined;
}): Effect.Effect<GitHubWebhookAnswer, never, LinearIssueSync | SqlClient> =>
  Effect.gen(function* () {
    const secret = input.secret ?? "";
    if (secret === "") {
      return {
        status: 503,
        body: {
          ok: false,
          error:
            "this route has no secret configured (GITHUB_WEBHOOK_SECRET); it accepts nothing until one is set",
          code: "not-configured",
        },
      };
    }
    if (!verifyGitHubSignature(input.raw, input.signature, secret)) {
      return { status: 401, body: { ok: false, error: "bad signature" } };
    }
    if (input.event !== "pull_request") {
      return {
        status: 202,
        body: {
          ok: true,
          ignored: `event "${input.event ?? ""}" is not pull_request`,
        },
      };
    }
    const payload = yield* Schema.decodeEffect(JsonBody)(input.raw).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const lifecycle = githubPullRequestLifecycle(payload);
    if (lifecycle === undefined) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "the payload does not name a pull request",
          code: "bad-payload",
        },
      };
    }
    return yield* syncPullRequestLifecycle(lifecycle).pipe(
      Effect.map((synced): GitHubWebhookAnswer => ({
        status: 200,
        body: {
          ok: true,
          event: lifecycle._tag === "other" ? lifecycle.action : lifecycle._tag,
          synced,
        },
      })),
      Effect.catchTag("LinearSyncError", (error) =>
        Effect.logError(
          `linear: could not mirror a pull_request event on ${error.issueId} (${error.operation}): ${error.message}`,
        ).pipe(
          Effect.as<GitHubWebhookAnswer>({
            status: 500,
            body: { ok: false, error: error.message, code: "write-back" },
          }),
        ),
      ),
    );
  });
