/**
 * A mission: one feature taken through three durable phases inside a session (LOB-229, part 1 of
 * LOB-192).
 *
 * The phases are Pi Durable task states rather than an Effect pipeline, because the mission's
 * progress has to be a committed checkpoint: a process that dies mid-phase leaves a task the
 * harness resumes in the phase it died in, and a reopen reads the phase the mission reached out of
 * the log instead of out of a caller's memory. Each phase commits the `factory.mission` document
 * *and* the checkpoint that follows it in one commit (`enterPhase`), and the document names the
 * phase that checkpoint is in, so the two can never disagree.
 *
 * What plan does is a later part's — LOB-230 starts a mission over the RPC client and reads its
 * phase, LOB-231 resumes one — and a phase ends at a pushed branch: opening the PR belongs to the
 * session's PR step (`prStep.ts`, LOB-177), not to a phase. Verify runs the repo's own `verify`
 * command, the one the workspace the session resolved declares, in that workspace.
 *
 * Implement is the fan-out (LOB-193): a mission started with workers creates one child task per
 * worker (`mission-worker.ts`), each talking in a conversation it owns, and parks on all of them
 * under a join policy. `failFast` — the default — lets Pi Durable abort the workers still running
 * the moment one settles other than `completed`; `allSettled` lets them finish. Either way the join
 * settles the mission `failed` when any worker did not complete, naming each worker's outcome, and
 * moves on to verify only when every one did. A mission started without workers passes through
 * implement as a checkpoint, as it did before.
 *
 * Everything this module hands back across the Pi Durable Promise boundary is an Effect, like the
 * rest of the harness.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  JoinPolicy,
  NextTaskState,
  RunningTask,
  TaskId,
  TaskOutcome,
  TaskRuntime,
  Tx,
} from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { Effect, Schema } from "effect";
import {
  MISSION_PHASES,
  MISSION_VERSION,
  MissionJoin,
  MissionPhase,
  readMissionDoc,
} from "@repo/domain/Mission";
import { SessionWorkspace, type SessionError } from "@repo/domain/Session";
import { MissionBindingDoc, MissionDoc } from "./docs";
import {
  MissionWorker,
  MissionWorkerTask,
  runCommand,
  type MissionWorkerResult,
} from "./mission-worker";
import {
  attempt,
  missionCheckpoint,
  type Harness,
  type LiveSession,
} from "./session";

/**
 * The phases a mission passes through, in the order it passes through them.
 *
 * The list itself lives in `@repo/domain/Mission`, because the wire has to accept exactly the
 * phases the task can enter; this re-export keeps `@repo/harness` the place a caller names them.
 */
export { MISSION_PHASES, type MissionPhase };

/**
 * The definition version, recorded in every document the mission commits and pinned by the task
 * record. The document names it because a document is read back through the definition that wrote
 * it: version 1's document lagged its checkpoint by one phase, and `readMissionDoc` reads such a
 * document forward (LOB-233). The number itself lives in `@repo/domain/Mission`, beside that table.
 */
export { MISSION_VERSION };

/** The task kind a mission registers under: one mission is one task. */
export const MISSION_TASK_NAME = "factory.mission";

/**
 * The document a mission owns, keyed by its task id: a conversation holds several missions, and each
 * one's phase record is its own.
 */
export const missionKey = (taskId: TaskId): string => String(taskId);

/**
 * What a mission is started with: the feature it takes through the phases, and the workspace the
 * session resolved for it.
 *
 * The workspace is input rather than something the task looks up, because a task may own its own
 * conversation and nothing else: the session that started the mission already resolved the
 * checkout, and `commands`/`commandsSource` are what the verify phase runs — or what it reports it
 * could not run. `commandsSource` is the load-bearing half: a repo that declares no config at all
 * and one that declares a config without a `verify` command both leave `commands.verify`
 * undefined, and only the source says which of the two happened.
 */
