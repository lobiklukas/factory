import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The gate must run every suite against the database `DATABASE_URL` names, not against the
 * `factory` default `DatabaseConfig` falls back to (LOB-92).
 *
 * Turborepo's Strict Mode is the default and hands a task **only** the variables declared in
 * `globalEnv`/`env`; an undeclared `DATABASE_URL` is dropped before this package's suite starts,
 * which silently points the whole gate at the wrong database and lets a task hash ignore the one
 * it actually used. Nothing in a normal unit test notices, because `Database.ts` has a default.
 *
 * These cases therefore drive the gate's own scripts (`bun run test` / `bun run dev`, flags and
 * all) as a dry run and read back what turbo says it resolved: which tasks the variable reaches,
 * and whether its value reaches their hashes.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const TEST_TASK = "@repo/storage-postgres#test";
const DEV_TASK = "@repo/api#dev";

/** A URL nothing connects to: a dry run resolves the config and executes no task. */
const databaseUrl = (database: string) =>
  `postgres://factory:factory@localhost:5442/${database}`;

interface ResolvedEnvironment {
  readonly specified: { readonly env: readonly string[] | null };
  readonly configured: readonly string[] | null;
}

interface DryRun {
  readonly envMode: string;
  readonly globalCacheInputs: {
    readonly environmentVariables: ResolvedEnvironment;
  };
  readonly tasks: readonly {
    readonly taskId: string;
    readonly hash: string;
    readonly environmentVariables: ResolvedEnvironment;
  }[];
}

const taskOf = (dryRun: DryRun, taskId: string) => {
  const task = dryRun.tasks.find((candidate) => candidate.taskId === taskId);
  if (task === undefined) throw new Error(`turbo resolved no ${taskId} task`);
  return task;
};

/** Every variable turbo declared for `taskId`, wherever it was declared: root or package. */
const declared = (dryRun: DryRun, taskId: string) => [
  ...(dryRun.globalCacheInputs.environmentVariables.specified.env ?? []),
  ...(taskOf(dryRun, taskId).environmentVariables.specified.env ?? []),
];

/** `NAME=<hash of value>` for each declared variable that was set when turbo resolved the run. */
const configured = (dryRun: DryRun, taskId: string) => [
  ...(dryRun.globalCacheInputs.environmentVariables.configured ?? []),
  ...(taskOf(dryRun, taskId).environmentVariables.configured ?? []),
];

/**
 * Resolve one of the gate's own scripts against the repository's configuration.
 *
 * The script is `bun run <script>`, not `turbo` directly, so a flag added to the root
 * `package.json` — the `--env-mode=loose` the issue forbids, say — is exercised here too.
 * Inherited `TURBO_*` variables are dropped, so a nested run resolves from `turbo.json` rather
 * than from the task it is running inside; the telemetry opt-outs are set explicitly rather than
 * inherited, so this case is hermetic and reaches no network (both are on by default in turbo).
 *
 * The dry-run `id` is deliberately not read: it is not reproducible between two runs of the same
 * configuration, so it proves nothing about `DATABASE_URL`.
 */
const resolveScript = (
  script: "test" | "dev",
  filter: string,
  url: string,
): DryRun => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("TURBO_")),
  );
  const result = spawnSync(
    "bun",
    ["run", script, "--", "--dry=json", `--filter=${filter}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...env,
        DATABASE_URL: url,
        TURBO_TELEMETRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
      },
      // The vitest timeout cannot fire while `spawnSync` blocks the thread, so the bound belongs
      // here: a wedged nested turbo would otherwise hold the whole gate open.
      timeout: 60_000,
    },
  );
  if (result.error !== undefined) {
    throw new Error(
      `\`bun run ${script} --dry=json\` failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `\`bun run ${script} --dry=json\` exited ${String(result.status)}: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as DryRun;
};

describe("the gate's turbo configuration", () => {
  it("hands DATABASE_URL to the test task in Strict Mode", () => {
    const dryRun = resolveScript(
      "test",
      "@repo/storage-postgres",
      databaseUrl("factory_probe"),
    );
    expect(dryRun.envMode).toBe("strict");
    expect(declared(dryRun, TEST_TASK)).toContain("DATABASE_URL");
    expect(
      configured(dryRun, TEST_TASK).some((entry) =>
        entry.startsWith("DATABASE_URL="),
      ),
    ).toBe(true);
  }, 90_000);

  it("hands DATABASE_URL to the dev task, which boots the API's migrations", () => {
    // Why the variable is declared in `globalEnv` and not in the `test` task's `env`:
    // `bun run dev` boots `apps/api`, which provides `MigrationsLive` + `PostgresLive`.
    const dryRun = resolveScript(
      "dev",
      "@repo/api",
      databaseUrl("factory_probe"),
    );
    expect(declared(dryRun, DEV_TASK)).toContain("DATABASE_URL");
    expect(
      configured(dryRun, DEV_TASK).some((entry) =>
        entry.startsWith("DATABASE_URL="),
      ),
    ).toBe(true);
  }, 90_000);

  it("hashes DATABASE_URL, so one database's result cannot be another's cache hit", () => {
    const first = resolveScript(
      "test",
      "@repo/storage-postgres",
      databaseUrl("factory_probe_one"),
    );
    const second = resolveScript(
      "test",
      "@repo/storage-postgres",
      databaseUrl("factory_probe_two"),
    );
    expect(configured(first, TEST_TASK)).not.toEqual(
      configured(second, TEST_TASK),
    );
    expect(taskOf(first, TEST_TASK).hash).not.toBe(
      taskOf(second, TEST_TASK).hash,
    );
  }, 120_000);
});
