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
 * These cases therefore drive the real gate command (`bun run test` from the root, flags and all)
 * as a dry run and read back what turbo says it resolved: the declaration, the hash, and the
 * default that must never be reached.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TASK_ID = "@repo/storage-postgres#test";

/** A URL nothing connects to: a dry run resolves the config and executes nothing. */
const databaseUrl = (database: string) =>
  `postgres://factory:factory@localhost:5442/${database}`;

interface ResolvedEnvironment {
  readonly specified: { readonly env: readonly string[] | null };
  readonly configured: readonly string[] | null;
}

interface DryRun {
  /** The run id turbo derives from the global hash inputs, `DATABASE_URL` among them. */
  readonly id: string;
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

/** Every variable turbo declared for the gate's `test` task, wherever it was declared. */
const declared = (dryRun: DryRun) => [
  ...(dryRun.globalCacheInputs.environmentVariables.specified.env ?? []),
  ...(taskOf(dryRun, TASK_ID).environmentVariables.specified.env ?? []),
];

/** `NAME=<hash of value>` for each declared variable that was actually set when turbo ran. */
const configured = (dryRun: DryRun) => [
  ...(dryRun.globalCacheInputs.environmentVariables.configured ?? []),
  ...(taskOf(dryRun, TASK_ID).environmentVariables.configured ?? []),
];

const dryRunWith = (url: string): DryRun => {
  // The gate's own script, so a `--env-mode` flag added to it would be exercised here too. Turbo
  // vars from whatever task this test itself runs inside are dropped: a nested run must resolve
  // from the repository's configuration, not from its parent's environment.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("TURBO_")),
  );
  const result = spawnSync(
    "bun",
    ["run", "test", "--", "--dry=json", "--filter=@repo/storage-postgres"],
    { cwd: REPO_ROOT, encoding: "utf8", env: { ...env, DATABASE_URL: url } },
  );
  if (result.status !== 0) {
    throw new Error(
      `\`bun run test --dry=json\` exited ${String(result.status)}: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as DryRun;
};

describe("the gate's turbo configuration", () => {
  it("hands DATABASE_URL to the test task in Strict Mode", () => {
    const dryRun = dryRunWith(databaseUrl("factory_probe"));
    expect(dryRun.envMode).toBe("strict");
    expect(declared(dryRun)).toContain("DATABASE_URL");
    expect(
      configured(dryRun).some((entry) => entry.startsWith("DATABASE_URL=")),
    ).toBe(true);
  }, 30_000);

  it("hashes DATABASE_URL, so one database's result cannot be another's cache hit", () => {
    const first = dryRunWith(databaseUrl("factory_probe_one"));
    const second = dryRunWith(databaseUrl("factory_probe_two"));
    expect(configured(first)).not.toEqual(configured(second));
    expect(first.id).not.toBe(second.id);
    expect(taskOf(first, TASK_ID).hash).not.toBe(taskOf(second, TASK_ID).hash);
  }, 30_000);
});