export const MissionInput = Schema.Struct({
  feature: Schema.String,
  workspace: Schema.Struct({
    path: SessionWorkspace.fields.path,
    commands: SessionWorkspace.fields.commands,
    commandsSource: SessionWorkspace.fields.commandsSource,
  }),
  /**
   * The independent subtasks implement fans out to, one worker task and one owned conversation
   * each (LOB-193). Absent or empty: implement is a checkpoint and nothing fans out.
   */
  workers: Schema.optional(Schema.Array(MissionWorker)),
  /**
   * How the join treats a worker that settles other than `completed`: `failFast` (the default)
   * aborts the workers still running, `allSettled` lets them finish. The mission fails either way.
   */
  join: Schema.optional(MissionJoin),
});
export type MissionInput = typeof MissionInput.Type;

/** The join policy a mission's fan-out parks under when its input names none. */
export const DEFAULT_MISSION_JOIN: JoinPolicy = "failFast";

/** A task id as a checkpoint stores it: Pi Durable's ids are non-negative integers on the wire. */
const StoredWorkerId = Schema.declare(
  (value: unknown): value is TaskId<MissionWorkerResult> =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
);

/**
 * Where a mission is: the phase its checkpoint names, and — from the fan-out on — the worker tasks
 * implement created, in the order of the input's `workers`. Implement's own checkpoint carries them
 * while the mission waits, which is how the phase tells "fan out" from "join" when it runs again.
 */
export const MissionState = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("plan") }),
  Schema.Struct({
    phase: Schema.Literal("implement"),
    workers: Schema.optional(Schema.Array(StoredWorkerId)),
  }),
  Schema.Struct({
    phase: Schema.Literal("verify"),
    workers: Schema.optional(Schema.Array(StoredWorkerId)),
  }),
]);
export type MissionState = typeof MissionState.Type;

const decodeInput = Schema.decodeUnknownSync(MissionInput);
const decodeState = Schema.decodeUnknownSync(MissionState);

/**
 * Carry a task record an older definition stored into this one; Pi Durable runs it when it reserves
 * the task, and a newer definition with no `migrate` would leave every live older mission blocked.
 *
 * Version 1 → 2 changed what the *document* records (LOB-233), not the input or the checkpoint: the
 * checkpoint always named the phase the mission is in, so a v1 mission resumes in the phase it died
 * in, and that phase's commit rewrites the document under this definition. Both are decoded rather
 * than cast, so a record that is not a mission's throws here — which Pi Durable records as a failed
 * migration and leaves the task blocked, rather than handing a phase handler a shape it cannot run.
 */
const migrateRecord = (
  input: JsonValue,
  checkpoint: JsonValue,
): { input: MissionInput; checkpoint: MissionState } => ({
  input: decodeInput(input),
  checkpoint: decodeState(checkpoint),
});

/** One worker of a completed mission: its id, its task, and the conversation it talked in. */
export type MissionWorkerRecord = {
  readonly id: string;
  readonly taskId: string;
  readonly conversationId: string;
};

/** What a completed mission did, as its terminal result records it. */
export type MissionResult = {
  readonly feature: string;
  readonly verify: { readonly command: string; readonly exitCode: number };
  /** Every worker the mission fanned out to, in input order; absent when it fanned out to none. */
  readonly workers?: MissionWorkerRecord[];
};

/** How one worker settled, as the join that read it records it. */
export type MissionWorkerOutcome = {
  readonly id: string;
  readonly taskId: string;
  readonly status: TaskOutcome<unknown>["status"];
  /** The worker's error message, or its abort reason, when it did not complete. */
  readonly message?: string;
};

/**
 * Why a mission settled `failed`, committed as the outcome's `detail` so an operator reads the
 * phase and the reason off the log rather than off a message.
 *
 * A union of reasons rather than a bag of optional fields, because each reason has its own facts: a
 * command that exited non-zero has an exit code and one that could not be spawned does not.
 */
export type MissionFailureDetail =
  | {
      readonly phase: MissionPhase;
      readonly reason: "no-verify-command";
      readonly commandsSource: "repo" | "none";
    }
  | {
      readonly phase: MissionPhase;
      readonly reason: "no-environment";
    }
  | {
      readonly phase: MissionPhase;
      readonly reason: "verify-failed";
      readonly command: string;
      readonly exitCode: number;
    }
  | {
      readonly phase: MissionPhase;
      readonly reason: "exec-error";
      readonly command: string;
      readonly message: string;
    }
  | {
      readonly phase: MissionPhase;
      readonly reason: "duplicate-worker";
      readonly worker: string;
    }
  | {
      readonly phase: MissionPhase;
      readonly reason: "worker-failed";
      readonly join: JoinPolicy;
      readonly workers: MissionWorkerOutcome[];
    };

