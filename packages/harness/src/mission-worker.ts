/**
 * A mission's worker: one independent subtask, run as a child task of the mission in a conversation
 * of its own (LOB-193, part 2 of LOB-35).
 *
 * A worker is a task rather than a function the mission calls, because the fan-out has to be
 * durable and the abort has to be Pi Durable's: the mission commits its workers and a `waiting`
 * state on them in one commit, runs no code while they work, and the join policy (`failFast` or
 * `allSettled`) is the scheduler's rule rather than a loop in a phase handler. A worker is owned by
 * the mission task, so aborting the mission aborts its workers first (bottom-up), and a `failFast`
 * join aborts the workers still running when one of them settles anything but `completed`.
 *
 * The conversation is the worker's own — created in the worker's first commit and owned by the
 * worker task — so its transcript, its runs and its spend (`pi.usage`, LOB-194) are attributable to
 * one worker rather than mixed into the session's root conversation. The conversation's agent starts
 * as a copy of the root's, which is what a subagent's does.
 *
 * Three phases: `open` creates the conversation, `converse` sends the worker's prompt and waits for
 * the answer, and `check` runs the worker's own command in the mission's workspace when it declares
 * one. A worker with no command is done once its conversation answered.
 */
import type { Context } from "@earendil-works/chord";
import type {
  ConversationId,
  NextTaskState,
  RunningTask,
  TaskId,
  TaskRuntime,
  Tx,
} from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Effect, Option, Schema } from "effect";
import { MissionWorker, readMissionWorkers } from "@repo/domain/Mission";
import { MissionDoc, missionKey } from "./docs";
import { attempt } from "./session";

/** The task kind a mission's worker registers under. */
export const MISSION_WORKER_TASK_NAME = "factory.mission.worker";

/** The worker definition's version, pinned by every worker task record. */
export const MISSION_WORKER_VERSION = 1;

/**
 * One independent subtask of a mission. The schema lives in `@repo/domain/Mission`, because the
 * wire has to accept exactly the workers the task runs; this re-export keeps `@repo/harness` the
 * place a caller names it.
 */
export { MissionWorker };

/**
 * What a worker task is created with: the worker, and the checkout its `check` runs in.
 *
 * The path is input rather than something the worker looks up, for the reason the mission's
 * workspace is: a task owns its conversation and nothing else.
 */
export const MissionWorkerInput = Schema.Struct({
  worker: MissionWorker,
  workspace: Schema.Struct({ path: Schema.String }),
});
export type MissionWorkerInput = typeof MissionWorkerInput.Type;

/** Where a worker is: about to open its conversation, talking in it, or checking its work. */
export type MissionWorkerState =
  | { readonly phase: "open" }
  | { readonly phase: "converse"; readonly conversationId: ConversationId }
  | { readonly phase: "check"; readonly conversationId: ConversationId };

/** What a worker that completed did: which conversation it talked in, and what its check ran. */
export type MissionWorkerResult = {
  readonly worker: string;
  readonly conversationId: ConversationId;
  readonly check?: { readonly command: string; readonly exitCode: number };
};

/**
 * Why a worker settled `failed`, committed as the outcome's `detail`. A union of reasons for the
 * reason `MissionFailureDetail` is one: each has its own facts.
 */
export type MissionWorkerFailureDetail =
  | {
      readonly worker: string;
      readonly reason: "no-conversation";
    }
  | {
      readonly worker: string;
      readonly reason: "unanswered";
      readonly why: string;
    }
  | {
      readonly worker: string;
      readonly reason: "no-environment";
      readonly message: string;
    }
  | {
      readonly worker: string;
      readonly reason: "check-failed";
      readonly command: string;
      readonly exitCode: number;
    }
  | {
      readonly worker: string;
      readonly reason: "exec-error";
      readonly command: string;
      readonly message: string;
    };

type WorkerNext = NextTaskState<MissionWorkerState, MissionWorkerResult>;

type WorkerRuntime = TaskRuntime<
  MissionWorkerInput,
  MissionWorkerState,
  MissionWorkerResult,
  object
>;

/** What running one command in a workspace came to, without throwing out of the phase that ran it. */
export type CommandRun =
  | { readonly _tag: "exited"; readonly exitCode: number }
  | { readonly _tag: "no-environment"; readonly message: string }
  | { readonly _tag: "exec-error"; readonly message: string };

/**
 * Run `command` in `cwd` through the task's execution environment.
 *
 * Every way it can go wrong is a value: a phase that throws settles its task `faulted`, which says
 * the harness broke rather than that the work did not pass. The environment's `exec` kills the
 * command's process tree when `context` is aborted, which is how an aborted worker stops a check
 * that is still running instead of waiting it out.
 */
