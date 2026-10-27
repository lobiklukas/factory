/**
 * The `verify` tool: run the verification for the surfaces a run changed, and record what it said
 * (LOB-78, part 1 of LOB-16).
 *
 * The repo's convention is that a surface is proven by its verify skill (`.pi/skills/verify-<surface>/`,
 * AGENTS.md "Verification is a skill"), and B8 makes a skill's output what a gate checks. Until now
 * nothing in `packages/` could find or run one, so "the run verified its change" was prose the model
 * wrote. This module makes it a record in the log:
 *
 * 1. **Which surfaces.** The run's changed paths, measured with git in the session's own worktree —
 *    the branch against its base, plus what is uncommitted and untracked — are mapped to surfaces by
 *    `surfaceOf`. A directory that is not a checkout root measures nothing, for the reason
 *    `prStep.ts`'s `diffSize` gives: a plain session directory sits inside the control plane's own
 *    checkout, and a bare `git diff` there would measure *its* branch.
 * 2. **What runs, per surface.** The repo's declared `verify` command (`.factory/config`, the
 *    workspace's `commands.verify`) when there is one — the repo said how it verifies itself, so that
 *    is the answer — and only otherwise the surface's skill directory, run as `up.sh`, its driver,
 *    then `down.sh`. The declared command is told which surface it is verifying through
 *    `FACTORY_VERIFY_SURFACE`; a command that ignores it verifies the whole repo once per surface.
 * 3. **What is recorded.** One typed result per surface, as the tool result's `details`: the command,
 *    where it ran, the exit code, and a bounded tail of its output. A surface with neither a command
 *    nor a skill is a typed `VerifyNoEvidence` naming the surface, never a missing row; a command
 *    that could not run (spawn failure, timeout) is `VerifyUnrunnable` with what it printed before it
 *    stopped. None of these throw: a failed verification is a result the model reads and a gate
 *    checks, not a tool crash. The one throw is an abort, which belongs to Pi Durable.
 *
 * The record is the tool result Pi Durable already commits, not a second document beside it: one
 * write, so the evidence a reader decodes (`verifyReportsIn`) and the text the model read can never
 * disagree.
 *
 * The tool takes no arguments, deliberately. The model does not choose the surface or the command:
 * a tool that let it name a surface could verify one whose skill passes instead of the one it
 * touched, and one that took a command would be `bash` with a better name. Everything it runs is
 * something the repo itself declared, which is also why the policy (`./policy`) has nothing to read
 * in its arguments.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type {
  Cursor,
  EntryRecord,
  Extension,
  Page,
  Storage,
} from "@earendil-works/pi-durable";
import {
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Effect, Option, Schema } from "effect";

/** The tool's name, as the model calls it and as its result is found in the log. */
export const VERIFY_TOOL = "verify";

/** The name the extension carrying the tool is installed under. */
export const VERIFY_EXTENSION = "factory.verify";

/** The variable a declared `verify` command reads the surface it is verifying from. */
export const VERIFY_SURFACE_VARIABLE = "FACTORY_VERIFY_SURFACE";

/** Where a repo keeps its verify skills, relative to the checkout root. */
export const VERIFY_SKILLS_DIR = ".pi/skills";

/**
 * The drivers a skill directory may hold, in the order they are looked for, and how each is run.
 * These are the three this repo's skills use (`verify-board`/`verify-cli` are bash, `verify-api` and
 * `verify-policy` bun, `verify-web` node).
 */
export const VERIFY_DRIVERS: ReadonlyArray<readonly [string, string]> = [
  ["drive.sh", "bash drive.sh"],
  ["drive.ts", "bun drive.ts"],
  ["drive.mjs", "node drive.mjs"],
];

/**
 * How much of a verification's output the record keeps: the tail, because a driver prints its
 * verdict last. Both bounds apply; whichever cuts more wins.
 */
export const VERIFY_OUTPUT_TAIL = { maxChars: 16_384, maxLines: 200 } as const;

/**
 * How long one verification may run before it is stopped and recorded as `VerifyUnrunnable`. A
 * verify skill starts servers and drives them, so minutes are ordinary; an hour is a hang.
 */