/** The next state a phase commits; every phase here either advances or settles the mission. */
type MissionNext = NextTaskState<MissionState, MissionResult>;

/** The runtime a mission's phase handlers are handed: the task declares no hooks. */
type MissionRuntime = TaskRuntime<
  MissionInput,
  MissionState,
  MissionResult,
  object
>;

/** A mission that settled `failed`, with the phase and the reason in its committed detail. */
const failed = (
  message: string,
  detail: MissionFailureDetail,
): MissionNext => ({
  status: "terminal",
  outcome: { status: "failed", error: { message, detail } },
});

/**
 * Commit the end of one phase: the state the mission moves to, and the document that names it.
 *
 * The document names the phase the checkpoint is *entering* — `next`'s phase when the mission moves
 * on, the running phase when it settles — because that is the phase a resume continues from. Naming
 * the phase whose handler ran instead (version 1, LOB-233) left the document one phase behind its
 * own checkpoint for as long as the next phase ran, so a client reading it after a kill was told a
 * phase the reopened harness would not continue from. One commit for both, not two: a document
 * written after the checkpoint is a moment at which the two disagree. Called by every phase,
 * including verify on its way to a terminal outcome, so a mission that settles `failed` still names
 * the phase it failed in.
 *
 * `entered` records the running phase and then the entered one, each only when it is not already
 * the last entry: a mission created without the start's seed still lists `plan`, a phase the
 * harness resumes appends nothing, and the list stays "each phase the mission entered" rather than
 * "each commit it took".
 *
 * `change` is the next state, or a function that writes what the phase creates — the fan-out's
 * worker tasks — in the same transaction and answers the next state, so the workers, the wait on
 * them and the document are one commit too.
 */
const enterPhase = (
  runtime: MissionRuntime,
  phase: MissionPhase,
  change: MissionNext | ((tx: Tx) => Promise<MissionNext>),
  context: Context,
): Promise<void> =>
  runtime.commit(
    (tx) =>
      (typeof change === "function" ? change(tx) : Promise.resolve(change))
        .then((next) =>
          tx
            .doc(
              MissionDoc,
              runtime.conversationId,
              missionKey(runtime.taskId),
              missionKey(runtime.taskId),
            )
            .then((doc) => ({ next, doc })),
        )
        .then(({ next, doc }) => {
          const entering =
            next.status === "terminal" ? phase : next.checkpoint.phase;
          // Re-entering the phase the mission is already in is the same entry, not a second one: a
          // phase the harness resumes after a crash must not read as a phase the mission passed
          // through twice.
          let entered = doc.entered;
          for (const each of [phase, entering])
            if (entered[entered.length - 1] !== each)
              entered = [...entered, each];
          if (entered !== doc.entered) doc.entered = entered;
          doc.phase = entering;
          doc.definitionVersion = MISSION_VERSION;
          return next;
        }),
    context,
  );

/**
 * The verify phase's work: run the workspace's `verify` command, or settle `failed` with the reason
 * it cannot.
 *
 * Every way this can go wrong is a value this function returns, not a throw: a phase that throws
 * settles the *task* `faulted`, which says the harness broke rather than that the feature did not
 * verify. That covers the repo declaring no command at all (the acceptance's `commandsSource` of
 * `none`), a session with no execution environment, a command that cannot be spawned, and a command
 * that exits non-zero — a mission that cannot verify has not verified, so all four are `failed`.
 */
