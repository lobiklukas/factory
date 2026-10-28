import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

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
const WEB_DEV_TASK = "@repo/web#dev";
const CLI_DEV_TASK = "@repo/cli#dev";

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
    readonly resolvedTaskDefinition: {
      readonly passThroughEnv: readonly string[] | null;
    };
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

/**
 * Result of running a gate script with --dry=json, including stderr which shows
 * the command that gets executed (with the shell prefix from package.json).
 */
interface ScriptResult {
  readonly dryRun: DryRun;
  readonly stderr: string;
}

/**
 * Resolve one of the gate's own scripts WITHOUT explicitly setting telemetry opt-outs.
 *
 * This verifies that the gate's own package.json scripts (build, test, dev, type-check, clean)
 * provide the opt-outs via the shell prefix (DO_NOT_TRACK=1 TURBO_TELEMETRY_DISABLED=1
 * TURBO_NO_UPDATE_NOTIFIER=1). The command that gets executed is printed to stderr by turbo
 * and includes the shell prefix with the opt-outs.
 */
const resolveScriptNoOptOuts = (
  script: "test" | "dev" | "build" | "type-check" | "clean",
  filter: string,
  url: string,
): ScriptResult => {
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
        // Intentionally NOT setting TURBO_TELEMETRY_DISABLED or DO_NOT_TRACK here.
        // The gate's own scripts must provide them via the shell prefix in package.json.
      },
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
  return {
    dryRun: JSON.parse(result.stdout) as DryRun,
    stderr: result.stderr,
  };
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

  describe("the gate's own scripts provide telemetry opt-outs", () => {
    const GATE_SCRIPTS = ["test", "build", "type-check", "dev"] as const;
    // "clean" is excluded because it's a compound command (&&) that doesn't support --dry=json

    for (const script of GATE_SCRIPTS) {
      it(`provides TURBO_TELEMETRY_DISABLED and DO_NOT_TRACK for ${script}`, () => {
        const { stderr } = resolveScriptNoOptOuts(
          script,
          "@repo/storage-postgres",
          databaseUrl("factory_probe_optout"),
        );
        // The command printed to stderr includes the shell prefix from package.json.
        // Verify the opt-outs are present in the command that gets executed.
        expect(stderr).toContain("DO_NOT_TRACK=1");
        expect(stderr).toContain("TURBO_TELEMETRY_DISABLED=1");
        expect(stderr).toContain("TURBO_NO_UPDATE_NOTIFIER=1");
      }, 90_000);
    }
  });
});

/**
 * Every variable a dev task reads must be declared on that task, or Strict Mode strips it before the
 * process starts: `MODEL_BACKEND=anthropic bun run dev` then runs the faux provider (LOB-101). Declared
 * per package, so each case names the task that reads the variable. `VITE_PORT` is declared on the web
 * task explicitly, though turbo's framework inference already passes `VITE_*` on this version.
 */