export const runCommand = (
  open: (context: Context) => Promise<ExecutionEnv | undefined>,
  command: string,
  cwd: string,
  context: Context,
): Effect.Effect<CommandRun> =>
  Effect.gen(function* () {
    const env = yield* Effect.result(
      attempt("open the execution environment", () => open(context)),
    );
    if (env._tag === "Failure")
      return { _tag: "no-environment", message: env.failure.message } as const;
    const environment = env.success;
    if (environment === undefined)
      return {
        _tag: "no-environment",
        message: "the session has no execution environment",
      } as const;
    const ran = yield* Effect.result(
      attempt(`run \`${command}\``, () =>
        environment.exec(command, { cwd }, context),
      ),
    );
    if (ran._tag === "Failure")
      return { _tag: "exec-error", message: ran.failure.message } as const;
    if (!ran.success.ok)
      return {
        _tag: "exec-error",
        message: ran.success.error.message,
      } as const;
    return { _tag: "exited", exitCode: ran.success.value.exitCode } as const;
  });

/**
 * Record the conversation a worker opened in its mission's roster (LOB-194), in the worker's own
 * commit. The fan-out wrote the worker's entry with no conversation; this fills it in. A mission
 * whose document has no entry for the worker (an owner the roster never named) gets one, so the
 * conversation is attributable either way. A worker with no owner has no mission to name it to.
 */
const nameConversation = (
  tx: Tx,
  owner: TaskId | undefined,
  runtime: WorkerRuntime,
  worker: string,
  conversationId: ConversationId,
): Promise<void> => {
  if (owner === undefined) return Promise.resolve();
  const key = missionKey(owner);
  return tx.doc(MissionDoc, runtime.conversationId, key, key).then((doc) => {
    const taskId = String(runtime.taskId);
    const roster = readMissionWorkers(doc);
    const entry = {
      id: worker,
      taskId,
      conversationId: String(conversationId),
    };
    doc.workers = roster.some((each) => each.taskId === taskId)
      ? roster.map((each) => (each.taskId === taskId ? entry : each))
      : [...roster, entry];
  });
};

/** A worker that settled `failed`, with its reason in the committed detail. */
const failed = (
  message: string,
  detail: MissionWorkerFailureDetail,
): WorkerNext => ({
  status: "terminal",
  outcome: { status: "failed", error: { message, detail } },
});

/** The request id a worker's prompt is sent under, so a rerun after a crash finds the same submission. */
export const workerRequestId = (taskId: TaskId): string =>
  `${MISSION_WORKER_TASK_NAME}:${String(taskId)}`;

const decodeWorkerInput = Schema.decodeUnknownOption(MissionWorkerInput);

/** The worker id a task record's input names, when it is a worker's. */
const workerIdOf = (input: unknown): string | undefined =>
  Option.getOrUndefined(
    Option.map(decodeWorkerInput(input), (decoded) => decoded.worker.id),
  );

/**
 * Why this worker is being aborted, as its outcome records it.
 *
 * Pi Durable does not say why a task carries an abort mark, so the reason is read off the log: a
 * worker whose mission is parked on a `failFast` join and has a sibling that settled other than
 * `completed` was aborted by that join, and the reason names the sibling. A worker whose mission
 * carries an abort mark was aborted with it. Anything else — a worker aborted directly, the session
 * stopped — is recorded as an abort in the phase the worker was in, without a cause it cannot show.
 */
const abortReason = (
  task: RunningTask<
    MissionWorkerInput,
    MissionWorkerState,
    MissionWorkerResult
  >,
  runtime: WorkerRuntime,
  context: Context,
): Effect.Effect<string> => {
  const plain = `the worker "${task.input.worker.id}" was aborted in ${task.state.checkpoint.phase}`;
  return Effect.gen(function* () {
    const ownerId = task.owner;
    if (ownerId === undefined) return plain;
    const owner = yield* attempt("read the mission that owns the worker", () =>
      runtime.getTask(ownerId, context),
    );
    // The mission's own abort reaches its workers first (bottom-up): every sibling is aborted with
    // this one, so none of them is the cause.
    if (owner?.abortRequested === true)
      return `${plain}: its mission was aborted`;
    if (
      owner === undefined ||
      owner.state.status !== "waiting" ||
      owner.state.policy !== "failFast"
    )
      return plain;
    // A failed sibling before an aborted one: the join aborts every live sibling at once, so a
    // worker aborted alongside this one is a consequence of the failure, not its cause.
    const settled: { readonly worker: string; readonly status: string }[] = [];
    for (const sibling of owner.state.on) {
      if (sibling === task.id) continue;
      const record = yield* attempt("read a sibling worker", () =>
        runtime.getTask(sibling, context),
      );
      const outcome = record?.state.outcome;
      if (outcome !== undefined && outcome.status !== "completed")
        settled.push({
          worker: workerIdOf(record?.input) ?? String(sibling),
          status: outcome.status,
        });
    }
    const cause =
      settled.find((each) => each.status !== "aborted") ?? settled[0];
    return cause === undefined
      ? plain
      : `${plain}: the worker "${cause.worker}" settled ${cause.status} and the mission joins its workers failFast`;
    // The reason is a courtesy; the abort is not. A read that fails must not keep it uncommitted.
  }).pipe(Effect.orElseSucceed(() => plain));
};