const runVerify = (
  runtime: MissionRuntime,
  input: MissionInput,
  workers: MissionWorkerRecord[] | undefined,
  context: Context,
): Effect.Effect<MissionNext> =>
  Effect.gen(function* () {
    const { commands, commandsSource, path } = input.workspace;
    const command = commands.verify;
    if (command === undefined) {
      return failed(
        `the mission over "${input.feature}" cannot verify: the workspace declares no verify command`,
        { phase: "verify", reason: "no-verify-command", commandsSource },
      );
    }
    const ran = yield* runCommand(
      (invocation) => runtime.env(invocation),
      command,
      path,
      context,
    );
    switch (ran._tag) {
      case "no-environment":
        return failed(
          `the mission over "${input.feature}" cannot verify: ${ran.message}`,
          { phase: "verify", reason: "no-environment" },
        );
      case "exec-error":
        return failed(`the verify command could not run: ${ran.message}`, {
          phase: "verify",
          reason: "exec-error",
          command,
          message: ran.message,
        });
      case "exited":
        break;
    }
    const { exitCode } = ran;
    if (exitCode !== 0) {
      return failed(
        `the mission over "${input.feature}" failed in verify: \`${command}\` exited ${exitCode}`,
        { phase: "verify", reason: "verify-failed", command, exitCode },
      );
    }
    return {
      status: "terminal",
      outcome: {
        status: "completed",
        result: {
          feature: input.feature,
          verify: { command, exitCode },
          ...(workers === undefined ? {} : { workers }),
        },
      },
    };
  });

/** The first worker id two of `workers` share, or `undefined` when every id is its own. */
const duplicateWorker = (
  workers: readonly MissionWorker[],
): string | undefined => {
  const seen = new Set<string>();
  for (const { id } of workers) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
};

/**
 * The fan-out, inside implement's commit: one worker task per input worker, owned by the mission,
 * and the wait on all of them under the mission's join policy.
 *
 * Owned by the mission task rather than by its conversation, because ownership is what the abort
 * wiring runs on: Pi Durable only lets a task wait `failFast` on tasks it owns, and a task's abort
 * reaches the work it owns first. The checkpoint the wait resumes at is implement again, carrying
 * the worker ids, so the phase's next run is the join.
 */
const fanOut =
  (
    runtime: MissionRuntime,
    input: MissionInput,
    workers: readonly MissionWorker[],
  ) =>
  (tx: Tx): Promise<MissionNext> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ids: TaskId<MissionWorkerResult>[] = [];
        // One at a time: each creation is a write on the same transaction.
        for (const worker of workers)
          ids.push(
            yield* Effect.promise(() =>
              tx.createTask(
                MissionWorkerTask,
                { worker, workspace: { path: input.workspace.path } },
                { ownership: { kind: "task", taskId: runtime.taskId } },
              ),
            ),
          );
        const next: MissionNext = {
          status: "waiting",
          checkpoint: { phase: "implement", workers: ids },
          on: ids,
          policy: input.join ?? DEFAULT_MISSION_JOIN,
        };
        return next;
      }),
    );

/** How one worker's outcome reads in the join's record. */
const workerOutcome = (
  id: string,
  taskId: TaskId<MissionWorkerResult>,
  outcome: TaskOutcome<MissionWorkerResult>,
): MissionWorkerOutcome => {
  const message =
    outcome.status === "failed" || outcome.status === "faulted"
      ? outcome.error.message
      : outcome.status === "aborted" || outcome.status === "orphaned"
        ? outcome.reason
        : undefined;
  return {
    id,
    taskId: String(taskId),
    status: outcome.status,
    ...(message === undefined ? {} : { message }),
  };
};

/**
 * The join: every worker is terminal, so read their outcomes and either move on to verify or settle
 * the mission `failed` with each worker's outcome named.
 *
 * Any outcome other than `completed` fails the mission, whatever the policy: `allSettled` decides
 * whether the other workers get to finish, not whether a mission with a failed subtask may verify.
 */
const join = (
  task: RunningTask<MissionInput, MissionState, MissionResult>,
  runtime: MissionRuntime,
  ids: readonly TaskId<MissionWorkerResult>[],
  context: Context,
): Promise<void> => {
  const workers = task.input.workers ?? [];
  return runtime
    .outcomes<MissionWorkerResult>(ids, context)
    .then((outcomes) => {
      const settled = ids.map((taskId, index) =>
        workerOutcome(
          workers[index]?.id ?? String(taskId),
          taskId,
          outcomes[index] ?? {
            status: "orphaned",
            reason: "the worker has no outcome",
          },
        ),
      );
      const failures = settled.filter((each) => each.status !== "completed");
      const policy = task.input.join ?? DEFAULT_MISSION_JOIN;
      const next: MissionNext =
        failures.length === 0
          ? {
              status: "running",
              checkpoint: { phase: "verify", workers: [...ids] },
            }
          : failed(
              `the mission over "${task.input.feature}" failed in implement: ${failures
                .map((each) => `worker "${each.id}" ${each.status}`)
                .join(", ")}`,
              {
                phase: "implement",
                reason: "worker-failed",
                join: policy,
                workers: settled,
              },
            );
      return enterPhase(runtime, "implement", next, context);
    });
};

