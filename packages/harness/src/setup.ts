/**
 * A worktree's setup: the repo's declared `install`, then its `build`, run in the session's own
 * environment before the agent's first turn (docs/features.md §3 A1, D13).
 *
 * A worktree `git worktree add` just cut holds the repo's tracked files and nothing else: no
 * `node_modules`, no generated code, no build output. A run that starts there spends its first turns
 * guessing how to install the repo, and a declared `verify` fails until it has. The repo already said
 * how — `.factory/config`'s `install` and `build`, which until now only the readiness of the config
 * file was read for — so the control plane runs them, through the same `ExecutionEnv` the run's
 * tools get (`./environment`), so a sandbox that takes the tools over takes the setup over with them.
 *
 * What it records is one typed document in the log, `factory.setup`: every step that ran, its exit
 * code and a bounded tail of its output (`VERIFY_OUTPUT_TAIL`, the bound a verification keeps), and
 * whether the whole setup succeeded. The control plane reads it back before every first turn: a log
 * whose setup succeeded runs nothing again, and one whose setup failed runs it again, because a
 * failed setup submitted nothing and the next attempt is the operator's retry. A success is for the
 * worktree it ran in, named by the cut that made it (`cut`, F23): a worktree cut again — its
 * directory went missing — has none of what the install put there, so the control plane runs the
 * setup again for it.
 *
 * Steps stop at the first failure: a build after a failed install would only fail again, more
 * noisily, and bury the cause. A step that could not run to an exit code (spawn failure, timeout) is
 * a failure like a non-zero exit, recorded with its code. Neither throws: the record says what
 * happened, and the caller decides what a failed setup means for the run.
 *
 * The commands get `DATABASE_URL` set to `VERIFY_NO_DATABASE` for the reason a verification does
 * (`./verify`'s "Isolation"): a build that migrates or seeds must never reach the control plane's own
 * database.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  Harness,
  Storage,
} from "@earendil-works/pi-durable";
import { defineDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { RepoCommands, SessionError } from "@repo/domain/Session";
import { DateTime, Effect, Option, Schema } from "effect";
import type { InjectedSecrets } from "./secrets";
import { attempt, readLogDocument } from "./session";
import {
  execToExit,
  runningTail,
  tailOf,
  VERIFY_DATABASE_VARIABLE,
  VERIFY_NO_DATABASE,
} from "./verify";

/** The document a session's setup is recorded in. */
export const SETUP_DOC_KIND = "factory.setup";

/**
 * Whether `record` is a setup of the worktree whose cut is `cut` (F23). A record or a worktree with
 * no cut cannot be told apart from the one it is compared with, so it is trusted: only two cuts
 * that are both named and differ say the worktree was made again since.
 */
export const setupCovers = (
  record: SetupRecord,
  cut: string | undefined,
): boolean =>
  record.cut === undefined || cut === undefined || record.cut === cut;

/** The steps a setup runs, in order: the `.factory/config` fields of the same names. */
export const SETUP_STEPS = ["install", "build"] as const;
export const SetupStepName = Schema.Literals(SETUP_STEPS);
export type SetupStepName = typeof SetupStepName.Type;

/**
 * How long one step may run before it is stopped and recorded as unrunnable (`timeout`). An install
 * on a cold cache and a monorepo build are minutes; an hour is a hang. The bound a verification has.
 */
export const SETUP_TIMEOUT_SECONDS = 1_800;

/**
 * How much of a failed step's output a person is shown where the failure is named — the card's
 * block note, the refused send's message — beside the whole tail the record keeps.
 */
export const SETUP_NOTE_TAIL = { maxChars: 2_000, maxLines: 20 } as const;

/** A step that ran to an exit code, zero or not. */
export const SetupStepRan = Schema.TaggedStruct("SetupStepRan", {
  step: SetupStepName,
  /** The shell text that ran, exactly as `.factory/config` declares it. */
  command: Schema.String,
  exitCode: Schema.Int,
  /** The tail of stdout and stderr, interleaved as they arrived (`VERIFY_OUTPUT_TAIL`). */
  output: Schema.String,
  /** Whether `output` is a tail of something longer. */
  truncated: Schema.Boolean,
});
export type SetupStepRan = typeof SetupStepRan.Type;