/**
 * One worker: open a conversation, talk in it, check the result.
 *
 * Abort settles `aborted` with the reason the abort came from (`abortReason`), so the aborted worker
 * — not only the mission that waited on it — says why it stopped.
 */
export const MissionWorkerTask = defineTask<
  MissionWorkerInput,
  MissionWorkerState,
  MissionWorkerResult
>({
  name: MISSION_WORKER_TASK_NAME,
  version: MISSION_WORKER_VERSION,
  initial: () => ({ phase: "open" }),
  phases: {
    // The conversation and the checkpoint that names it are one commit, so a worker never owns a
    // conversation it cannot find again, and a rerun of this phase after a crash creates none. The
    // mission's roster names the conversation in the same commit (LOB-194): it is how a read of the
    // log finds the ledger this worker's spend is in, with nothing held in a process.
    open: (task, runtime, context) =>
      runtime.commit(
        (tx) =>
          tx
            .createConversation({
              ownership: { kind: "task", taskId: runtime.taskId },
            })
            .then((conversation) =>
              nameConversation(
                tx,
                task.owner,
                runtime,
                task.input.worker.id,
                conversation.id,
              ).then((): WorkerNext => ({
                status: "running",
                checkpoint: {
                  phase: "converse",
                  conversationId: conversation.id,
                },
              })),
            ),
        context,
      ),
    converse: (task, runtime, context) => {
      const { worker } = task.input;
      const { conversationId } = task.state.checkpoint;
      return Effect.runPromise(
        Effect.gen(function* () {
          const conversation = yield* Effect.promise(() =>
            runtime.conversation(conversationId, context),
          );
          if (conversation === undefined)
            return failed(
              `the worker "${worker.id}" lost its conversation ${String(conversationId)}`,
              { worker: worker.id, reason: "no-conversation" },
            );
          // The request id makes the send idempotent: a rerun of this phase after a crash finds the
          // submission it already admitted instead of asking twice.
          const submission = yield* Effect.promise(() =>
            conversation.submit(
              {
                type: "input",
                content: worker.prompt,
                requestId: workerRequestId(runtime.taskId),
              },
              context,
            ),
          );
          const settled = yield* Effect.promise(() => submission.wait(context));
          if (settled.status === "unanswered")
            return failed(
              `the worker "${worker.id}" was not answered: ${settled.reason}`,
              { worker: worker.id, reason: "unanswered", why: settled.reason },
            );
          const next: WorkerNext =
            worker.check === undefined
              ? {
                  status: "terminal",
                  outcome: {
                    status: "completed",
                    result: { worker: worker.id, conversationId },
                  },
                }
              : {
                  status: "running",
                  checkpoint: { phase: "check", conversationId },
                };
          return next;
        }),
      ).then((next) => runtime.commit(() => next, context));
    },
    check: (task, runtime, context) => {
      const { worker, workspace } = task.input;
      const { conversationId } = task.state.checkpoint;
      const command = worker.check;
      return Effect.runPromise(
        Effect.gen(function* () {
          // A `check` checkpoint is only ever committed for a worker that declares a command; one
          // that does not has nothing to check and is complete.
          if (command === undefined) {
            const done: WorkerNext = {
              status: "terminal",
              outcome: {
                status: "completed",
                result: { worker: worker.id, conversationId },
              },
            };
            return done;
          }
          const ran = yield* runCommand(
            (invocation) => runtime.env(invocation),
            command,
            workspace.path,
            context,
          );
          switch (ran._tag) {
            case "no-environment":
              return failed(
                `the worker "${worker.id}" cannot check: ${ran.message}`,
                {
                  worker: worker.id,
                  reason: "no-environment",
                  message: ran.message,
                },
              );
            case "exec-error":
              return failed(
                `the worker "${worker.id}"'s check could not run: ${ran.message}`,
                {
                  worker: worker.id,
                  reason: "exec-error",
                  command,
                  message: ran.message,
                },
              );
            case "exited":
              return ran.exitCode === 0
                ? ({
                    status: "terminal",
                    outcome: {
                      status: "completed",
                      result: {
                        worker: worker.id,
                        conversationId,
                        check: { command, exitCode: ran.exitCode },
                      },
                    },
                  } satisfies WorkerNext)
                : failed(
                    `the worker "${worker.id}" failed its check: \`${command}\` exited ${ran.exitCode}`,
                    {
                      worker: worker.id,
                      reason: "check-failed",
                      command,
                      exitCode: ran.exitCode,
                    },
                  );
          }
        }),
      ).then((next) => runtime.commit(() => next, context));
    },
  },
  abort: (task, runtime, context) =>
    Effect.runPromise(abortReason(task, runtime, context)).then((reason) =>
      runtime.commit(
        () => ({
          status: "terminal" as const,
          outcome: { status: "aborted" as const, reason },
        }),
        context,
      ),
    ),
});
