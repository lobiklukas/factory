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
 * What plan and implement do is the later parts' — LOB-230 starts a mission over the RPC client and
 * reads its phase, LOB-231 resumes one — and a phase ends at a pushed branch: opening the PR
 * belongs to the session's PR step (`prStep.ts`, LOB-177), not to a phase. Verify is therefore the
 * one phase with work to do here, and it is the repo's own: the `verify` command the workspace the
 * session resolved declares, run in that workspace.
 *
 * Everything this module hands back across the Pi Durable Promise boundary is an Effect, like the
 * rest of the harness.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  NextTaskState,
  TaskId,
  TaskRuntime,
} from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { Effect, Schema } from "effect";
import {
  MISSION_PHASES,
  MISSION_VERSION,
  MissionPhase,
  readMissionDoc,
} from "@repo/domain/Mission";
import { SessionWorkspace, type SessionError } from "@repo/domain/Session";
import { MissionBindingDoc, MissionDoc } from "./docs";
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
});
export type MissionInput = typeof MissionInput.Type;

/** Where a mission is: the phase its checkpoint names. */
export const MissionState = Schema.Struct({ phase: MissionPhase });
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

/** What a completed mission did, as its terminal result records it. */
export type MissionResult = {
  readonly feature: string;
  readonly verify: { readonly command: string; readonly exitCode: number };
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
 */
const enterPhase = (
  runtime: MissionRuntime,
  phase: MissionPhase,
  next: MissionNext,
  context: Context,
): Promise<void> =>
  runtime.commit(
    (tx) =>
      tx
        .doc(
          MissionDoc,
          runtime.conversationId,
          missionKey(runtime.taskId),
          missionKey(runtime.taskId),
        )
        .then((doc) => {
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
    // Both calls reject on failure; a rejection is a reason the mission could not verify, so it
    // becomes a typed outcome rather than a throw out of the phase.
    const env = yield* Effect.result(
      attempt("open the execution environment", () => runtime.env(context)),
    );
    if (env._tag === "Failure") {
      return failed(
        `the mission over "${input.feature}" cannot verify: ${env.failure.message}`,
        { phase: "verify", reason: "no-environment" },
      );
    }
    const environment = env.success;
    if (environment === undefined) {
      return failed(
        `the mission over "${input.feature}" cannot verify: the session has no execution environment`,
        { phase: "verify", reason: "no-environment" },
      );
    }
    const ran = yield* Effect.result(
      attempt("run the verify command", () =>
        environment.exec(command, { cwd: path }, context),
      ),
    );
    if (ran._tag === "Failure") {
      const { message } = ran.failure;
      return failed(`the verify command could not run: ${message}`, {
        phase: "verify",
        reason: "exec-error",
        command,
        message,
      });
    }
    if (!ran.success.ok) {
      const { message } = ran.success.error;
      return failed(`the verify command could not run: ${message}`, {
        phase: "verify",
        reason: "exec-error",
        command,
        message,
      });
    }
    const { exitCode } = ran.success.value;
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
        result: { feature: input.feature, verify: { command, exitCode } },
      },
    };
  });

/**
 * One mission: plan, implement, verify, as one task.
 *
 * `initial` is `plan`, so a mission that is created and never scheduled is a mission that has not
 * started planning; the phases advance their checkpoint and commit their document together. Abort
 * settles `aborted` and leaves the document alone: the phase it died in is what a resume reads.
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
    // Plan and implement are checkpoints in this part: the phases' own work is LOB-230's and
    // LOB-231's, and what the mission commits here is the phase it reached.
    plan: (_task, runtime, context) =>
      enterPhase(
        runtime,
        "plan",
        { status: "running", checkpoint: { phase: "implement" } },
        context,
      ),
    implement: (_task, runtime, context) =>
      enterPhase(
        runtime,
        "implement",
        { status: "running", checkpoint: { phase: "verify" } },
        context,
      ),
    verify: (task, runtime, context) =>
      // The document already says `verify` — implement's commit named it — and the terminal
      // outcome commits it again, so a verify that settles `failed` still names the phase it
      // failed in.
      Effect.runPromise(
        Effect.gen(function* () {
          const next = yield* runVerify(runtime, task.input, context);
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