describe("the dev tasks' environment", () => {
  const API_DEV_VARIABLES = [
    "PORT",
    "HOST",
    "IDLE_TIMEOUT",
    "ALLOWED_ORIGINS",
    "MAX_REQUEST_BODY_BYTES",
    "MODEL_BACKEND",
    "FAUX_COMMAND",
    "FAUX_EVERY_TURN",
    "APPROVAL_REQUIRED",
    "ROLE_MODELS",
    "FAUX_ASK",
    "FAUX_SPEC",
    "FAUX_REVIEW",
    "FAUX_VERIFY",
    "FAUX_SLEEP_MS",
    "FAUX_MODEL_SCRIPTS",
    "SESSION_ROOT",
    "SESSION_IDLE_TIMEOUT_MS",
    "SANDBOX_RUNTIME",
    "PR_CAP_MAX_FILES",
    "PR_CAP_MAX_LINES",
    "DATABASE_MAX_CONNECTIONS",
    "MOTEL_URL",
    "OTEL_SERVICE_NAME",
    "DEVTOOLS",
    "DEVTOOLS_URL",
    "DOCS_SCHEDULE_MS",
    "DOCS_SCHEDULE_REPO",
    "MISSION_RESUME",
    "GITHUB_REVIEWER_APP_ID",
    "GITHUB_REVIEWER_APP_INSTALLATION_ID",
  ] as const;
  const WEB_DEV_VARIABLES = [
    "VITE_PORT",
    "VITE_SERVER_URL",
    "VITE_ENABLE_DEVTOOLS",
    "VITE_DEVTOOLS_URL",
  ] as const;
  const CLI_DEV_VARIABLES = [
    "FACTORY_API_URL",
    "API_URL",
    "DEVTOOLS",
    "DEVTOOLS_URL",
    "MOTEL_URL",
    "OTEL_SERVICE_NAME",
  ] as const;

  it("declares each variable @repo/api#dev reads on that task", () => {
    const dryRun = resolveScript(
      "dev",
      "@repo/api",
      databaseUrl("factory_probe"),
    );
    for (const name of API_DEV_VARIABLES) {
      expect(declared(dryRun, DEV_TASK)).toContain(name);
    }
  }, 90_000);

  it("declares each variable @repo/web#dev reads on that task", () => {
    const dryRun = resolveScript(
      "dev",
      "@repo/web",
      databaseUrl("factory_probe"),
    );
    for (const name of WEB_DEV_VARIABLES) {
      expect(declared(dryRun, WEB_DEV_TASK)).toContain(name);
    }
  }, 90_000);

  it("declares each variable @repo/cli#dev reads on that task", () => {
    const dryRun = resolveScript(
      "dev",
      "@repo/cli",
      databaseUrl("factory_probe"),
    );
    for (const name of CLI_DEV_VARIABLES) {
      expect(declared(dryRun, CLI_DEV_TASK)).toContain(name);
    }
  }, 90_000);

  it("passes ANTHROPIC_API_KEY through to @repo/api#dev without declaring it, so it stays out of the hash", () => {
    const dryRun = resolveScript(
      "dev",
      "@repo/api",
      databaseUrl("factory_probe"),
    );
    expect(
      taskOf(dryRun, DEV_TASK).resolvedTaskDefinition.passThroughEnv,
    ).toContain("ANTHROPIC_API_KEY");
    expect(declared(dryRun, DEV_TASK)).not.toContain("ANTHROPIC_API_KEY");
    expect(
      configured(dryRun, DEV_TASK).some((entry) =>
        entry.startsWith("ANTHROPIC_API_KEY="),
      ),
    ).toBe(false);
  }, 90_000);

  it("passes every Anthropic auth mode pi-ai accepts through to @repo/api#dev without declaring it (LOB-258)", () => {
    // pi-ai reads these itself, not through `Config`, so the scanning guard below cannot see them:
    // a name Strict Mode stripped would boot `bun run dev` on faux with the credential in .env, or
    // refuse a forced anthropic for a credential that was set. None may enter the task hash.
    const dryRun = resolveScript(
      "dev",
      "@repo/api",
      databaseUrl("factory_probe"),
    );
    const passThrough =
      taskOf(dryRun, DEV_TASK).resolvedTaskDefinition.passThroughEnv ?? [];
    for (const name of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_IDENTITY_TOKEN_FILE",
      "ANTHROPIC_SERVICE_ACCOUNT_ID",
      "ANTHROPIC_WORKSPACE_ID",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      expect(passThrough).toContain(name);
      expect(declared(dryRun, DEV_TASK)).not.toContain(name);
    }
  }, 90_000);

  it("passes GITHUB_WEBHOOK_SECRET through to @repo/api#dev without declaring it (LOB-234)", () => {
    // `POST /webhooks/github` refuses every delivery without it, so a secret Strict Mode stripped
    // would turn the docs push into a `503` with nothing in the shell to say why.
    const dryRun = resolveScript(
      "dev",
      "@repo/api",
      databaseUrl("factory_probe"),
    );
    expect(
      taskOf(dryRun, DEV_TASK).resolvedTaskDefinition.passThroughEnv,
    ).toContain("GITHUB_WEBHOOK_SECRET");
    expect(declared(dryRun, DEV_TASK)).not.toContain("GITHUB_WEBHOOK_SECRET");
  }, 90_000);

  it("passes the reviewer's secrets through to @repo/api#dev without declaring them (LOB-36)", () => {
    // The reviewer's own identity: stripped, every review would be recorded and never posted.
    const dryRun = resolveScript(
      "dev",
      "@repo/api",
      databaseUrl("factory_probe"),
    );
    for (const name of [
      "GITHUB_REVIEWER_TOKEN",
      "GITHUB_REVIEWER_APP_PRIVATE_KEY",
    ]) {
      expect(
        taskOf(dryRun, DEV_TASK).resolvedTaskDefinition.passThroughEnv,
      ).toContain(name);
      expect(declared(dryRun, DEV_TASK)).not.toContain(name);
    }
  }, 90_000);
});