export const VERIFY_TIMEOUT_SECONDS = 1_800;

/** A verification that ran to an exit code, zero or not. */
export const VerifyRan = Schema.TaggedStruct("VerifyRan", {
  surface: Schema.String,
  /** `workspace`: the repo's declared `verify` command. `skill`: the surface's skill directory. */
  source: Schema.Literals(["workspace", "skill"]),
  /** Where the command ran, relative to the worktree: `.` or `.pi/skills/verify-<surface>`. */
  directory: Schema.String,
  /** The shell text that ran, exactly. */
  command: Schema.String,
  exitCode: Schema.Int,
  /** The tail of stdout and stderr, interleaved as they arrived. */
  output: Schema.String,
  /** Whether `output` is a tail of something longer. */
  truncated: Schema.Boolean,
});
export type VerifyRan = typeof VerifyRan.Type;

/** A surface the repo gives no way to verify: no declared command and no skill with a driver. */
export const VerifyNoEvidence = Schema.TaggedStruct("VerifyNoEvidence", {
  surface: Schema.String,
  reason: Schema.Literals(["no-verify-skill"]),
  message: Schema.String,
});
export type VerifyNoEvidence = typeof VerifyNoEvidence.Type;

/** A verification that was found and could not run to an exit code (spawn failure, timeout). */
export const VerifyUnrunnable = Schema.TaggedStruct("VerifyUnrunnable", {
  surface: Schema.String,
  source: Schema.Literals(["workspace", "skill"]),
  directory: Schema.String,
  command: Schema.String,
  /** Pi Durable's `ExecutionErrorCode`, or `unknown` when the environment itself rejected. */
  code: Schema.String,
  message: Schema.String,
  output: Schema.String,
  truncated: Schema.Boolean,
});
export type VerifyUnrunnable = typeof VerifyUnrunnable.Type;

export const VerifyResult = Schema.Union([
  VerifyRan,
  VerifyNoEvidence,
  VerifyUnrunnable,
]);
export type VerifyResult = typeof VerifyResult.Type;

/** What one call found: the changed paths, and one result per surface they name. */
export const VerifyReport = Schema.TaggedStruct("VerifyReport", {
  changed: Schema.mutable(Schema.Array(Schema.String)),
  /** The surfaces `changed` names, in first-seen order, one result each. */
  results: Schema.mutable(Schema.Array(VerifyResult)),
});
export type VerifyReport = typeof VerifyReport.Type;

/**
 * A call that could not say what changed, so it verified nothing: the worktree is not a checkout,
 * the session has no environment, or git failed.
 */
export const VerifyUnmeasured = Schema.TaggedStruct("VerifyUnmeasured", {
  reason: Schema.Literals(["no-checkout", "no-environment", "git-failed"]),
  message: Schema.String,
});
export type VerifyUnmeasured = typeof VerifyUnmeasured.Type;

/** A `verify` tool result's `details`, as the log records it. */
export const VerifyRecord = Schema.Union([VerifyReport, VerifyUnmeasured]);
export type VerifyRecord = typeof VerifyRecord.Type;

/** The repo facts the tool needs, from the workspace the control plane resolved. */
export type VerifyOptions = {
  /** The repo's declared `verify` command (`commands.verify`); absent or blank means none. */
  readonly command?: string | undefined;
  /**
   * The ref the branch is measured against (`workspace.baseRef`). Absent: only uncommitted and
   * untracked changes are measured, because there is no base to diff the commits against.
   */
  readonly baseRef?: string | undefined;
  /** Overrides `VERIFY_TIMEOUT_SECONDS`. */
  readonly timeoutSeconds?: number | undefined;
};

const SURFACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The surface one changed path belongs to, or `undefined` when it belongs to none.
 *
 * A workspace package is its own surface: `apps/<name>/…` and `packages/<name>/…` name `<name>`,
 * which is the `verify-<name>` skill the convention looks for. A change to a verify skill itself
 * (`.pi/skills/verify-<name>/…`) names the surface it verifies, so editing a driver runs it. Anything
 * else — `docs/`, the root's own files — names no surface: there is nothing to drive.
 *
 * A path rule rather than a table a skill declares, on purpose for this part: it needs nothing the
 * repo does not already have, and a package with no skill of its own is reported as exactly that
 * (`VerifyNoEvidence`) rather than silently mapped onto a neighbour's skill.
 */
