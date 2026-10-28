/**
 * Linear as the place a run's question is asked and answered, and the place that says an issue is
 * not ready (T5, part of LOB-14: "Questions and answers ride Linear's own primitives").
 *
 * **A question goes out as an `elicitation`.** A card filed from a Linear issue (`linear:<issue id>`,
 * LOB-254) has a person who works in Linear. When one of its runs asks (B7), the card parks as it
 * always did and the question is *also* posted into Linear as one agent activity of type
 * `elicitation` (`LinearAskWriteBack`), in the agent session the factory holds on that issue — opened
 * by the first question, kept in `linear_agent_sessions`. Linear shows it as a question to answer in
 * the thread.
 *
 * **One question is one activity.** Every ask is keyed by `<session>:<tool call>`; the activity is
 * posted once and recorded in `linear_elicitations` after Linear accepted it, so a replay of the same
 * ask — a crashed run's retry — posts nothing, and an ask whose post failed is posted by its replay.
 * The mirror cannot fail the ask: the question is on the card first (`AskWriteBack`).
 *
 * **The reply is an event.** The person answers in the thread and Linear sends an `AgentSessionEvent`
 * of action `prompted` carrying their text. The seam hands it here (`linearReplies`): it becomes the
 * card's `answer` comment — the one `TaskService.comment` records when a person writes on a card
 * blocked `needs_input` — and lifts the block. The text is the event's; nothing reads the comment
 * back from Linear, because a Linear comment is editable and an event is what was said. A reply to
 * a card that is not waiting (answered already, or never asked) is recorded as a skip and changes
 * nothing, which is also what makes a redelivered reply one answer.
 *
 * **An issue with open blockers does not start** (`linearBlockers`): the seam asks, for a delivery
 * that would start work, which of the issue's `blockedBy` issues are not finished, and skips it with
 * `blocked by <ids>` while any are.
 */
import { Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { TriggerError } from "@repo/domain/Trigger";
import type { TaskId } from "@repo/domain/Task";
import { AskWriteBack } from "./AskWriteBack";
import { linearIssueOfExternalRef } from "./Linear";
import {
  LinearIssueSync,
  type LinearIssueSyncShape,
  type LinearSyncError,
} from "./LinearSync";
import { TaskService } from "./TaskService";
import {
  TriggerBlockers,
  TriggerReplies,
  triggerActorOf,
  type TriggerReply,
  type TriggerReplyOutcome,
} from "./TriggerService";

/**
 * The seam's blocker read for Linear: an event from Linear is checked against the issue's relations,
 * any other source has none. A read that fails is `tracker-read` — the delivery is retried, not
 * started on a guess.
 */
export const linearBlockers =
  (sync: Pick<LinearIssueSyncShape, "openBlockers">) =>
  (event: {
    readonly source: string;
    readonly key: string;
  }): Effect.Effect<ReadonlyArray<string>, TriggerError> =>
    event.source !== "linear"
      ? Effect.succeed([])
      : sync.openBlockers({ issueId: event.key }).pipe(
          Effect.mapError(
            (error: LinearSyncError) =>
              new TriggerError({
                code: "tracker-read",
                message: `could not read ${event.key}'s blockers (${error.operation}): ${error.message}`,
              }),
          ),
        );

/** The seam's blocker read, filled by the sync: wire it where the seam is built. */
export const LinearTriggerBlockers = Layer.effect(
  TriggerBlockers,
  Effect.gen(function* () {
    return linearBlockers(yield* LinearIssueSync);
  }),
);

const storageFailure = (what: string) => (cause: SqlError) =>
  new TriggerError({ code: "storage", message: `${what}: ${cause.message}` });

/** How often a reply re-reads a card that moved under it before it gives up and fails the delivery. */
const ANSWER_ATTEMPTS = 3;

/**
 * The seam's reply port for Linear: a person's reply in the agent session on an issue becomes the
 * answer on the card that issue filed and is waiting on a question. `unmatched` — no card is waiting —
 * is a decision the seam records as a skip.
 */
export const linearReplies = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tasks = yield* TaskService;
  return (
    reply: TriggerReply,
  ): Effect.Effect<TriggerReplyOutcome, TriggerError> =>
    Effect.gen(function* () {
      const waiting = yield* sql<{ id: string }>`
        SELECT id FROM tasks
        WHERE external_ref = ${`linear:${reply.key}`} AND blocked_reason = 'needs_input'
        ORDER BY blocked_since DESC, id
      `.pipe(Effect.mapError(storageFailure("read the waiting card")));
      const first = waiting[0];
      if (first === undefined) {
        return {
          _tag: "unmatched",
          reason: `no card filed from ${reply.key} is waiting on an answer`,
        } as const;
      }
      const taskId = first.id as TaskId;
      // Read, then write against what was read: a card whose revision moved in between (a person
      // edited it) is read again, and one that stopped waiting meanwhile is not answered twice.
      const attempt = Effect.gen(function* () {
        const card = yield* tasks.get(taskId);
        if (card.blocked?.reason !== "needs_input") {
          return {
            _tag: "unmatched",
            reason: `card ${taskId} is no longer waiting on an answer`,
          } as const;
        }
        yield* tasks.comment({
          taskId,
          expectedRevision: card.revision,
          body: reply.body,
          actor: triggerActorOf("linear"),
        });
        return {
          _tag: "answered",
          taskId,
          reason: `recorded the reply in agent session ${reply.agentSessionId} as the answer on card ${taskId}, which lifted its needs_input block`,
        } as const;
      });
      return yield* attempt.pipe(
        Effect.retry({
          times: ANSWER_ATTEMPTS,
          while: (error) => error._tag === "StaleRevision",
        }),
        Effect.mapError(
          (error) =>
            new TriggerError({
              code: "card-create",
              message: `could not record the reply on card ${taskId}: ${error.message}`,
            }),
        ),
      );
    });
});