/**
 * `bun run dev` must give the process the repository-root `.env` (LOB-256).
 *
 * Turborepo says it "does not load .env files into your task's runtime", and Bun only autoloads one
 * from its own working directory, which for a workspace task is the package. A key in the root `.env`
 * therefore never reached `apps/api`, and a README quickstart that said to put it there ran the faux
 * provider. The scripts name the file themselves with `bun --env-file=../../.env`.
 *
 * The cases read each real script out of its `package.json`, lay it into a scratch monorepo (outside
 * this repository, so a developer's real `.env` is neither read nor written) and run it through
 * `turbo run dev --filter=...`, with the entry point swapped for one that prints a dummy variable.
 * Only the script's own flags change: `--watch` is dropped so the probe exits. A script that stops
 * naming the root file, or names the wrong depth, prints `<unset>` and fails the case.
 */
describe("the dev scripts load the repo-root env file (LOB-256)", () => {
  const PROBE = "FACTORY_ENV_FILE_PROBE";
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  const scriptOf = (pkg: "api" | "cli", name: "dev" | "dev:watch") => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps", pkg, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const script = manifest.scripts[name];
    if (script === undefined) throw new Error(`apps/${pkg} has no ${name}`);
    return script;
  };

  /**
   * What `turbo run dev` makes of `script` in a monorepo shaped like this one (`apps/<pkg>`, `.env` at
   * the root): the probe's line, and turbo's exit status.
   */
  const probe = (
    script: string,
    options: { readonly rootEnv: string | null; readonly shell?: string },
  ) => {
    expect(script).toContain("src/index.ts");
    const root = mkdtempSync(join(tmpdir(), "factory-env-probe-"));
    scratch.push(root);
    mkdirSync(join(root, "apps", "app"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "scratch",
        private: true,
        workspaces: ["apps/*"],
        packageManager: "bun@1.4.2",
      }),
    );
    writeFileSync(
      join(root, "turbo.json"),
      JSON.stringify({
        tasks: { dev: { persistent: true, cache: false, env: [PROBE] } },
      }),
    );
    writeFileSync(
      join(root, "apps", "app", "package.json"),
      JSON.stringify({
        name: "@scratch/app",
        private: true,
        scripts: {
          dev: script
            .replace("--watch ", "")
            .replace("src/index.ts", "probe.ts"),
        },
      }),
    );
    writeFileSync(
      join(root, "apps", "app", "probe.ts"),
      `console.log("PROBE=" + (process.env["${PROBE}"] ?? "<unset>"));\n`,
    );
    if (options.rootEnv !== null) {
      writeFileSync(join(root, ".env"), `${PROBE}=${options.rootEnv}\n`);
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("TURBO_") && name !== PROBE,
      ),
    );
    const result = spawnSync(
      join(REPO_ROOT, "node_modules", ".bin", "turbo"),
      ["run", "dev", "--filter=@scratch/app", "--ui=stream"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...env,
          ...(options.shell === undefined ? {} : { [PROBE]: options.shell }),
          TURBO_TELEMETRY_DISABLED: "1",
          DO_NOT_TRACK: "1",
        },
        timeout: 60_000,
      },
    );
    const line = /PROBE=(\S*)/.exec(result.stdout)?.[1];
    return { status: result.status, value: line, output: result.stdout };
  };

  it("hands apps/api's dev script the value in the root .env", () => {
    const run = probe(scriptOf("api", "dev"), { rootEnv: "from-root-file" });
    expect(run.status).toBe(0);
    expect(run.value).toBe("from-root-file");
  }, 90_000);

  it("hands apps/api's dev:watch script the value in the root .env", () => {
    const run = probe(scriptOf("api", "dev:watch"), {
      rootEnv: "from-root-file",
    });
    expect(run.status).toBe(0);
    expect(run.value).toBe("from-root-file");
  }, 90_000);

  it("hands apps/cli's dev script the value in the root .env", () => {
    const run = probe(scriptOf("cli", "dev"), { rootEnv: "from-root-file" });
    expect(run.status).toBe(0);
    expect(run.value).toBe("from-root-file");
  }, 90_000);

  it("boots with no root .env at all, the variable unset", () => {
    for (const script of [
      scriptOf("api", "dev"),
      scriptOf("api", "dev:watch"),
      scriptOf("cli", "dev"),
    ]) {
      const run = probe(script, { rootEnv: null });
      expect(run.status).toBe(0);
      expect(run.value).toBe("<unset>");
    }
  }, 120_000);

  it("lets a value exported in the shell override the root .env", () => {
    for (const script of [
      scriptOf("api", "dev"),
      scriptOf("api", "dev:watch"),
      scriptOf("cli", "dev"),
    ]) {
      const run = probe(script, {
        rootEnv: "from-root-file",
        shell: "from-shell",
      });
      expect(run.status).toBe(0);
      expect(run.value).toBe("from-shell");
    }
  }, 180_000);
});