/** The workers a completed mission reports: each one's id, task and owned conversation. */
const workerRecords = (
  input: MissionInput,
  ids: readonly TaskId<MissionWorkerResult>[] | undefined,
  runtime: MissionRuntime,
  context: Context,
): Promise<MissionWorkerRecord[] | undefined> => {
  if (ids === undefined) return Promise.resolve(undefined);
  const workers = input.workers ?? [];
  return runtime.outcomes<MissionWorkerResult>(ids, context).then((outcomes) =>
    ids.map((taskId, index) => {
      const outcome = outcomes[index];
      return {
        id: workers[index]?.id ?? String(taskId),
        taskId: String(taskId),
        conversationId:
          outcome?.status === "completed"
            ? String(outcome.result.conversationId)
            : "",
      };
    }),
  );
};

/**
 * One mission: plan, implement, verify, as one task.
 *
 * `initial` is `plan`, so a mission that is created and never scheduled is a mission that has not
 * started planning; the phases advance their checkpoint and commit their document together. Abort
 * settles `aborted` and leaves the document alone: the phase it died in is what a resume reads. A
 * mission aborted while it waits on its workers aborts them first — Pi Durable runs abort bottom-up
 * — so its own abort runs once no worker is live.
 */
export const MissionTask = defineTask<
  MissionInput,
  MissionState,
  MissionResult
