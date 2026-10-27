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
 *    checkout, and a bare `git diff` there would measure *its* branch. A changed path that belongs to
 *    no surface (`src/`, `docs/`, a single-package repo's root) is the repo surface, `REPO_SURFACE`.
 * 2. **What runs.** The repo's declared `verify` command (`.factory/config`, the workspace's
 *    `commands.verify`) when there is one — the repo said how it verifies itself, so that is the
 *    answer, whatever the repo's layout. It runs **once per call**, as the repo surface
 *    (`REPO_SURFACE`), and is told every surface the change named through `FACTORY_VERIFY_SURFACES`
 *    (space-separated, `.` among them when a path belongs to no package): a declared command is
 *    usually whole-repo (`bun run test`), and running it once per surface would repeat the whole
 *    suite, each run with its own timeout, while every other session waits on `verifyLock`. A
 *    command that wants to scope itself reads the list. Only without a declared command does each
 *    surface run its own skill directory, as `up.sh`, its driver, then `down.sh`; the repo surface
 *    has no skill directory, so without a declared command it is no evidence.
 * 3. **What is recorded.** One typed result per run — one per surface, or the declared command's one
 *    for the repo — as the tool result's `details`: the command,
 *    where it ran, the exit code, and a bounded tail of its output. A surface with neither a command
 *    nor a skill is a typed `VerifyNoEvidence` naming the surface, never a missing row — so a report
 *    with changed paths always has at least one result, and an empty `results` means the run changed
 *    nothing. A command that could not run (spawn failure, timeout) is `VerifyUnrunnable` with what
 *    it printed before it stopped. None of these throw: a failed verification is a result the model
 *    reads and a gate checks, not a tool crash. The one throw is an abort, which belongs to Pi
 *    Durable.
 *
 * The record is the tool result Pi Durable already commits, not a second document beside it: one
 * write, so the evidence a reader decodes (`verifyRecordsIn`) and the text the model read can never
 * disagree.
 *
 * The tool takes no arguments, deliberately. The model does not choose the surface or the command:
 * a tool that let it name a surface could verify one whose skill passes instead of the one it
 * touched, and one that took a command would be `bash` with a better name. That is a guard against
 * choosing *which* verification runs, not a sandbox: the skill scripts run from the session's own
 * worktree, which the run can write, and editing a driver is exactly what makes `surfaceOf` pick it.
 * So what `verify` runs may be model-written shell that `./policy`'s textual `bash` checks never
 * see — the same non-boundary `./policy` already accepts for "a script written and then executed",
 * and no capability `bash` does not already give. A gate that reads a `VerifyRan` exit 0 (LOB-79)
 * reads what the worktree's verifier said, not what the base ref's would have.
 *
 * **Isolation, and what it does not cover.** A verify skill starts servers on its default ports and
 * reads `DATABASE_URL` (see `verify-api/up.sh`). So each verification runs with `DATABASE_URL` set
 * to `VerifyOptions.databaseUrl`, or else to `VERIFY_NO_DATABASE` — an address that can never
 * connect — and never the control plane's own database, which the nested API would otherwise
 * migrate with the session branch's unmerged migrations and write its drive rows into. Not blank:
 * Effect's `Config` reads an empty variable as a missing one, so a blank `DATABASE_URL` resolves to
 * `@repo/storage-postgres`'s default, which in local dev *is* the control plane's database. A skill
 * that needs a database and is given none fails loudly on connect. And every verification in this
 * process takes `verifyLock` first, so two sessions
 * of one control plane never drive fixed ports at once and read each other's server as ready. What
 * the lock cannot see is another process on the host holding the port (a second control plane, a
 * developer's own server): a skill's readiness poll would reach it. Evidence from a skill is
 * attributable to the session only on a host where this control plane is the one running skills.
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
import { Effect, Option, Schema, Semaphore } from "effect";
import type { PrEvidence, Verification } from "@repo/domain/Session";

/** The tool's name, as the model calls it and as its result is found in the log. */
export const VERIFY_TOOL = "verify";

/** The name the extension carrying the tool is installed under. */
export const VERIFY_EXTENSION = "factory.verify";

/**
 * The variable a verification reads the surface it is verifying from: the skill's surface, or
 * `REPO_SURFACE` for a declared command, which verifies the repo once per call.
 */
export const VERIFY_SURFACE_VARIABLE = "FACTORY_VERIFY_SURFACE";

/**
 * The variable a verification reads every surface the change named from, space-separated in
 * first-seen order (`.` among them when a path belongs to no package). For a skill it is its one
 * surface; for a declared command it is what the one run covers.
 */
export const VERIFY_SURFACES_VARIABLE = "FACTORY_VERIFY_SURFACES";

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

/**
 * How long `down.sh` may run when it is run on its own, after the skill's script was stopped
 * (timeout or abort) before it could reach its own `down.sh`.
 */
export const VERIFY_CLEANUP_TIMEOUT_SECONDS = 120;

/**
 * The surface a changed path that belongs to no package names: the repo itself. It is what a
 * declared command is told (`FACTORY_VERIFY_SURFACE=.`) when it verifies `src/`, `docs/` or a
 * single-package repo's root.
 */
export const REPO_SURFACE = ".";

/** The variable carrying the database a verification may use; see `VerifyOptions.databaseUrl`. */
export const VERIFY_DATABASE_VARIABLE = "DATABASE_URL";

/**
 * What `DATABASE_URL` is when the control plane gives a verification no database: a well-formed
 * Postgres URL on a `.invalid` host (RFC 6761: never resolves), so a consumer that reads it tries to
 * connect and fails, rather than reading a blank as "unset" and falling back on its default — which
 * `@repo/storage-postgres` does, to the control plane's own local database.
 */
export const VERIFY_NO_DATABASE = "postgres://no-database.invalid:5432/none";

/**
 * How many changed paths the record keeps, and how many the model's text names. `changedCount` is
 * always the whole count; the record says when the list is a prefix of it.
 */
export const VERIFY_CHANGED_LIMIT = { record: 500, text: 20 } as const;

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

/**
 * A surface the repo gives no way to verify: no declared command and no skill with a driver
 * (`no-verify-skill`), or changed paths that belong to no package and no declared command to verify
 * the repo with (`no-surface`, surface `REPO_SURFACE`).
 */
export const VerifyNoEvidence = Schema.TaggedStruct("VerifyNoEvidence", {
  surface: Schema.String,
  reason: Schema.Literals(["no-verify-skill", "no-surface"]),
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

/** What one call found: the changed paths, and one result per run they called for. */
export const VerifyReport = Schema.TaggedStruct("VerifyReport", {
  /** The changed paths, sorted: the first `VERIFY_CHANGED_LIMIT.record` of them. */
  changed: Schema.mutable(Schema.Array(Schema.String)),
  /** How many paths changed in all; more than `changed.length` when the list was cut. */
  changedCount: Schema.Int,
  /**
   * Without a declared command, the surfaces `changed` names, in first-seen order, one result each;
   * with one, its single run, for `REPO_SURFACE`.
   */
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
  /**
   * The database a verification may use, as its `DATABASE_URL`. Absent or blank:
   * `VERIFY_NO_DATABASE`, so a skill never inherits, or falls back on, the control plane's own
   * database (the module doc's "Isolation").
   */
  readonly databaseUrl?: string | undefined;
};

const SURFACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The surface one changed path belongs to, or `undefined` when it belongs to none.
 *
 * A workspace package is its own surface: `apps/<name>/…` and `packages/<name>/…` name `<name>`,
 * which is the `verify-<name>` skill the convention looks for. A change to a verify skill itself
 * (`.pi/skills/verify-<name>/…`) names the surface it verifies, so editing a driver runs it. Anything
 * else — `src/`, `docs/`, the root's own files — names no package surface; `runVerify` counts it
 * toward `REPO_SURFACE`, which only a declared command can verify.
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
  /** Whether the skill has a `down.sh`, to run on its own when `command` is stopped before it. */
  readonly down: boolean;
};

/**
 * How a skill directory is run: `up.sh` if it has one, then its driver if `up.sh` succeeded, then
 * `down.sh` whether the driver passed or failed — so a failed drive still stops what `up.sh`
 * started. The exit code is the first failure's (`up.sh`'s, else the driver's); `down.sh`'s own is
 * not the verdict.
 *
 * A timeout or an abort SIGKILLs this whole script's process group, so the `down.sh` in it never
 * runs on that path; `verifySurface` runs `down.sh` again on its own then.
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

/** The repo's declared `verify` command as a plan, or `none` when it declares none. */
const declaredPlan = (command: string | undefined): Option.Option<Plan> =>
  command === undefined || command.trim() === ""
    ? Option.none()
    : Option.some({
        source: "workspace",
        directory: ".",
        command,
        down: false,
      });

/**
 * Discovery for one surface when the repo declares no command: its skill directory's driver, and
 * `none` when there is none. A declared command never reaches here — `runVerify` checks it first,
 * and that order is the point (the acceptance asserts it with both present): the repo's own
 * declaration is the answer to "how does this repo verify itself", and the skill directory is the
 * convention a repo with no declaration falls back on.
 */
const skillPlanFor = (input: {
  readonly env: ExecutionEnv;
  readonly surface: string;
  readonly context: Context;
}): Effect.Effect<Option.Option<Plan>> =>
  Effect.gen(function* () {
    // The repo surface has no skill directory: only a declared command verifies it.
    if (input.surface === REPO_SURFACE) return Option.none();
    const directory = `${VERIFY_SKILLS_DIR}/verify-${input.surface}`;
    const root = `${input.env.cwd}/${directory}`;
    const has = (file: string) =>
      exists(input.env, `${root}/${file}`, input.context);
    for (const [file, driver] of VERIFY_DRIVERS) {
      if (yield* has(file)) {
        const down = yield* has("down.sh");
        return Option.some({
          source: "skill",
          directory,
          command: skillScript({ up: yield* has("up.sh"), driver, down }),
          down,
        } satisfies Plan);
      }
    }
    return Option.none();
  });

/** At most `limit` of `paths`, joined, and how many more there were. */
const namePaths = (paths: readonly string[], limit: number): string =>
  paths.length <= limit
    ? paths.join(", ")
    : `${paths.slice(0, limit).join(", ")}, and ${paths.length - limit} more`;

/** What `DATABASE_URL` a verification gets: the one it was given, else one that cannot connect. */
const databaseFor = (options: VerifyOptions): string =>
  options.databaseUrl === undefined || options.databaseUrl.trim() === ""
    ? VERIFY_NO_DATABASE
    : options.databaseUrl;

const verifySurface = (input: {
  readonly env: ExecutionEnv;
  readonly surface: string;
  /** What `FACTORY_VERIFY_SURFACES` says this run covers. */
  readonly covers: readonly string[];
  /** The plan, or `none` when the surface has no way to be verified. */
  readonly plan: Option.Option<Plan>;
  /** For `REPO_SURFACE`: the changed paths that belong to no package, named when nothing runs. */
  readonly unmapped: readonly string[];
  readonly options: VerifyOptions;
  readonly onOutput: (text: string) => void;
  readonly context: Context;
}): Effect.Effect<VerifyResult> =>
  Effect.gen(function* () {
    const { env, surface, plan, context } = input;
    if (Option.isNone(plan)) {
      return surface === REPO_SURFACE
        ? VerifyNoEvidence.make({
            surface,
            reason: "no-surface",
            message: `no evidence for ${input.unmapped.length} changed path(s) outside every package surface: the repo declares no verify command to verify them with (${namePaths(input.unmapped, VERIFY_CHANGED_LIMIT.text)})`,
          })
        : VerifyNoEvidence.make({
            surface,
            reason: "no-verify-skill",
            message: `no evidence for surface "${surface}": the repo declares no verify command and ${VERIFY_SKILLS_DIR}/verify-${surface}/ holds no driver (${VERIFY_DRIVERS.map(([file]) => file).join(", ")})`,
          });
    }
    const { source, directory, command, down } = plan.value;
    input.onOutput(`== verify ${surface} (${source}): ${command}\n`);
    const tail = runningTail();
    const cwd = directory === "." ? env.cwd : `${env.cwd}/${directory}`;
    // Never the control plane's own database (the module doc's "Isolation").
    const variables = {
      [VERIFY_SURFACE_VARIABLE]: surface,
      [VERIFY_SURFACES_VARIABLE]: input.covers.join(" "),
      [VERIFY_DATABASE_VARIABLE]: databaseFor(input.options),
    };
    const onOutput = (text: string) => {
      tail.push(text);
      input.onOutput(text);
    };
    const ran = yield* Effect.result(
      exec({
        env,
        command,
        cwd,
        variables,
        timeoutSeconds: input.options.timeoutSeconds ?? VERIFY_TIMEOUT_SECONDS,
        onOutput,
        context,
      }),
    );
    if (ran._tag === "Failure" && down) {
      // The script was stopped (timeout, abort) or failed to spawn, so its own `down.sh` did not run:
      // run it here, on a context of its own, because an aborted run's context would refuse it and
      // what `up.sh` started would outlive the session. Its exit code is not the verdict.
      onOutput(`== ${surface}: running down.sh after ${ran.failure.code}\n`);
      yield* Effect.ignore(
        exec({
          env,
          command: "bash down.sh",
          cwd,
          variables,
          timeoutSeconds: VERIFY_CLEANUP_TIMEOUT_SECONDS,
          onOutput,
          context: BACKGROUND_CONTEXT,
        }),
      );
    }
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
 * The one lock every verification in this process takes: verify skills bind fixed default ports, so
 * two sessions verifying at once would collide, and the second's readiness poll would reach the
 * first's server. `executionMode: "sequential"` serializes only one session's tool round; this
 * serializes the control plane. It is held per call, not per surface, so a call's surfaces run
 * back to back. Waiting for it is interruptible — an aborted call stops waiting (`executeVerify`) —
 * but what runs under it is not: once a verification starts, its abort reaches the command through
 * the context, and the cleanup after it (`down.sh`) runs before the permit is released.
 */
export const verifyLock = Semaphore.makeUnsafe(1);

/**
 * The surfaces a call verifies: each package surface the changed paths name, in first-seen order,
 * then `REPO_SURFACE` when any path names none — so no changed path goes unaccounted for.
 */
const surfacesFor = (
  changed: readonly string[],
): {
  readonly surfaces: readonly string[];
  readonly unmapped: readonly string[];
} => {
  const unmapped = changed.filter((path) => surfaceOf(path) === undefined);
  return {
    surfaces: [
      ...surfacesOf(changed),
      ...(unmapped.length > 0 ? [REPO_SURFACE] : []),
    ],
    unmapped,
  };
};

/**
 * One verification pass over a session's environment: measure what changed, then — under
 * `verifyLock` — run the declared command once for the repo, or else verify each surface the change
 * names with its skill, one after another (verify skills bind ports, so two at once would collide).
 * An aborted context stops before the next surface starts, so no skill is started, and no
 * `down.sh` run, for a call that is already over.
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
    const { surfaces, unmapped } = surfacesFor(changed.success);
    const results: VerifyResult[] = [];
    const declared = declaredPlan(options.command);
    // A declared command verifies the repo once, covering every surface; skills verify one each.
    const runs = Option.isSome(declared)
      ? [{ surface: REPO_SURFACE, covers: surfaces }]
      : surfaces.map((surface) => ({ surface, covers: [surface] }));
    if (runs.length > 0) {
      yield* verifyLock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            for (const { surface, covers } of runs) {
              if (context.abortSignal?.aborted === true) break;
              const plan = Option.isSome(declared)
                ? declared
                : yield* skillPlanFor({ env, surface, context });
              results.push(
                yield* verifySurface({
                  env,
                  surface,
                  covers,
                  plan,
                  unmapped,
                  options,
                  onOutput: input.onOutput ?? (() => undefined),
                  context,
                }),
              );
            }
          }),
        ),
      );
    }
    return VerifyReport.make({
      changed: changed.success.slice(0, VERIFY_CHANGED_LIMIT.record),
      changedCount: changed.success.length,
      results,
    });
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
  // `runVerify` gives every changed path a surface, so no results means no changes.
  if (record.results.length === 0)
    return "verify: nothing verified: the run changed no paths";
  const lines = [
    `verify: ${record.changedCount} changed path(s), ${record.results.length} result(s)`,
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

/**
 * How much of a verification's recorded output a PR quotes (LOB-79): the tail, as the record keeps
 * one, and much shorter than the record's own bound — the PR is read by a person, and GitHub caps a
 * body at 65,536 characters across every surface's excerpt.
 */
export const PR_EVIDENCE_EXCERPT = { maxChars: 2_000, maxLines: 40 } as const;

/** The name a PR gives what ran: the skill directory (`verify-api`), or the repo's declared command. */
const verificationName = (result: {
  readonly source: "workspace" | "skill";
  readonly directory: string;
}): string =>
  result.source === "workspace"
    ? "commands.verify"
    : (result.directory.split("/").at(-1) ?? result.directory);

/**
 * One recorded result as the PR cites it. The excerpt is `tailOf` the record's output under
 * `PR_EVIDENCE_EXCERPT` — deterministic, so the same record always quotes the same lines — and it
 * is `truncated` when either cut dropped something: the record's own tail, or this one.
 */
const verificationOf = (result: VerifyResult): Verification => {
  switch (result._tag) {
    case "VerifyNoEvidence":
      return {
        _tag: "VerificationMissing",
        surface: result.surface,
        message: result.message,
      };
    case "VerifyRan": {
      const excerpt = tailOf(result.output, PR_EVIDENCE_EXCERPT);
      return {
        _tag: "VerificationRan",
        surface: result.surface,
        name: verificationName(result),
        source: result.source,
        command: result.command,
        exitCode: result.exitCode,
        excerpt: excerpt.output,
        truncated: result.truncated || excerpt.truncated,
      };
    }
    case "VerifyUnrunnable": {
      const excerpt = tailOf(result.output, PR_EVIDENCE_EXCERPT);
      return {
        _tag: "VerificationUnrunnable",
        surface: result.surface,
        name: verificationName(result),
        source: result.source,
        command: result.command,
        code: result.code,
        message: result.message,
        excerpt: excerpt.output,
        truncated: result.truncated || excerpt.truncated,
      };
    }
  }
};

/**
 * What a PR states was verified, from a session's `verify` records, oldest first (LOB-79).
 *
 * The last record is the evidence: it is the call that saw the latest state of the change, and an
 * earlier pass the run later broke is not a claim the PR may make. A run with no record, a last call
 * that measured nothing, and a last call that found nothing changed are each an `EvidenceNone` that
 * says which — never an empty list a body would render as silence.
 */
export const prEvidenceOf = (records: readonly VerifyRecord[]): PrEvidence => {
  const last = records.at(-1);
  if (last === undefined)
    return {
      _tag: "EvidenceNone",
      reason: "not-verified",
      message: `the run never called the \`${VERIFY_TOOL}\` tool`,
    };
  if (last._tag === "VerifyUnmeasured")
    return {
      _tag: "EvidenceNone",
      reason: "unmeasured",
      message: `the last \`${VERIFY_TOOL}\` call could not measure what changed (${last.reason}): ${last.message}`,
    };
  if (last.results.length === 0)
    return {
      _tag: "EvidenceNone",
      reason: "no-changes",
      message: `the last \`${VERIFY_TOOL}\` call found no changed paths to verify`,
    };
  return {
    _tag: "EvidenceRecorded",
    calls: records.length,
    changedCount: last.changedCount,
    results: last.results.map(verificationOf),
  };
};

/** A record as the tool result's `details`: the schema's own encoding, which is plain JSON. */
const encodeRecord = Schema.encodeSync(VerifyRecord);

/**
 * One `verify` call as the tool runs it: `runVerify`, interrupted by the call's abort signal, so a
 * call waiting on `verifyLock` behind another session stops waiting when its own run is aborted
 * instead of waiting out that session's verification and then starting on an aborted context.
 *
 * An abort rejects with `verify aborted`: it is Pi Durable's to settle, not a verification result,
 * and rethrowing is what lets the tool task end as aborted rather than as a record that says the
 * command "could not run".
 */
export const executeVerify = (input: {
  readonly env: ExecutionEnv | undefined;
  readonly options: VerifyOptions;
  readonly onOutput: (text: string) => void;
  readonly context: Context;
}): Promise<VerifyRecord> => {
  const { context } = input;
  const aborted = () => context.abortSignal?.aborted === true;
  return Effect.runPromise(
    runVerify(input),
    context.abortSignal === undefined ? {} : { signal: context.abortSignal },
  ).then(
    (record) => {
      if (aborted()) throw new Error("verify aborted");
      return record;
    },
    (cause: unknown) => {
      throw aborted() ? new Error("verify aborted") : cause;
    },
  );
};

/**
 * The `verify` tool, bound to one session's repo facts.
 *
 * Sequential, because a verify skill starts servers on fixed ports and two in one round would
 * collide (across sessions, `verifyLock` does the same). The output streams to the live tool slot
 * as it arrives, so a person watching sees a drive progress; the committed result is the record and
 * its description, not that stream.
 */
export const verifyTool = (options: VerifyOptions = {}) =>
  defineTool({
    name: VERIFY_TOOL,
    description:
      "Verify the change this run made. Finds the surfaces the changed paths belong to " +
      "(apps/<name>, packages/<name>, or the repo itself for anything else), runs the repo's " +
      `declared verify command once, or else the ${VERIFY_SKILLS_DIR}/verify-<surface>/ skill ` +
      "for each surface, and records each exit code and " +
      "the tail of its output as evidence. Takes no arguments. Call it after the change is made " +
      "and before claiming it works.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    outputLimits: { retain: "tail" },
    execute: (_args, api, context) =>
      executeVerify({
        env: api.env,
        options,
        onOutput: (text) => api.output(text),
        context,
      }).then((record) => {
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