/**
 * The names a source file reads from the environment: `process.env["X"]`, `process.env.X`, and any
 * upper-case string literal inside a `Config.*(...)` call (`Config.String("X")`,
 * `Config.Literals([...], "X")`, `Config.schema(Schema, "X")`, `Config.withDefault(Config.Int("X"), 1)`).
 * Comments are dropped first, so a name only mentioned in prose is not a read.
 *
 * A read through a variable (`process.env[name]`) is invisible here by construction, so the source
 * keeps every read a literal at its call site.
 */
const environmentReads = (source: string): readonly string[] => {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const names = new Set<string>();
  for (const match of code.matchAll(
    /process\.env(?:\["([A-Z][A-Z0-9_]*)"\]|\.([A-Z][A-Z0-9_]*))/g,
  )) {
    names.add(match[1] ?? match[2] ?? "");
  }
  for (const call of code.matchAll(/\bConfig\.[A-Za-z]+\(/g)) {
    let depth = 1;
    let end = call.index + call[0].length;
    while (end < code.length && depth > 0) {
      if (code[end] === "(") depth += 1;
      if (code[end] === ")") depth -= 1;
      end += 1;
    }
    for (const literal of code
      .slice(call.index, end)
      .matchAll(/"([A-Z][A-Z0-9_]+)"/g)) {
      names.add(literal[1] ?? "");
    }
  }
  return [...names].sort();
};

/** Every production source under `directory` (relative to the repo root), tests and builds excluded. */
const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(`${REPO_ROOT}${directory}`, { recursive: true, encoding: "utf8" })
    .filter(
      (path) =>
        /\.tsx?$/.test(path) &&
        !/\.test\.tsx?$/.test(path) &&
        !/(^|\/)(node_modules|dist)\//.test(path),
    )
    .map((path) => `${REPO_ROOT}${directory}/${path}`);

/** The workspace packages a package's `dependencies` name, as directories relative to the repo root. */
const workspaceDependencies = (directory: string): readonly string[] => {
  const manifest = JSON.parse(
    readFileSync(`${REPO_ROOT}${directory}/package.json`, "utf8"),
  ) as { dependencies?: Record<string, string> };
  return Object.entries(manifest.dependencies ?? {})
    .filter(([, range]) => range.startsWith("workspace:"))
    .map(([name]) => `packages/${name.replace("@repo/", "")}`);
};

/**
 * Where `apps/api` reads configuration: its own sources and every workspace package it boots,
 * followed transitively through `dependencies`, so a new package is scanned without editing this list.
 */
const apiSourceDirectories = (): readonly string[] => {
  const seen = new Set<string>(["apps/api"]);
  const pending = ["apps/api"];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const dependency of workspaceDependencies(next)) {
      if (!seen.has(dependency)) {
        seen.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return [...seen].map((directory) => `${directory}/src`);
};
const API_SOURCE_DIRECTORIES = apiSourceDirectories();

/** The reads whose name is not in `known`, each with the file that reads it. */
const undeclaredReads = (
  reads: ReadonlyMap<string, string>,
  known: ReadonlySet<string>,
): readonly string[] =>
  [...reads]
    .filter(([name]) => !known.has(name))
    .map(([name, file]) => `${name} (read in ${file.slice(REPO_ROOT.length)})`);

describe("the API's environment reads (LOB-257)", () => {
  const readsOf = (directories: readonly string[]) =>
    new Map(
      directories
        .flatMap((directory) => sourceFiles(directory))
        .flatMap((file) =>
          environmentReads(readFileSync(file, "utf8")).map(
            (name) => [name, file] as const,
          ),
        ),
    );

  const fixture = `
    // process.env["ONLY_IN_A_COMMENT"] is prose, not a read.
    /* Config.String("ALSO_PROSE") */
    const a = process.env["PLAIN_BRACKET"];
    const b = process.env.PLAIN_DOT;
    const c = Config.option(Config.String("NESTED_STRING"));
    const d = Config.Literals(["anthropic", "faux"], "LITERALS_NAME");
    const e = Config.option(
      Config.schema(
        Schema.Struct({ cap: Schema.Number }),
        "MULTILINE_SCHEMA",
      ),
    );
    const f = Config.withDefault("");
  `;

  it("finds every read form the sources use, and nothing mentioned only in a comment", () => {
    expect(environmentReads(fixture)).toEqual([
      "LITERALS_NAME",
      "MULTILINE_SCHEMA",
      "NESTED_STRING",
      "PLAIN_BRACKET",
      "PLAIN_DOT",
    ]);
  });

  it("scans every workspace package the API boots, harness included", () => {
    expect([...API_SOURCE_DIRECTORIES].sort()).toEqual([
      "apps/api/src",
      "packages/core/src",
      "packages/domain/src",
      "packages/harness/src",
      "packages/sandbox/src",
      "packages/storage-postgres/src",
    ]);
  });

  it("reads the real sources: the trigger, Linear, Sentry and model variables are all seen", () => {
    // A scanner that silently matched nothing would make the guard below pass for any change.
    const names = [...readsOf(API_SOURCE_DIRECTORIES).keys()];
    for (const name of [
      "TRIGGER_SECRET",
      "TRIGGER_RULES",
      "LINEAR_API_KEY",
      "SENTRY_RATE_LIMIT",
      "GITHUB_WEBHOOK_MAX_BODY_BYTES",
      "MODEL_BACKEND",
      "SESSION_BUDGET",
      "GITHUB_REVIEWER_TOKEN",
      "DATABASE_URL",
      "DATABASE_MAX_CONNECTIONS",
      "ANTHROPIC_API_KEY",
      "SANDBOX_RUNTIME",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("declares every variable the API reads on @repo/api#dev, in env or passThroughEnv", () => {
    const dryRun = resolveScript(
      "dev",
      "@repo/api",
      databaseUrl("factory_probe"),
    );
    const known = new Set([
      ...declared(dryRun, DEV_TASK),
      ...(taskOf(dryRun, DEV_TASK).resolvedTaskDefinition.passThroughEnv ?? []),
    ]);
    expect(undeclaredReads(readsOf(API_SOURCE_DIRECTORIES), known)).toEqual([]);
  }, 90_000);

  it("fails on a read nobody declared: the same comparison, against a temporary read", () => {
    const reads = new Map(
      environmentReads(
        `const a = process.env["PORT"]; const b = process.env["BRAND_NEW_SETTING"];`,
      ).map((name) => [name, `${REPO_ROOT}fixture.ts`] as const),
    );
    expect(undeclaredReads(reads, new Set(["PORT"]))).toEqual([
      "BRAND_NEW_SETTING (read in fixture.ts)",
    ]);
  });

  it("lists the trigger, Linear, Sentry, Jira, Slack and GitHub variables under @repo/api#dev", () => {
    const dryRun = resolveScript(
      "dev",
      "@repo/api",
      databaseUrl("factory_probe"),
    );
    const known = [
      ...declared(dryRun, DEV_TASK),
      ...(taskOf(dryRun, DEV_TASK).resolvedTaskDefinition.passThroughEnv ?? []),
    ];
    for (const name of [
      "TRIGGER_RULES",
      "TRIGGER_SECRET",
      "TRIGGER_SECRET_HEADER",
      "TRIGGER_DELIVERY_HEADER",
      "TRIGGER_MAX_BODY_BYTES",
      "LINEAR_WEBHOOK_SECRET",
      "LINEAR_API_KEY",
      "LINEAR_API_URL",
      "LINEAR_STATE_STARTED",
      "LINEAR_STATE_IN_REVIEW",
      "LINEAR_STATE_DONE",
      "LINEAR_SESSION_URL_BASE",
      "SENTRY_CLIENT_SECRET",
      "SENTRY_RATE_LIMIT",
      "SENTRY_RATE_WINDOW_SECONDS",
      "SENTRY_MIN_LEVEL",
      "SENTRY_ENVIRONMENTS",
      "SENTRY_RELEASES",
      "GITHUB_WEBHOOK_MAX_BODY_BYTES",
      "GITHUB_MENTION",
      "GITHUB_SESSION_URL_BASE",
      "JIRA_WEBHOOK_SECRET",
      "JIRA_BASE_URL",
      "JIRA_EMAIL",
      "JIRA_API_TOKEN",
      "JIRA_SESSION_URL_BASE",
      "SLACK_SIGNING_SECRET",
      "SLACK_BOT_TOKEN",
      "SLACK_API_URL",
      "SLACK_CHANNELS",
      "SLACK_TEXT",
      "SLACK_SESSION_URL_BASE",
    ]) {
      expect(known).toContain(name);
    }
  }, 90_000);

  it("passes every secret through without declaring it, so none enters the task hash", () => {
    const dryRun = resolveScript(
      "dev",
      "@repo/api",
      databaseUrl("factory_probe"),
    );
    const passThrough =
      taskOf(dryRun, DEV_TASK).resolvedTaskDefinition.passThroughEnv ?? [];
    for (const name of [
      "TRIGGER_SECRET",
      "LINEAR_WEBHOOK_SECRET",
      "SENTRY_CLIENT_SECRET",
      "LINEAR_API_KEY",
      "GITHUB_WEBHOOK_SECRET",
      "JIRA_WEBHOOK_SECRET",
      "JIRA_API_TOKEN",
      "SLACK_SIGNING_SECRET",
      "SLACK_BOT_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
    ]) {
      expect(passThrough).toContain(name);
      expect(declared(dryRun, DEV_TASK)).not.toContain(name);
    }
  }, 90_000);
});
