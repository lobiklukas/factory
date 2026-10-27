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
 *   comment, like any other run that ended without a change landing.
 *
 * **The issue's state is the task's, never the review's.** Mastra Factory keeps a PR's review as
 * its own item with its own completion rules, and LOB-15 keeps that separation: there is no
 * "approved" or "changes requested" state in the map, nothing here records a review verdict on the
 * issue, and a new commit on the PR (`synchronize`) changes nothing on it — so there is no stale
 * approval on the issue for a new commit to leave behind. The review itself is GitHub's (D16), and
 * the review *item* with its re-review rule is LOB-36's. The merge is the one PR event that moves
 * the issue, because the merge is the task's completion gate (B4: `review → done` is "a human
 * merge"), not a review verdict.
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
 * Operations in one process are serialized (one permit), so two reports for one issue cannot both
 * read "no comment yet". Across processes the read and the write are not atomic — the window is two
 * reports landing in the same instant, which `docs/testing-third-parties.md` records.
 *
 * **Auth is a Linear API key**, sent verbatim as `Authorization` — Linear's documented form for a
 * personal key; an OAuth token is sent as `Bearer <token>`, so a deployment holding one sets the
 * variable to that. No key configured means no write-back (`linearConfigFromEnv` answers
 * `undefined`), exactly as an unconfigured Jira or Slack adapter: "no tracker" is a state the
 * process can be in.
 */
import {
  Context,
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
import { TriggerError } from "@repo/domain/Trigger";
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
};

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
    Schema.Array(Schema.Struct({ message: Schema.String })),
  ),
});

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
    code(linearMarker(input.sessionId, `failed:${input.step}`)),
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
  /** The run ended without a PR: one comment naming why. `step` is what the comment dedupes by. */
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

/**
 * The sync over Linear's GraphQL API, through the Effect `HttpClient` every control-plane client
 * uses, so a test fakes it with no interception library.
 *
 * GraphQL answers a refused operation with HTTP `200` and an `errors` list, and a mutation that did
 * not apply with `success: false`; both are failures here, as is any non-2xx. A transport error,
 * `429` and `5xx` are transient; a refusal is not, and is not retried.
 */
export const LinearIssueSyncLive = (
  config: LinearConfig,
): Layer.Layer<LinearIssueSync, never, HttpClient.HttpClient> =>
  Layer.effect(
    LinearIssueSync,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const lock = yield* Semaphore.make(1);
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
          const response = yield* http
            .execute(request)
            .pipe(
              Effect.mapError(() =>
                fail(`Linear could not be reached for ${operation}`, true),
              ),
            );
          if (response.status < 200 || response.status > 299) {
            return yield* fail(
              `Linear answered HTTP ${response.status} for ${operation}`,
              response.status === 429 || response.status >= 500,
            );
          }
          const envelope = yield* HttpClientResponse.schemaBodyJson(Envelope)(
            response,
          ).pipe(
            Effect.mapError(() =>
              fail(`Linear's answer to ${operation} could not be read`),
            ),
          );
          const errors = envelope.errors ?? [];
          if (errors.length > 0) {
            return yield* fail(
              `Linear refused ${operation}: ${errors.map((error) => error.message).join("; ")}`,
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
        lock
          .withPermits(1)(
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
          )
          .pipe(
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
              marker: linearMarker(input.sessionId, `failed:${input.step}`),
              body: linearFailureComment(config, input),
            },
          }),
        merged: (input) => apply("merged", input.issueId, { phase: "done" }),
      });
    }),
  );

/**
 * The trigger seam's write-back, filled by the sync: a Linear delivery that opened a session moves
 * its issue to the started state. Any other source is not this adapter's to answer, so it passes —
 * the Linear and generic routes share one seam (`apps/api`'s `Webhook.ts`).
 *
 * A failed write fails the delivery (`write-back`), as on Jira: the claim is given back, Linear
 * retries, and the retry reuses the session the first attempt opened and finds the state already
 * moved if the move landed.
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
                Effect.mapError(
                  (cause) =>
                    new TriggerError({
                      code: "write-back",
                      message: cause.message,
                    }),
                ),
              ),
    });
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
      readonly pr: PullRequestLink;
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
  return {
    _tag: pr?.["merged"] === true ? "merged" : "closed",
    pr: { number, url },
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
      SELECT id, request_id FROM sessions WHERE pr_url = ${event.pr.url}
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