/** A step that could not run to an exit code (spawn failure, timeout, a sandbox that refused it). */
export const SetupStepUnrunnable = Schema.TaggedStruct("SetupStepUnrunnable", {
  step: SetupStepName,
  command: Schema.String,
  /** Pi Durable's `ExecutionErrorCode`, or `unknown` when the environment itself rejected. */
  code: Schema.String,
  message: Schema.String,
  output: Schema.String,
  truncated: Schema.Boolean,
});
export type SetupStepUnrunnable = typeof SetupStepUnrunnable.Type;

export const SetupStepResult = Schema.Union([
  SetupStepRan,
  SetupStepUnrunnable,
]);
export type SetupStepResult = typeof SetupStepResult.Type;

/** One setup of one worktree, as the log records it. */
export const SetupRecord = Schema.Struct({
  /** `succeeded`: every declared step exited 0. `failed`: the last step in `steps` did not. */
  outcome: Schema.Literals(["succeeded", "failed"]),
  /** The worktree the steps ran in: the environment's `cwd`. */
  directory: Schema.String,
  /** The steps that ran, in order; a step after a failed one is not run, so it is not here. */
  steps: Schema.mutable(Schema.Array(SetupStepResult)),
  startedAt: Schema.String,
  finishedAt: Schema.String,
  /**
   * The cut of the worktree the steps ran in (F23, `readWorktreeCut`), when it had one: a record
   * for another cut is no setup of this worktree. Absent on a record written before cuts were named,
   * and for a directory that is no cut worktree; neither is ever read as stale.
   */
  cut: Schema.optionalKey(Schema.String),
});
export type SetupRecord = typeof SetupRecord.Type;

/**
 * The session's setup record. `fork: "initial"`: a fork works in a worktree of its own, which no
 * setup has run in, so it does not inherit its parent's.
 */
export const SetupDoc = defineDoc({
  kind: SETUP_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ record: null as JsonValue }),
});

/** The steps `commands` declares, in run order; a blank command is no step. */
export const setupSteps = (
  commands: RepoCommands,
): ReadonlyArray<{ readonly step: SetupStepName; readonly command: string }> =>
  SETUP_STEPS.flatMap((step) => {
    const command = commands[step];
    return command === undefined || command.trim() === ""
      ? []
      : [{ step, command }];
  });

const isoNow = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Run the declared setup in `env`'s working directory: `install`, then `build`, stopping at the first
 * that fails. `undefined` when `commands` declares neither, so a repo that says nothing about its
 * setup costs nothing and records nothing. Never fails: a step that could not run is in the record.
 */
export const runSetup = (input: {
  readonly env: ExecutionEnv;
  readonly commands: RepoCommands;
  /** Overrides `SETUP_TIMEOUT_SECONDS`, per step. */
  readonly timeoutSeconds?: number | undefined;
  /** The cut of the worktree `env` runs in, recorded with the setup (F23). */
  readonly cut?: string | undefined;
  /**
   * The secrets the repo declares for its setup (S-agent-secrets): each step gets them as variables,
   * and its output is masked before it is streamed or recorded.
   */
  readonly secrets?: InjectedSecrets | undefined;
  /** Names the repo declares for its setup that the store holds no value for, said in the output. */
  readonly missingSecrets?: readonly string[] | undefined;
  readonly onOutput?: (text: string) => void;
  readonly context?: Context;
}): Effect.Effect<SetupRecord | undefined> =>
  Effect.gen(function* () {
    const steps = setupSteps(input.commands);
    if (steps.length === 0) return undefined;
    const startedAt = yield* isoNow;
    const secrets = input.secrets ?? [];
    const results: SetupStepResult[] = [];
    for (const { step, command } of steps) {
      const tail = runningTail();
      const onOutput = (text: string) => {
        tail.push(text);
        input.onOutput?.(text);
      };
      input.onOutput?.(`== setup ${step}: ${command}\n`);
      const missing = input.missingSecrets ?? [];
      if (secrets.length > 0 || missing.length > 0) {
        // Names only, into the tail the record keeps, so a step that failed for want of one says so.
        onOutput(
          `== secrets: ${[...secrets.map((secret) => secret.name), ...missing.map((name) => `${name} (declared, not stored)`)].join(", ")}\n`,
        );
      }
      const ran = yield* Effect.result(
        execToExit({
          env: input.env,
          command,
          cwd: input.env.cwd,
          variables: { [VERIFY_DATABASE_VARIABLE]: VERIFY_NO_DATABASE },
          secrets,
          timeoutSeconds: input.timeoutSeconds ?? SETUP_TIMEOUT_SECONDS,
          onOutput,
          context: input.context ?? BACKGROUND_CONTEXT,
        }),
      );
      const { output, truncated } = tail.done();
      const result: SetupStepResult =
        ran._tag === "Failure"
          ? SetupStepUnrunnable.make({
              step,
              command,
              code: ran.failure.code,
              message: ran.failure.message,
              output,
              truncated,
            })
          : SetupStepRan.make({
              step,
              command,
              exitCode: ran.success,
              output,
              truncated,
            });
      results.push(result);
      if (!stepSucceeded(result)) break;
    }
    return {
      outcome: results.every(stepSucceeded) ? "succeeded" : "failed",
      directory: input.env.cwd,
      steps: results,
      startedAt,
      finishedAt: yield* isoNow,
      ...(input.cut === undefined ? {} : { cut: input.cut }),
    } satisfies SetupRecord;
  }).pipe(Effect.withSpan("Setup.run"));

