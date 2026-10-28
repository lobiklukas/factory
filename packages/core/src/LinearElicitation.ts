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
 * The two mutations (`openAgentSession`, `elicit`) are never retried inside the request: a lost
 * acknowledgement cannot be told from a miss, and a second post is a second question in Linear.
 * The mirror cannot fail the ask: the question is on the card first (`AskWriteBack`).
 *
 * **The reply is an event.** The person answers in the thread and Linear sends an `AgentSessionEvent`
 * of action `prompted` carrying their text. The seam hands it here (`linearReplies`): it becomes the
 * card's `answer` comment — the one `TaskService.comment` records when a person writes on a card
 * blocked `needs_input` — and lifts the block. The text is the event's; nothing reads the comment
 * back from Linear, because a Linear comment is editable and an event is what was said. A reply to
 * a card that is not waiting (answered already, or never asked) is recorded as a skip and changes
 * nothing, which is also what makes a redelivered reply one answer. Only the thread the factory asked
 * in answers (`linear_agent_sessions`): a session Linear opened on a mention or a delegation is
 * another thread, and its `prompted` events are recorded skips.
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
      // Only the thread the factory asked in answers: a session Linear opened on a mention or a
      // delegation, or anyone's message in another, is not the reply to the question.
      const asked = yield* sql`
        SELECT 1 FROM linear_agent_sessions
        WHERE issue_id = ${reply.key} AND agent_session_id = ${reply.agentSessionId}
      `.pipe(Effect.mapError(storageFailure("read the asked agent session")));
      if (asked.length === 0) {
        return {
          _tag: "unmatched",
          reason: `agent session ${reply.agentSessionId} is not the one the factory asked ${reply.key}'s question in`,
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
              code:
                error._tag === "TaskStorageError" ? "storage" : "write-back",
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
 * Posts are serialized **per issue**: opening the issue's session and recording it is a read then a
 * write, and two questions on one issue — or a replay beside the ask it replays — must not both open
 * one. Another issue's question does not wait on it, so a slow Linear on one issue cannot starve
 * another's inside the session layer's write-back budget. The lock is per process; across processes
 * the insert decides (`ON CONFLICT … DO UPDATE … RETURNING`), and the loser posts into the session
 * that was kept, not its own.
 */
export const LinearAskWriteBack = Layer.effect(
  AskWriteBack,
  Effect.gen(function* () {
    const sync = yield* LinearIssueSync;
    const sql = yield* SqlClient;
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
        yield* withIssueLock(
          issueId,
          Effect.gen(function* () {
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
                // Another process may have opened and kept one meanwhile: the stored row wins, and
                // the question goes into it.
                const kept = yield* sql<{ agentSessionId: string }>`
                  INSERT INTO linear_agent_sessions (issue_id, agent_session_id)
                  VALUES (${issueId}, ${opened})
                  ON CONFLICT (issue_id) DO UPDATE SET issue_id = EXCLUDED.issue_id
                  RETURNING agent_session_id
                `;
                return kept[0]?.agentSessionId ?? opened;
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
          }),
        );
      });

    return {
      asked: (input) =>
        post(input).pipe(
          Effect.catch((error) =>
            Effect.logError(
              `linear: could not ask ${input.taskId}'s question in Linear (${input.askId}): ${error.message}`,
            ),
          ),
        ),
    };
  }),
);