>({
  name: MISSION_TASK_NAME,
  version: MISSION_VERSION,
  initial: () => ({ phase: "plan" }),
  migrate: migrateRecord,
  phases: {
    // Plan is a checkpoint in this part: its own work is a later part's, and what the mission
    // commits here is the phase it reached.
    plan: (_task, runtime, context) =>
      enterPhase(
        runtime,
        "plan",
        { status: "running", checkpoint: { phase: "implement" } },
        context,
      ),
    implement: (task, runtime, context) => {
      // Implement runs twice when it fans out: once to create the workers and wait on them, and
      // once more, at the checkpoint the wait names, to join them.
      const joining = task.state.checkpoint.workers;
      if (joining !== undefined) return join(task, runtime, joining, context);
      const workers = task.input.workers ?? [];
      if (workers.length === 0)
        return enterPhase(
          runtime,
          "implement",
          { status: "running", checkpoint: { phase: "verify" } },
          context,
        );
      const duplicate = duplicateWorker(workers);
      if (duplicate !== undefined)
        return enterPhase(
          runtime,
          "implement",
          failed(
            `the mission over "${task.input.feature}" cannot fan out: two workers are named "${duplicate}"`,
            {
              phase: "implement",
              reason: "duplicate-worker",
              worker: duplicate,
            },
          ),
          context,
        );
      return enterPhase(
        runtime,
        "implement",
        fanOut(runtime, task.input, workers),
        context,
      );
    },
    verify: (task, runtime, context) =>
      // The document already says `verify` — implement's commit named it — and the terminal
      // outcome commits it again, so a verify that settles `failed` still names the phase it
      // failed in.
      Effect.runPromise(
        Effect.gen(function* () {
          const workers = yield* Effect.promise(() =>
            workerRecords(
              task.input,
              task.state.checkpoint.workers,
              runtime,
              context,
            ),
          );
          const next = yield* runVerify(runtime, task.input, workers, context);
          yield* Effect.promise(() =>
            enterPhase(runtime, "verify", next, context),
          );
        }),
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(
      () => ({
        status: "terminal" as const,
        outcome: { status: "aborted" as const },
      }),
      context,
    ),
});

/**
 * Every task kind a mission runs: the mission and the workers it fans out to. A registry that ran
 * the mission without its workers would leave each worker blocked on a missing definition and the
 * mission waiting on them for good, so the two are installed together.
 */
export const MISSION_TASKS = [MissionTask, MissionWorkerTask] as const;

/** The phase a mission reached, as its log records it. */
export type MissionRecord = {
  /** The phase the mission is in — what a resume reads. */
  readonly phase: MissionPhase;
  /** The definition version that wrote the document; its phase is already read forward from it. */
  readonly definitionVersion: number;
  /** Every phase the mission entered, in the order it entered them. */
  readonly entered: readonly MissionPhase[];
};

/**
 * Read the mission back from the log — the answer a reopen needs, so a fresh process resumes the
 * phase the mission reached rather than the phase a caller remembers.
 *
 * A mission is named by the conversation it runs in and its own task id, so a conversation holding
 * two missions has two documents and each reads back only its own. `undefined` means this mission has
 * not entered a phase: either the document was never written or it still holds its seed. A renamed
 * or foreign phase reads the same way, because a phase this definition does not know is not a phase
 * it can resume; in `entered` such a value is dropped rather than guessed at, and the phase the
 * mission is in is the one that decides. A document an older definition wrote is read through
 * `readMissionDoc`, the same reader the session snapshot uses, with the task's own checkpoint when
 * the task is still live — the one witness that tells a v1 seed (`plan`) from a v1 plan commit
 * (`implement`), which the two documents cannot — and forward through the version table otherwise.
 */
export const readMission = (
  harness: Harness,
  conversationId: ConversationId,
  taskId: TaskId,
): Effect.Effect<MissionRecord | undefined, SessionError> =>
  Effect.gen(function* () {
    const doc = yield* attempt("read mission", () =>
      harness.snapshot(
        MissionDoc,
        conversationId,
        missionKey(taskId),
        BACKGROUND_CONTEXT,
      ),
    );
    if (doc === undefined) return undefined;
    const checkpoint = yield* missionCheckpoint(
      harness,
      taskId,
      doc.definitionVersion,
    );
    const record = readMissionDoc(doc, checkpoint);
    if (record === undefined) return undefined;
    return { ...record, definitionVersion: doc.definitionVersion };
  });

/**
 * Start one mission in a session's conversation (LOB-230), and answer the id it was given.
 *
 * The commit is the whole of creation: the task, the mission's own document, and the binding that
 * names this mission as the session's current one are written together, so there is no moment at
 * which a mission exists but cannot be read, or is bound but does not exist. The document says
 * `plan` from the start because that *is* the phase the new task is in — `MissionTask.initial` is
 * the same checkpoint — so a client that reads the snapshot between the start and the first phase
 * run is told the truth rather than nothing. `enterPhase` is the only writer afterwards, and it
 * appends nothing when the phase it enters is the one already recorded.
 *
 * Scheduling is not a side effect of a commit: Pi Durable enables it with `Harness.resume()`, which
 * only the calls that ask for progress enable themselves. A mission created by a caller that just
 * commits would sit `pending` forever, so the start enables it here, once.
 *
 * The workspace the mission runs verify in is the input's, resolved by the control plane from the
 * session (`SessionService.startMission`): a task owns its conversation and nothing else, so it
 * cannot go and look up a checkout.
 */
export const startMission = (
  session: LiveSession,
  input: MissionInput,
): Effect.Effect<string, SessionError> =>
  Effect.gen(function* () {
    const taskId = yield* attempt("start mission", () =>
      session.root.commit(
        (tx) =>
          tx
            .createTask(MissionTask, input, {
              ownership: { kind: "conversation" },
            })
            .then((id) => {
              const key = missionKey(id);
              // Both documents are written in the same commit as the task, so there is no moment
              // at which a mission exists but cannot be read, or is bound but does not exist.
              return Promise.all([
                tx.doc(MissionDoc, session.root.id, key, key),
                tx.doc(MissionBindingDoc, session.root.id),
              ]).then(([mission, binding]) => {
                mission.mission = key;
                mission.phase = MISSION_PHASES[0];
                mission.definitionVersion = MISSION_VERSION;
                mission.entered = [MISSION_PHASES[0]];
                binding.taskId = key;
                return id;
              });
            }),
        BACKGROUND_CONTEXT,
      ),
    );
    session.harness.resume();
    return missionKey(taskId);
  });