const stepSucceeded = (result: SetupStepResult): boolean =>
  result._tag === "SetupStepRan" && result.exitCode === 0;

/** The step a failed setup stopped at; `undefined` for one that succeeded. */
export const failedStep = (record: SetupRecord): SetupStepResult | undefined =>
  record.steps.find((result) => !stepSucceeded(result));

/**
 * What a failed setup says in one line, and the short tail of the step that failed: the card's block
 * note and the refused send's message are both this, so a person reads the same words in either.
 */
export const setupFailureText = (record: SetupRecord): string => {
  const failed = failedStep(record);
  if (failed === undefined) return "setup succeeded";
  const what =
    failed._tag === "SetupStepRan"
      ? `exited ${failed.exitCode}`
      : `could not run (${failed.code}): ${failed.message}`;
  const tail = tailOf(failed.output, SETUP_NOTE_TAIL);
  const output = tail.output.trimEnd();
  return [
    `setup failed: ${failed.step} \`${failed.command}\` ${what} in ${record.directory}`,
    ...(output === ""
      ? []
      : [
          `${tail.truncated || failed.truncated ? "…(the last lines of its output)\n" : ""}${output}`,
        ]),
  ].join("\n");
};

const decodeRecord = Schema.decodeUnknownOption(SetupRecord);
const encodeRecord = Schema.encodeSync(SetupRecord);

const recordOf = (value: JsonValue | undefined): SetupRecord | undefined =>
  value === undefined || value === null
    ? undefined
    : Option.getOrUndefined(decodeRecord(value));

/** Commit the setup record, replacing any earlier one: the newest attempt is the one that stands. */
export const writeSetupRecord = (
  conversation: Conversation,
  record: SetupRecord,
): Effect.Effect<void, SessionError> =>
  attempt("write setup", () =>
    conversation.commit(
      (tx) =>
        tx.doc(SetupDoc, conversation.id).then((doc) => {
          // The schema's own encoding is plain JSON.
          doc.record = encodeRecord(record);
        }),
      BACKGROUND_CONTEXT,
    ),
  );

/** The setup the owner's log recorded, or `undefined` when none ran (or the record does not decode). */
export const readSetupRecord = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<SetupRecord | undefined, SessionError> =>
  attempt("read setup", () =>
    harness.snapshot(SetupDoc, conversation.id, BACKGROUND_CONTEXT),
  ).pipe(Effect.map((doc) => recordOf(doc?.record)));

/** The same record read without owning the log (`readLogDocument`): for a reader, a test, a drive. */
export const readLoggedSetup = (
  storage: Storage,
): Effect.Effect<SetupRecord | undefined, SessionError> =>
  readLogDocument(storage, SETUP_DOC_KIND).pipe(
    Effect.map((doc) => recordOf(doc?.["record"])),
  );

/**
 * Whether the log's root ever took a submission (any status). A setup runs before the agent's first
 * turn and only then: a session that already worked in its worktree — one opened before setups were
 * run — has set it up itself, and running its install again under a run in progress is not this.
 */
export const rootEverSubmitted = (
  storage: Storage,
): Effect.Effect<boolean, SessionError> =>
  attempt("scan root submissions", () =>
    storage.scanSubmissions(
      { conversationId: ROOT_CONVERSATION_ID },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    ),
  ).pipe(Effect.map((page) => page.items.length > 0));
