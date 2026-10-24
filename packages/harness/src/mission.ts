/**
 * A mission: one feature taken through three durable phases inside a session (LOB-229, part 1 of
 * LOB-192).
 *
 * The phases are Pi Durable task states rather than an Effect pipeline, because the mission's
 * progress has to be a committed checkpoint: a process that dies mid-phase leaves a task the
 * harness resumes in the phase it died in, and a reopen reads the phase the mission reached out of
 * the log instead of out of a caller's memory. Each phase entry commits the `factory.mission`
 * document *and* the checkpoint that follows it in one commit (`enterPhase`), so the two can never
 * disagree.
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
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  NextTaskState,
  TaskId,
  TaskRuntime,
} from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { SessionError, SessionWorkspace } from "@repo/domain/Session";
import { MissionDoc } from "./docs";
import { attempt, type Harness } from "./session";

/** The phases a mission passes through, in the order it passes through them. */
export const MISSION_PHASES = ["plan", "implement", "verify"] as const;
export type MissionPhase = (typeof MISSION_PHASES)[number];

/**
 * The definition version, recorded in every document the mission commits and pinned by the task
 * record. The document names it because a checkpoint is read back through the definition (and its
 * `migrate`, once there is one) that wrote it.
 */
export const MISSION_VERSION = 1;

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
export type MissionInput = {
  readonly feature: string;
  readonly workspace: Pick<
    SessionWorkspace,
    "path" | "commands" | "commandsSource"
  >;
};

/** Where a mission is: the phase its checkpoint names. */
export type MissionState = { readonly phase: MissionPhase };

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
 * Commit one phase entry: the document that names the phase, and the state the mission moves to.
 *
 * One commit for both, not two: a document that says `implement` while the checkpoint still says
 * `plan` is a reopen that resumes the wrong phase. Called by every phase, including verify on its
 * way to a terminal outcome, so the document always names the phase the mission last entered even
 * when that phase is also the one that failed.
 *
 * `entered` grows only when the phase is a new one, so a phase the harness resumes appends nothing
 * and the list stays "each phase the mission entered" rather than "each commit it took".
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
          const entered = doc.entered;
          // Re-entering the phase the mission is already in is the same entry, not a second one: a
          // phase the harness resumes after a crash must not read as a phase the mission passed
          // through twice.
          if (entered[entered.length - 1] !== phase)
            doc.entered = [...entered, phase];
          doc.phase = phase;
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
      // The document commit and the terminal outcome are one commit, so a verify that settles
      // `failed` still names the phase it failed in.
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
  readonly definitionVersion: number;
  /** Every phase the mission entered, in the order it entered them. */
  readonly entered: readonly MissionPhase[];
};

const isMissionPhase = (value: string): value is MissionPhase =>
  (MISSION_PHASES as readonly string[]).includes(value);

/**
 * Read the mission back from the log — the answer a reopen needs, so a fresh process resumes the
 * phase the mission reached rather than the phase a caller remembers.
 *
 * A mission is named by the conversation it runs in and its own task id, so a conversation holding
 * two missions has two documents and each reads back only its own. `undefined` means this mission has
 * not entered a phase: either the document was never written or it still holds its seed. A renamed or foreign phase reads the same way, because
 * a phase this definition does not know is not a phase it can resume; in `entered` such a value is
 * dropped rather than guessed at, and the phase the mission is in is the one that decides.
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
    if (doc === undefined || !isMissionPhase(doc.phase)) return undefined;
    return {
      phase: doc.phase,
      definitionVersion: doc.definitionVersion,
      entered: doc.entered.filter(isMissionPhase),
    };
  });
