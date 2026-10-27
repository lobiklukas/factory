import { Effect, FileSystem, Path } from "effect";

/**
 * Which `.env` files the process could have loaded, and which of them exist (LOB-256).
 *
 * Turborepo never loads a `.env` into a task (its docs say so), and Bun only autoloads one from its own
 * working directory, which for a workspace task is the package, not the repository root. So the dev
 * scripts name the root file themselves with `bun --env-file=../../.env`, and this module answers the
 * question an operator asks when a key "does not take": which files did this process actually read?
 * Bun records its flags in `process.execArgv`, so the answer is derivable without parsing an env file.
 *
 * The answer is paths only. No value is read, and none is ever logged.
 */

/** The `--env-file` values among a process's runtime flags, in the order Bun applies them. */
export const explicitEnvFiles = (
  execArgv: readonly string[],
): readonly string[] => {
  const files: string[] = [];
  execArgv.forEach((arg, index) => {
    if (arg.startsWith("--env-file=")) {
      files.push(arg.slice("--env-file=".length));
    } else if (arg === "--env-file") {
      const next = execArgv[index + 1];
      if (next !== undefined) files.push(next);
    }
  });
  return files;
};

/**
 * The files Bun autoloads from the working directory when no flag says otherwise: `.env`, then the
 * one for `NODE_ENV`, then `.env.local` (which a test run skips).
 */
export const autoloadedEnvFiles = (nodeEnv: string | undefined) => {
  const mode =
    nodeEnv === "production" || nodeEnv === "test" ? nodeEnv : "development";
  return mode === "test"
    ? [".env", ".env.test"]
    : [".env", `.env.${mode}`, ".env.local"];
};

/**
 * The absolute path of every env file that exists and was in play: the explicit `--env-file`s
 * first, then the working directory's autoloaded ones. A flag naming a missing file is not listed,
 * because Bun treats it as a no-op and it supplied nothing.
 */
export const loadedEnvFiles = Effect.fn("EnvFiles.loaded")(function* (input: {
  readonly execArgv: readonly string[];
  readonly cwd: string;
  readonly nodeEnv: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates = [
    ...explicitEnvFiles(input.execArgv),
    ...autoloadedEnvFiles(input.nodeEnv),
  ].map((file) => path.resolve(input.cwd, file));
  const loaded: string[] = [];
  for (const candidate of new Set(candidates)) {
    const present = yield* fs
      .exists(candidate)
      .pipe(Effect.orElseSucceed(() => false));
    if (present) loaded.push(candidate);
  }
  return loaded;
});

/** The boot line: paths, never values. */
export const describeLoadedEnvFiles = (files: readonly string[]) =>
  files.length === 0
    ? "env files loaded: none (the process environment only)"
    : `env files loaded: ${files.join(", ")} (paths only; values are never logged)`;