/** The seam's reply port, filled by the board: wire it where the seam is built. */
export const LinearTriggerReplies = Layer.effect(TriggerReplies, linearReplies);

/**
 * The ask port of a deployment with a Linear key: a question on a card filed from a Linear issue is
 * posted into the issue's agent session as an `elicitation`, once per ask.
 *
 * Posts are serialized (one permit): opening the issue's session and recording it is a read then a
 * write, and two questions on one issue — or a replay beside the ask it replays — must not both open
 * one. Questions are rare and a post is one request, so one lock costs nothing.
 */
export const LinearAskWriteBack = Layer.effect(
  AskWriteBack,
  Effect.gen(function* () {
    const sync = yield* LinearIssueSync;
    const sql = yield* SqlClient;
    const lock = Semaphore.makeUnsafe(1);

    const post = (input: {
      readonly taskId: string;
      readonly askId: string;
      readonly question: string;
    }): Effect.Effect<void, SqlError | LinearSyncError> =>
      Effect.gen(function* () {
        const cards = yield* sql<{ externalRef: string | null }>`
          SELECT external_ref FROM tasks WHERE id = ${input.taskId}
        `;
        const issueId = linearIssueOfExternalRef(cards[0]?.externalRef);
        // A card no Linear issue filed has nobody in Linear to ask.
        if (issueId === undefined) return;
        const posted = yield* sql`
          SELECT 1 FROM linear_elicitations WHERE ask_id = ${input.askId}
        `;
        if (posted.length > 0) return;
        const known = yield* sql<{ agentSessionId: string }>`
          SELECT agent_session_id FROM linear_agent_sessions WHERE issue_id = ${issueId}
        `;
        const agentSessionId =
          known[0]?.agentSessionId ??
          (yield* Effect.gen(function* () {
            const opened = yield* sync.openAgentSession({ issueId });
            yield* sql`
              INSERT INTO linear_agent_sessions (issue_id, agent_session_id)
              VALUES (${issueId}, ${opened})
              ON CONFLICT (issue_id) DO NOTHING
            `;
            return opened;
          }));
        yield* sync.elicit({
          issueId,
          agentSessionId,
          question: input.question,
        });
        yield* sql`
          INSERT INTO linear_elicitations (ask_id, task_id, issue_id, agent_session_id)
          VALUES (${input.askId}, ${input.taskId}, ${issueId}, ${agentSessionId})
          ON CONFLICT (ask_id) DO NOTHING
        `;
        yield* Effect.logInfo(
          `linear: asked ${issueId} (${input.askId}) as an elicitation in agent session ${agentSessionId}`,
        );
      });

    return {
      asked: (input) =>
        lock
          .withPermits(1)(post(input))
          .pipe(
            Effect.catch((error) =>
              Effect.logError(
                `linear: could not ask ${input.taskId}'s question in Linear (${input.askId}): ${error.message}`,
              ),
            ),
          ),
    };
  }),
);