export const surfaceOf = (path: string): string | undefined => {
  const parts = path.split("/");
  const [root, name] = parts;
  if (name === undefined || parts.length < 3) return undefined;
  if (root === "apps" || root === "packages")
    return SURFACE_NAME.test(name) ? name : undefined;
  if (root === ".pi" && name === "skills") {
    const skill = parts[2];
    if (parts.length < 4 || skill === undefined) return undefined;
    const surface = skill.startsWith("verify-")
      ? skill.slice("verify-".length)
      : undefined;
    return surface !== undefined && SURFACE_NAME.test(surface)
      ? surface
      : undefined;
  }
  return undefined;
};

/** The surfaces a set of changed paths names, in first-seen order, each once. */
export const surfacesOf = (paths: readonly string[]): readonly string[] => [
  ...new Set(
    paths.flatMap((path) => {
      const surface = surfaceOf(path);
      return surface === undefined ? [] : [surface];
    }),
  ),
];

/**
 * The tail of `text` within `limits`, and whether anything was cut. Deterministic: the same text
 * always keeps the same tail, so a record and a re-run of the same output agree.
 */
export const tailOf = (
  text: string,
  limits: {
    readonly maxChars: number;
    readonly maxLines: number;
  } = VERIFY_OUTPUT_TAIL,
): { readonly output: string; readonly truncated: boolean } => {
  let output = text;
  let truncated = false;
  if (output.length > limits.maxChars) {
    output = output.slice(output.length - limits.maxChars);
    truncated = true;
  }
  const lines = output.split("\n");
  // A trailing newline ends the last line rather than starting another one.
  const trailing = lines[lines.length - 1] === "" ? 1 : 0;
  if (lines.length - trailing > limits.maxLines) {
    output = lines.slice(lines.length - limits.maxLines - trailing).join("\n");
    truncated = true;
  }
  return { output, truncated };
};

/**
 * A running tail: holds at most twice the character bound, so a driver that prints megabytes costs
 * a bounded buffer, and remembers that it dropped something.
 */
const runningTail = () => {
  let text = "";
  let dropped = false;
  return {
    push: (chunk: string) => {
      text += chunk;
      if (text.length > 2 * VERIFY_OUTPUT_TAIL.maxChars) {
        text = text.slice(text.length - VERIFY_OUTPUT_TAIL.maxChars);
        dropped = true;
      }
    },
    done: () => {
      const tail = tailOf(text);
      return { output: tail.output, truncated: tail.truncated || dropped };
    },
  };
};

/** A command the environment could not run to an exit code. */
class ExecFailure extends Schema.TaggedError<ExecFailure>()("ExecFailure", {
  code: Schema.String,
  message: Schema.String,
}) {}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type ExecInput = {
  readonly env: ExecutionEnv;
  readonly command: string | readonly string[];
  readonly cwd: string;
  readonly variables?: Record<string, string>;
  readonly timeoutSeconds?: number;
  readonly onOutput: (text: string, stream: "stdout" | "stderr") => void;
  readonly context: Context;
};

/** Run one command to its exit code, crossing the Promise boundary once. */
const exec = (input: ExecInput): Effect.Effect<number, ExecFailure> =>
  Effect.tryPromise({
    try: () =>
      input.env.exec(
        input.command,
        {
          cwd: input.cwd,
          env: input.variables ?? {},
          inheritEnv: true,
          ...(input.timeoutSeconds === undefined
            ? {}
            : { timeout: input.timeoutSeconds }),
          onOutput: (text, _context, info) => input.onOutput(text, info.stream),
        },
        input.context,
      ),
    catch: (cause) =>
      new ExecFailure({ code: "unknown", message: describe(cause) }),
  }).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.value.exitCode)
        : Effect.fail(
            new ExecFailure({
              code: result.error.code,
              message: result.error.message,
            }),
          ),
    ),
  );

/** Whether a path exists in the environment; an unreadable path is one that does not. */
const exists = (
  env: ExecutionEnv,
  path: string,
  context: Context,
): Effect.Effect<boolean> =>
  Effect.tryPromise(() => env.exists(path, context)).pipe(
    Effect.map((result) => result.ok && result.value),
    Effect.orElseSucceed(() => false),
  );

/** `-z` output: NUL-separated paths, the one spelling git never quotes. */
const nulPaths = (text: string): readonly string[] =>
  text.split("\0").filter((path) => path !== "");

/**
 * The run's changed paths: the branch against its base, and what is uncommitted or untracked, sorted
 * and each once. A git failure is never guessed past: it is `VerifyUnmeasured`, not an empty list.
 */
export const changedPaths = (input: {
  readonly env: ExecutionEnv;
  readonly baseRef?: string | undefined;
  readonly context: Context;
}): Effect.Effect<readonly string[], VerifyUnmeasured> =>
  Effect.gen(function* () {
    const { env, context } = input;
    const cwd = env.cwd;
    if (!(yield* exists(env, `${cwd}/.git`, context))) {
      return yield* Effect.fail(
        VerifyUnmeasured.make({
          reason: "no-checkout",
          message: `${cwd} is not a checkout root, so the run's changes cannot be measured`,
        }),
      );
    }
    const git = (args: readonly string[]) =>
      Effect.gen(function* () {
        let stdout = "";
        let stderr = "";
        const exitCode = yield* exec({
          env,
          command: ["git", ...args],
          cwd,
          onOutput: (text, stream) => {
            if (stream === "stdout") stdout += text;
            else stderr += text;
          },
          context,
        }).pipe(
          Effect.mapError((failure) =>
            VerifyUnmeasured.make({
              reason: "git-failed",
              message: `git ${args.join(" ")}: ${failure.message}`,
            }),
          ),
        );
        if (exitCode !== 0) {
          return yield* Effect.fail(
            VerifyUnmeasured.make({
              reason: "git-failed",
              message: `git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`,
            }),
          );
        }
        return nulPaths(stdout);
      });
    const committed =
      input.baseRef === undefined || input.baseRef === ""
        ? []
        : yield* git([
            "diff",
            "--name-only",
            "-z",
            "--end-of-options",
            `${input.baseRef}...HEAD`,
            "--",
          ]);
    const uncommitted = yield* git(["diff", "--name-only", "-z", "HEAD", "--"]);
    const untracked = yield* git([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    return [...new Set([...committed, ...uncommitted, ...untracked])].sort();
  });

/** What runs for one surface, once discovery has decided. */
type Plan = {
  readonly source: "workspace" | "skill";
  readonly directory: string;
  readonly command: string;
};

/**
 * How a skill directory is run: `up.sh` if it has one, then its driver if `up.sh` succeeded, then
 * `down.sh` whatever happened — so a failed drive still stops what `up.sh` started. The exit code is
 * the first failure's (`up.sh`'s, else the driver's); `down.sh`'s own is not the verdict.
 */
export const skillScript = (input: {
  readonly up: boolean;
  readonly driver: string;
  readonly down: boolean;
}): string => {
  if (!input.up && !input.down) return input.driver;
  return [
    "status=0",
    ...(input.up ? ["bash up.sh || status=$?"] : []),
    `if [ "$status" -eq 0 ]; then ${input.driver} || status=$?; fi`,
    ...(input.down ? ["bash down.sh"] : []),
    'exit "$status"',
  ].join("; ");
};

/**
 * Discovery for one surface: the declared command first, the skill directory second, and `none`
 * when neither exists. The order is the point (the acceptance asserts it with both present): the
 * repo's own declaration is the answer to "how does this repo verify itself", and the skill
 * directory is the convention a repo with no declaration falls back on.
 */
const planFor = (input: {
  readonly env: ExecutionEnv;
  readonly surface: string;
  readonly command: string | undefined;
  readonly context: Context;
}): Effect.Effect<Option.Option<Plan>> =>
  Effect.gen(function* () {
    if (input.command !== undefined && input.command.trim() !== "") {
      return Option.some({
        source: "workspace",
        directory: ".",
        command: input.command,
      } satisfies Plan);
    }
    const directory = `${VERIFY_SKILLS_DIR}/verify-${input.surface}`;
    const root = `${input.env.cwd}/${directory}`;
    const has = (file: string) =>
      exists(input.env, `${root}/${file}`, input.context);
    for (const [file, driver] of VERIFY_DRIVERS) {
      if (yield* has(file)) {
        return Option.some({
          source: "skill",
          directory,
          command: skillScript({
            up: yield* has("up.sh"),
            driver,
            down: yield* has("down.sh"),
          }),
        } satisfies Plan);
      }
    }
    return Option.none();
  });

const verifySurface = (input: {
  readonly env: ExecutionEnv;
  readonly surface: string;
  readonly options: VerifyOptions;
  readonly onOutput: (text: string) => void;
  readonly context: Context;
}): Effect.Effect<VerifyResult> =>
  Effect.gen(function* () {
    const { env, surface, context } = input;
    const plan = yield* planFor({
      env,
      surface,
      command: input.options.command,
      context,
    });
    if (Option.isNone(plan)) {
      return VerifyNoEvidence.make({
        surface,
        reason: "no-verify-skill",
        message: `no evidence for surface "${surface}": the repo declares no verify command and ${VERIFY_SKILLS_DIR}/verify-${surface}/ holds no driver (${VERIFY_DRIVERS.map(([file]) => file).join(", ")})`,
      });
    }
    const { source, directory, command } = plan.value;
    input.onOutput(`== verify ${surface} (${source}): ${command}\n`);
    const tail = runningTail();
    const ran = yield* Effect.result(
      exec({
        env,
        command,
        cwd: directory === "." ? env.cwd : `${env.cwd}/${directory}`,
        variables: { [VERIFY_SURFACE_VARIABLE]: surface },
        timeoutSeconds: input.options.timeoutSeconds ?? VERIFY_TIMEOUT_SECONDS,
        onOutput: (text) => {
          tail.push(text);
          input.onOutput(text);
        },
        context,
      }),
    );
    const { output, truncated } = tail.done();
    if (ran._tag === "Failure") {
      return VerifyUnrunnable.make({
        surface,
        source,
        directory,
        command,
        code: ran.failure.code,
        message: ran.failure.message,
        output,
        truncated,
      });
    }
    return VerifyRan.make({
      surface,
      source,
      directory,
      command,
      exitCode: ran.success,
      output,
      truncated,
    });
  });

/**
 * One verification pass over a session's environment: measure what changed, then verify each
 * surface it names, one after another (verify skills bind ports, so two at once would collide).
 *
 * Never fails: every outcome, including "could not tell what changed", is a value of the record.
 */
export const runVerify = (input: {
  readonly env: ExecutionEnv | undefined;
  readonly options?: VerifyOptions;
  readonly onOutput?: (text: string) => void;
  readonly context?: Context;
}): Effect.Effect<VerifyRecord> =>
  Effect.gen(function* () {
    const env = input.env;
    if (env === undefined) {
      return VerifyUnmeasured.make({
        reason: "no-environment",
        message: "the session has no execution environment to verify in",
      });
    }
    const options = input.options ?? {};
    const context = input.context ?? BACKGROUND_CONTEXT;
    const changed = yield* Effect.result(
      changedPaths({ env, baseRef: options.baseRef, context }),
    );
    if (changed._tag === "Failure") return changed.failure;
    const results: VerifyResult[] = [];
    for (const surface of surfacesOf(changed.success)) {
      results.push(
        yield* verifySurface({
          env,
          surface,
          options,
          onOutput: input.onOutput ?? (() => undefined),
          context,
        }),
      );
    }
    return VerifyReport.make({ changed: [...changed.success], results });
  });

/** Whether a record says a verification failed: a non-zero exit, or a command that could not run. */
export const verifyFailed = (record: VerifyRecord): boolean =>
  record._tag === "VerifyReport" &&
  record.results.some(
    (result) =>
      result._tag === "VerifyUnrunnable" ||
      (result._tag === "VerifyRan" && result.exitCode !== 0),
  );

/** The record as the model reads it: one line per surface, then the output tail of each that ran. */
export const describeVerify = (record: VerifyRecord): string => {
  if (record._tag === "VerifyUnmeasured")
    return `verify: nothing verified (${record.reason}): ${record.message}`;
  if (record.results.length === 0) {
    return record.changed.length === 0
      ? "verify: nothing verified: the run changed no paths"
      : `verify: nothing verified: no changed path belongs to a surface (${record.changed.join(", ")})`;
  }
  const lines = [
    `verify: ${record.changed.length} changed path(s), ${record.results.length} surface(s)`,
  ];
  for (const result of record.results) {
    switch (result._tag) {
      case "VerifyRan":
        lines.push(
          `[${result.surface}] exit ${result.exitCode} — ${result.source} in ${result.directory}: ${result.command}`,
          `${result.truncated ? "…(output truncated to its tail)\n" : ""}${result.output}`,
        );
        break;
      case "VerifyUnrunnable":
        lines.push(
          `[${result.surface}] could not run (${result.code}): ${result.message} — ${result.source} in ${result.directory}: ${result.command}`,
          `${result.truncated ? "…(output truncated to its tail)\n" : ""}${result.output}`,
        );
        break;
      case "VerifyNoEvidence":
        lines.push(`[${result.surface}] ${result.message}`);
        break;
    }
  }
  return lines.join("\n");
};

const decodeRecord = Schema.decodeUnknownOption(VerifyRecord);

/**
 * Every `verify` result a transcript holds, oldest first, decoded from the tool results' `details`.
 * A result whose details are not a record (a blocked or crashed call) is skipped: it carries no
 * evidence, and its text is still in the transcript for a reader.
 */
export const verifyRecordsIn = (
  entries: readonly EntryRecord[],
): readonly VerifyRecord[] =>
  entries.flatMap((entry) => {
    const message = entry.model?.[0];
    if (message?.role !== "toolResult" || message.toolName !== VERIFY_TOOL)
      return [];
    return Option.toArray(decodeRecord(message.details));
  });

/** Every `verify` record in a session's log, read straight from its storage, oldest first. */
export const readVerifyRecords = (
  storage: Storage,
): Effect.Effect<readonly VerifyRecord[], Error> =>
  Effect.gen(function* () {
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page: Page<EntryRecord, Cursor> = yield* Effect.tryPromise(() =>
        storage.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID },
          500,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      );
      entries.push(...page.items);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    // Storage scans newest first.
    return verifyRecordsIn(entries.reverse());
  });

/** A record as the tool result's `details`: the schema's own encoding, which is plain JSON. */
const encodeRecord = Schema.encodeSync(VerifyRecord);

/**
 * The `verify` tool, bound to one session's repo facts.
 *
 * Sequential, because a verify skill starts servers on fixed ports and two in one round would
 * collide. The output streams to the live tool slot as it arrives, so a person watching sees a drive
 * progress; the committed result is the record and its description, not that stream.
 */
export const verifyTool = (options: VerifyOptions = {}) =>
  defineTool({
    name: VERIFY_TOOL,
    description:
      "Verify the change this run made. Finds the surfaces the changed paths belong to " +
      "(apps/<name>, packages/<name>), runs the repo's declared verify command or else the " +
      `${VERIFY_SKILLS_DIR}/verify-<surface>/ skill for each, and records each exit code and ` +
      "the tail of its output as evidence. Takes no arguments. Call it after the change is made " +
      "and before claiming it works.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    outputLimits: { retain: "tail" },
    execute: (_args, api, context) =>
      Effect.runPromise(
        runVerify({
          env: api.env,
          options,
          onOutput: (text) => api.output(text),
          context,
        }),
      ).then((record) => {
        // An abort is Pi Durable's to settle, not a verification result: rethrowing is what lets
        // the tool task end as aborted rather than as a record that says the command "could not
        // run".
        if (context.abortSignal?.aborted) throw new Error("verify aborted");
        const details: JsonValue = encodeRecord(record);
        return {
          content: [{ type: "text" as const, text: describeVerify(record) }],
          details,
          isError: verifyFailed(record),
        };
      }),
  });

/** The extension installed beside `CodingTools` at `openSession`. */
export const verifyExtension = (options: VerifyOptions = {}): Extension =>
  defineExtension({ name: VERIFY_EXTENSION, tools: [verifyTool(options)] });
