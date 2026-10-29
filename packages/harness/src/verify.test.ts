/**
 * The `verify` tool (LOB-78): a run's change is verified by the surface's own skill or by the repo's
 * declared command, and the exit code and output are in the log.
 *
 * Every case is a real git checkout with a real fixture skill on disk, run through the real
 * `NodeExecutionEnv`. The cases that claim "in the log" go through `openSession` with pi-ai's faux
 * provider scripted to call `verify`, and read the record back out of the storage the harness
 * committed to — so the tool's install point, its result and the decoder are all the production
 * ones. The storage is Pi Durable's in-memory reference: what is under test is the tool and its
 * record, not the Postgres adapter, which `session.test.ts` covers.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Config, ConfigProvider, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { createFauxModelAccess } from "./models";
import {
  closeHarness,
  openSession,
  readSessionLog,
  submitMessage,
} from "./session";
import {
  describeVerify,
  executeVerify,
  PR_EVIDENCE_EXCERPT,
  prEvidenceOf,
  readVerifyRecords,
  REPO_SURFACE,
  runVerify,
  skillScript,
  surfaceOf,
  tailOf,
  VERIFY_CHANGED_LIMIT,
  VERIFY_NO_DATABASE,
  VERIFY_OUTPUT_TAIL,
  VERIFY_TOOL,
  verifyLock,
  type VerifyOptions,
  type VerifyRecord,
  type VerifyReport,
} from "./verify";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

const write = (root: string, path: string, content: string): void => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (path.endsWith(".sh")) chmodSync(file, 0o755);
};

/**
 * A checkout with `files` committed on `main`, then a session branch cut from it — the shape M6's
 * worktree has. The fixture skills are committed, so they are not themselves a change.
 */
const checkout = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "factory-verify-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "verify@localhost");
  git(root, "config", "user.name", "verify");
  write(root, "README.md", "# fixture\n");
  for (const [path, content] of Object.entries(files))
    write(root, path, content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "factory/fixture");
  return root;
};

const API_SKILL = ".pi/skills/verify-api";

/** pi-ai's faux provider, scripted to call `verify` once and then answer. */
const verifyingModel = () => {
  const { access, faux } = createFauxModelAccess();
  const step: FauxResponseFactory = (context) => {
    faux.appendResponses([step]);
    const verified = context.messages.some(
      (message) =>
        message.role === "toolResult" && message.toolName === VERIFY_TOOL,
    );
    return verified
      ? fauxAssistantMessage("verified")
      : fauxAssistantMessage(fauxToolCall(VERIFY_TOOL, {}), {
          stopReason: "toolUse",
        });
  };
  faux.setResponses([step]);
  return access;
};

/**
 * One turn in which the model calls `verify`, over a session opened the way the control plane opens
 * one. Returns the records the log holds and the transcript's view of the tool result.
 */
const verifiedTurn = (cwd: string, verify?: VerifyOptions) =>
  run(
    Effect.gen(function* () {
      const storage = new MemoryStorage();
      const { harness, root } = yield* openSession({
        storage,
        model: verifyingModel(),
        cwd,
        ...(verify === undefined ? {} : { verify }),
      });
      const submitted = yield* submitMessage(root, {
        content: "verify the change",
        requestId: "verify-request",
      });
      const settled = yield* Effect.promise(() =>
        submitted.submission.wait(BACKGROUND_CONTEXT),
      );
      const records = yield* readVerifyRecords(storage);
      const log = yield* readSessionLog(storage);
      yield* closeHarness(harness);
      const results = log.entries.filter(
        (entry) =>
          entry.kind === "toolResult" && entry.toolName === VERIFY_TOOL,
      );
      return { status: settled.status, records, results };
    }),
  );

/** The one report a call made, narrowed — a test that got anything else fails here. */
const onlyReport = (records: readonly VerifyRecord[]): VerifyReport => {
  expect(records).toHaveLength(1);
  const [record] = records;
  if (record?._tag !== "VerifyReport")
    throw new Error(`expected a report, got ${JSON.stringify(record)}`);
  return record;
};

/**
 * Every case below builds a git checkout and runs a skill's `bash` scripts, with git measuring the
 * change: 4 s alone at worst, and past vitest's 5 s default for a third of them beside a full `bun
 * run test`, the slowest at 11 s. So they carry a budget sized to that load (DEFLAKE).
 */
const SPAWNING_CASES = { timeout: 60_000 };

describe("the verify tool, through a session's log", SPAWNING_CASES, () => {
  it("runs the surface's fixture skill and records exit code 0 with its output", async () => {
    const root = checkout({
      [`${API_SKILL}/drive.sh`]:
        'echo "fixture api: 3/3 checks passed"\necho "surface=$FACTORY_VERIFY_SURFACE"\n',
    });
    write(root, "apps/api/src/feature.ts", "export const feature = 1;\n");

    const turn = await verifiedTurn(root);

    expect(turn.status).toBe("done");
    const report = onlyReport(turn.records);
    expect(report.changed).toEqual(["apps/api/src/feature.ts"]);
    expect(report.changedCount).toBe(1);
    expect(report.results).toEqual([
      {
        _tag: "VerifyRan",
        surface: "api",
        source: "skill",
        directory: API_SKILL,
        command: "bash drive.sh",
        exitCode: 0,
        output: "fixture api: 3/3 checks passed\nsurface=api\n",
        truncated: false,
      },
    ]);
    // What the model read is the same record, as text, and it is not an error.
    expect(turn.results).toHaveLength(1);
    expect(turn.results[0]?.isError).toBe(false);
    expect(turn.results[0]?.text).toContain("[api] exit 0");
    expect(turn.results[0]?.text).toContain("fixture api: 3/3 checks passed");
  });

  it("records a non-zero exit with the output's tail, and the tool does not throw", async () => {
    const root = checkout({
      [`${API_SKILL}/drive.sh`]:
        'for i in $(seq 1 500); do echo "check $i"; done\necho "FAIL: 1 required check failed" >&2\nexit 3\n',
    });
    write(root, "apps/api/src/feature.ts", "export const feature = 2;\n");

    const turn = await verifiedTurn(root);

    // The run settled normally: a thrown tool would leave a result with no details, so no record.
    expect(turn.status).toBe("done");
    const report = onlyReport(turn.records);
    const [result] = report.results;
    if (result?._tag !== "VerifyRan")
      throw new Error(`expected a run, got ${JSON.stringify(result)}`);
    expect(result.exitCode).toBe(3);
    expect(result.truncated).toBe(true);
    // The tail: the verdict printed last is kept, the first lines are not.
    expect(result.output.endsWith("FAIL: 1 required check failed\n")).toBe(
      true,
    );
    const lines = result.output.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(VERIFY_OUTPUT_TAIL.maxLines);
    expect(lines).not.toContain("check 1");
    expect(lines[0]).toBe("check 302");
    expect(turn.results[0]?.isError).toBe(true);
    expect(turn.results[0]?.text).toContain("[api] exit 3");
  });

  it("names a surface with no verify skill as a typed no-evidence result", async () => {
    const root = checkout({
      [`${API_SKILL}/drive.sh`]: 'echo "api ok"\n',
    });
    write(root, "apps/api/src/feature.ts", "export const feature = 3;\n");
    write(root, "apps/web/src/page.tsx", "export const page = 3;\n");

    const turn = await verifiedTurn(root);

    expect(turn.status).toBe("done");
    const report = onlyReport(turn.records);
    expect(report.results.map((result) => result._tag)).toEqual([
      "VerifyRan",
      "VerifyNoEvidence",
    ]);
    const missing = report.results[1];
    if (missing?._tag !== "VerifyNoEvidence")
      throw new Error(`expected no evidence, got ${JSON.stringify(missing)}`);
    expect(missing.surface).toBe("web");
    expect(missing.reason).toBe("no-verify-skill");
    expect(missing.message).toContain('surface "web"');
    expect(missing.message).toContain(".pi/skills/verify-web/");
    // Never silence: the model is told which surface has no evidence.
    expect(turn.results[0]?.text).toContain(
      '[web] no evidence for surface "web"',
    );
  });

  it("prefers the workspace's verify command over the skill directory when both exist and disagree", async () => {
    const root = checkout({
      [`${API_SKILL}/drive.sh`]: 'echo "from-skill"\nexit 7\n',
    });
    write(root, "apps/api/src/feature.ts", "export const feature = 4;\n");
    const command = 'echo "from-workspace $FACTORY_VERIFY_SURFACES"';

    const turn = await verifiedTurn(root, { command });

    const report = onlyReport(turn.records);
    expect(report.results).toEqual([
      {
        _tag: "VerifyRan",
        // The declared command verifies the repo, told the surfaces the change named.
        surface: REPO_SURFACE,
        source: "workspace",
        directory: ".",
        command,
        exitCode: 0,
        output: "from-workspace api\n",
        truncated: false,
      },
    ]);
    expect(turn.results[0]?.isError).toBe(false);
  });

  it("runs the declared command once for the repo when the change is outside every package, and records its failure", async () => {
    // A single-package layout: nothing under apps/ or packages/, so no package surface.
    const root = checkout({});
    write(root, "src/app.ts", "export const app = 1;\n");
    const command =
      'echo "repo verify surface=$FACTORY_VERIFY_SURFACE"; exit 1';

    const turn = await verifiedTurn(root, { command });

    const report = onlyReport(turn.records);
    expect(report.changed).toEqual(["src/app.ts"]);
    expect(report.results).toEqual([
      {
        _tag: "VerifyRan",
        surface: REPO_SURFACE,
        source: "workspace",
        directory: ".",
        command,
        exitCode: 1,
        output: "repo verify surface=.\n",
        truncated: false,
      },
    ]);
    expect(turn.results[0]?.isError).toBe(true);
    expect(turn.results[0]?.text).toContain("[.] exit 1");
  });
});

/** One pass of the tool's work over a checkout, without a model in between. */
const verifyIn = (cwd: string, options?: VerifyOptions) =>
  run(
    runVerify({
      env: new NodeExecutionEnv({ cwd }),
      ...(options === undefined ? {} : { options }),
    }),
  );

describe("runVerify", SPAWNING_CASES, () => {
  it("runs up.sh, the driver, then down.sh — and down.sh even when the driver fails", async () => {
    const root = checkout({
      [`${API_SKILL}/up.sh`]: "echo up\n",
      [`${API_SKILL}/drive.sh`]: "echo drive\nexit 4\n",
      [`${API_SKILL}/down.sh`]: "echo down\n",
    });
    write(root, "packages/api/x.ts", "x\n");

    const report = onlyReport([await verifyIn(root)]);
    const [result] = report.results;
    if (result?._tag !== "VerifyRan") throw new Error("expected a run");
    expect(result.output).toBe("up\ndrive\ndown\n");
    expect(result.exitCode).toBe(4);
    expect(result.command).toBe(
      skillScript({ up: true, driver: "bash drive.sh", down: true }),
    );
  });

  it("does not drive when up.sh fails, still runs down.sh, and reports up.sh's exit code", async () => {
    const root = checkout({
      [`${API_SKILL}/up.sh`]: "echo up-failed\nexit 2\n",
      [`${API_SKILL}/drive.sh`]: "echo drive\n",
      [`${API_SKILL}/down.sh`]: "echo down\n",
    });
    write(root, "apps/api/x.ts", "x\n");

    const report = onlyReport([await verifyIn(root)]);
    const [result] = report.results;
    if (result?._tag !== "VerifyRan") throw new Error("expected a run");
    expect(result.output).toBe("up-failed\ndown\n");
    expect(result.exitCode).toBe(2);
  });

  it("finds a bun driver when the skill has no shell driver", async () => {
    const root = checkout({
      [`${API_SKILL}/drive.ts`]: 'console.log("bun driver");\n',
    });
    write(root, "apps/api/x.ts", "x\n");

    const report = onlyReport([await verifyIn(root)]);
    const [result] = report.results;
    if (result?._tag !== "VerifyRan") throw new Error("expected a run");
    expect(result.command).toBe("bun drive.ts");
    expect(result.output).toBe("bun driver\n");
  });

  it("measures committed changes against the base ref, and only uncommitted ones without one", async () => {
    const root = checkout({
      [`${API_SKILL}/drive.sh`]: "echo ok\n",
    });
    write(root, "apps/api/committed.ts", "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "change");

    const withBase = onlyReport([await verifyIn(root, { baseRef: "main" })]);
    expect(withBase.changed).toEqual(["apps/api/committed.ts"]);
    expect(withBase.results).toHaveLength(1);

    const withoutBase = onlyReport([await verifyIn(root)]);
    expect(withoutBase.changed).toEqual([]);
    expect(withoutBase.results).toEqual([]);
  });

  it("says a directory that is not a checkout root cannot be measured", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-verify-plain-"));
    const record = await verifyIn(root);
    expect(record).toMatchObject({
      _tag: "VerifyUnmeasured",
      reason: "no-checkout",
    });
  });

  it("records a verification that times out as unrunnable, with what it printed", async () => {
    const root = checkout({
      [`${API_SKILL}/drive.sh`]: "echo started\nsleep 30\n",
    });
    write(root, "apps/api/x.ts", "x\n");

    const report = onlyReport([await verifyIn(root, { timeoutSeconds: 1 })]);
    const [result] = report.results;
    if (result?._tag !== "VerifyUnrunnable")
      throw new Error(`expected unrunnable, got ${JSON.stringify(result)}`);
    expect(result.code).toBe("timeout");
    // The shell may add its own line about the killed child; what the drive printed is kept.
    expect(result.output.startsWith("started\n")).toBe(true);
  });

  it("runs down.sh on its own when the skill's script is stopped by a timeout", async () => {
    const root = checkout({
      [`${API_SKILL}/up.sh`]: "echo up\n",
      [`${API_SKILL}/drive.sh`]: "echo started\nsleep 30\n",
      [`${API_SKILL}/down.sh`]: "echo down\ntouch down.ran\n",
    });
    write(root, "apps/api/x.ts", "x\n");

    const report = onlyReport([await verifyIn(root, { timeoutSeconds: 1 })]);
    const [result] = report.results;
    if (result?._tag !== "VerifyUnrunnable")
      throw new Error(`expected unrunnable, got ${JSON.stringify(result)}`);
    expect(result.code).toBe("timeout");
    // The group kill stopped the script before its own down.sh; the tool ran it after.
    expect(existsSync(join(root, API_SKILL, "down.ran"))).toBe(true);
    expect(result.output).toContain("running down.sh after timeout\ndown\n");
  });

  it("runs a declared command once per call, told every surface the change named", async () => {
    const root = checkout({
      [`${API_SKILL}/drive.sh`]: "echo skill\n",
    });
    const runs = join(root, "runs.log");
    write(root, "apps/api/x.ts", "x\n");
    write(root, "apps/web/x.ts", "x\n");
    write(root, "docs/notes.md", "x\n");

    const report = onlyReport([
      await verifyIn(root, {
        command: `echo run >> "${runs}"; echo "for $FACTORY_VERIFY_SURFACE covering $FACTORY_VERIFY_SURFACES"`,
      }),
    ]);
    // A whole-repo command is not repeated per surface: one run, one result, for the repo.
    expect(readFileSync(runs, "utf8")).toBe("run\n");
    expect(
      report.results.map((result) =>
        result._tag === "VerifyRan" ? [result.surface, result.output] : result,
      ),
    ).toEqual([[REPO_SURFACE, "for . covering api web .\n"]]);
  });

  it("tells a skill only its own surface", async () => {
    const root = checkout({
      [`${API_SKILL}/drive.sh`]:
        'echo "$FACTORY_VERIFY_SURFACE/$FACTORY_VERIFY_SURFACES"\n',
    });
    write(root, "apps/api/x.ts", "x\n");
    write(root, "apps/web/x.ts", "x\n");

    const report = onlyReport([await verifyIn(root)]);
    expect(
      report.results.map((result) =>
        result._tag === "VerifyRan" ? result.output : result._tag,
      ),
    ).toEqual(["api/api\n", "VerifyNoEvidence"]);
  });

  it("names changed paths outside every package as no evidence when the repo declares no command", async () => {
    const root = checkout({});
    write(root, "src/app.ts", "x\n");

    const report = onlyReport([await verifyIn(root)]);
    expect(report.results).toEqual([
      expect.objectContaining({
        _tag: "VerifyNoEvidence",
        surface: REPO_SURFACE,
        reason: "no-surface",
      }),
    ]);
    // Never an empty report for a non-empty change: a gate cannot read silence as a pass.
    expect(describeVerify(report)).toContain(
      "[.] no evidence for 1 changed path(s)",
    );
    expect(describeVerify(report)).toContain("src/app.ts");
  });

  it("never hands a verification the control plane's database, only the one it is given", async () => {
    const root = checkout({
      // `${VAR:-default}` is how a shell consumer falls back on an unset *or blank* variable.
      [`${API_SKILL}/drive.sh`]:
        'echo "${DATABASE_URL:-postgres://localhost:5442/factory}"\n',
    });
    write(root, "apps/api/x.ts", "x\n");
    // The control plane's database, in the environment every session command inherits.
    const env = new NodeExecutionEnv({
      cwd: root,
      shellEnv: { DATABASE_URL: "postgres://control-plane/factory" },
    });
    const outputOf = async (options: VerifyOptions) => {
      const [result] = onlyReport([
        await run(runVerify({ env, options })),
      ]).results;
      return result?._tag === "VerifyRan" ? result.output : result?._tag;
    };
    // What a consumer that reads it resolves, not only what it is set to: Effect's `Config` with a
    // default — `@repo/storage-postgres`'s `DatabaseConfig` shape — reads a blank as missing.
    const CONTROL_PLANE = "postgres://factory:factory@localhost:5442/factory";
    const resolved = (url: string) =>
      run(
        Config.String("DATABASE_URL")
          .pipe(Config.withDefault(CONTROL_PLANE))
          .parse(ConfigProvider.fromEnv({ env: { DATABASE_URL: url } })),
      );
    const given = (await outputOf({}))?.trim() ?? "";
    expect(given).toBe(VERIFY_NO_DATABASE);
    expect(await resolved(given)).toBe(VERIFY_NO_DATABASE);
    expect(new URL(given).hostname.endsWith(".invalid")).toBe(true);
    // A blank override is no database too, never a fall back on the default.
    expect((await outputOf({ databaseUrl: " " }))?.trim()).toBe(
      VERIFY_NO_DATABASE,
    );
    expect(await outputOf({ databaseUrl: "postgres://verify/own" })).toBe(
      "postgres://verify/own\n",
    );
  });

  it("stops waiting for the lock when its call is aborted, and starts nothing", async () => {
    const root = checkout({
      [`${API_SKILL}/up.sh`]: "touch up.ran\n",
      [`${API_SKILL}/drive.sh`]: "touch drive.ran\n",
      [`${API_SKILL}/down.sh`]: "touch down.ran\n",
    });
    write(root, "apps/api/x.ts", "x\n");
    // Another session's verification holds the lock for as long as it likes.
    const holder = Effect.runFork(verifyLock.withPermit(Effect.never));
    await run(Effect.sleep("20 millis"));
    try {
      const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
      const call = executeVerify({
        env: new NodeExecutionEnv({ cwd: root }),
        options: {},
        onOutput: () => undefined,
        context,
      });
      const aborting = run(Effect.sleep("200 millis")).then(() => cancel());
      await expect(call).rejects.toThrow("verify aborted");
      await aborting;
    } finally {
      await run(Fiber.interrupt(holder));
    }
    // Once the lock is free, the aborted call does not wake up and run on its dead context.
    await run(Effect.sleep("300 millis"));
    for (const file of ["up.ran", "drive.ran", "down.ran"])
      expect(existsSync(join(root, API_SKILL, file))).toBe(false);
  });

  it("still runs down.sh when a call is aborted mid-drive, before it lets go of the lock", async () => {
    const root = checkout({
      [`${API_SKILL}/up.sh`]: "echo up\n",
      [`${API_SKILL}/drive.sh`]: "echo started\nsleep 30\n",
      [`${API_SKILL}/down.sh`]: "touch down.ran\n",
    });
    write(root, "apps/api/x.ts", "x\n");
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
    let output = "";
    const call = executeVerify({
      env: new NodeExecutionEnv({ cwd: root }),
      options: {},
      onOutput: (text) => {
        output += text;
        if (text.includes("started")) cancel();
      },
      context,
    });
    await expect(call).rejects.toThrow("verify aborted");
    expect(existsSync(join(root, API_SKILL, "down.ran"))).toBe(true);
    expect(output).toContain("running down.sh after");
  });

  it("serializes verifications across calls, so two sessions never drive at once", async () => {
    const log = join(
      mkdtempSync(join(tmpdir(), "factory-verify-lock-")),
      "log",
    );
    const drive = `echo start >> "${log}"\nsleep 0.5\necho end >> "${log}"\n`;
    const first = checkout({ [`${API_SKILL}/drive.sh`]: drive });
    const second = checkout({ [`${API_SKILL}/drive.sh`]: drive });
    write(first, "apps/api/x.ts", "x\n");
    write(second, "apps/api/x.ts", "x\n");

    await Promise.all([verifyIn(first), verifyIn(second)]);

    expect(readFileSync(log, "utf8")).toBe("start\nend\nstart\nend\n");
  });

  it("caps the changed paths the record and the text carry, and keeps the whole count", async () => {
    const root = checkout({});
    const total = VERIFY_CHANGED_LIMIT.record + 25;
    for (let index = 0; index < total; index++)
      write(
        root,
        `generated/file-${String(index).padStart(4, "0")}.txt`,
        "x\n",
      );

    const report = onlyReport([await verifyIn(root)]);
    expect(report.changedCount).toBe(total);
    expect(report.changed).toHaveLength(VERIFY_CHANGED_LIMIT.record);
    const text = describeVerify(report);
    expect(text).toContain(`and ${total - VERIFY_CHANGED_LIMIT.text} more`);
    expect(text).not.toContain("file-0100");
  });

  it("reports no session environment as unmeasured", async () => {
    expect(await run(runVerify({ env: undefined }))).toMatchObject({
      _tag: "VerifyUnmeasured",
      reason: "no-environment",
    });
  });
});

describe("surfaceOf", () => {
  it.each([
    ["apps/api/src/main.ts", "api"],
    ["apps/web/src/routes/index.tsx", "web"],
    ["packages/core/src/prStep.ts", "core"],
    [".pi/skills/verify-board/drive.sh", "board"],
    ["apps/api", undefined],
    ["docs/design.md", undefined],
    ["README.md", undefined],
    [".pi/skills/effect/SKILL.md", undefined],
    ["apps/-bad/x.ts", undefined],
  ])("%s → %s", (path, surface) => {
    expect(surfaceOf(path)).toBe(surface);
  });
});

describe("tailOf", () => {
  it("keeps short output whole", () => {
    expect(tailOf("a\nb\n", { maxChars: 10, maxLines: 5 })).toEqual({
      output: "a\nb\n",
      truncated: false,
    });
  });

  it("keeps the last lines when there are too many", () => {
    expect(tailOf("1\n2\n3\n4\n", { maxChars: 100, maxLines: 2 })).toEqual({
      output: "3\n4\n",
      truncated: true,
    });
  });

  it("keeps the last characters when the output is too long", () => {
    expect(tailOf("abcdefghij", { maxChars: 4, maxLines: 10 })).toEqual({
      output: "ghij",
      truncated: true,
    });
  });
});

/**
 * The PR's evidence (LOB-79), derived from the records the tool commits. The body that renders it is
 * `packages/core`'s; what is decided here is *which* record a PR may cite and what an empty one says.
 */
describe("prEvidenceOf", () => {
  const report = (
    results: VerifyReport["results"],
    changedCount = 1,
  ): VerifyRecord => ({
    _tag: "VerifyReport",
    changed: ["apps/api/src/feature.ts"],
    changedCount,
    results,
  });
  const ran = (exitCode: number, output: string): VerifyReport["results"] => [
    {
      _tag: "VerifyRan",
      surface: "api",
      source: "skill",
      directory: API_SKILL,
      command: "bash drive.sh",
      exitCode,
      output,
      truncated: false,
    },
  ];

  it("says the run never verified when there is no record", () => {
    expect(prEvidenceOf([])).toEqual({
      _tag: "EvidenceNone",
      reason: "not-verified",
      message: "the run never called the `verify` tool",
    });
  });

  it("cites the last call, and counts the earlier ones", () => {
    // A pass the run later broke is not a claim the PR may make, and neither is a failure it fixed.
    const evidence = prEvidenceOf([
      report(ran(0, "first pass\n")),
      report(ran(3, "then it broke\n"), 2),
    ]);
    expect(evidence).toEqual({
      _tag: "EvidenceRecorded",
      calls: 2,
      changedCount: 2,
      results: [
        {
          _tag: "VerificationRan",
          surface: "api",
          name: "verify-api",
          source: "skill",
          command: "bash drive.sh",
          exitCode: 3,
          excerpt: "then it broke\n",
          truncated: false,
        },
      ],
    });
  });

  it("names a declared command as the repo's own, and keeps an unrunnable one's code", () => {
    const evidence = prEvidenceOf([
      report([
        {
          _tag: "VerifyUnrunnable",
          surface: REPO_SURFACE,
          source: "workspace",
          directory: ".",
          command: "bun run test",
          code: "timeout",
          message: "timed out after 1800s",
          output: "partial\n",
          truncated: true,
        },
        {
          _tag: "VerifyNoEvidence",
          surface: "web",
          reason: "no-verify-skill",
          message: 'no evidence for surface "web"',
        },
      ]),
    ]);
    expect(evidence).toEqual({
      _tag: "EvidenceRecorded",
      calls: 1,
      changedCount: 1,
      results: [
        {
          _tag: "VerificationUnrunnable",
          surface: REPO_SURFACE,
          name: "commands.verify",
          source: "workspace",
          command: "bun run test",
          code: "timeout",
          message: "timed out after 1800s",
          excerpt: "partial\n",
          // The record's own cut is carried: the excerpt is not all the command printed.
          truncated: true,
        },
        {
          _tag: "VerificationMissing",
          surface: "web",
          message: 'no evidence for surface "web"',
        },
      ],
    });
  });

  it("says why when the last call measured nothing or found nothing changed", () => {
    expect(
      prEvidenceOf([
        report(ran(0, "ok\n")),
        { _tag: "VerifyUnmeasured", reason: "git-failed", message: "boom" },
      ]),
    ).toEqual({
      _tag: "EvidenceNone",
      reason: "unmeasured",
      message:
        "the last recorded `verify` call could not measure what changed (git-failed)",
      // The tool's own words are kept apart from the factory's: the body quotes them as code.
      detail: "boom",
    });
    expect(prEvidenceOf([report([], 0)])).toMatchObject({
      _tag: "EvidenceNone",
      reason: "no-changes",
    });
  });

  it("keeps the worktree's host path off the PR", () => {
    const worktree = "/srv/factory/sessions/abc";
    expect(
      prEvidenceOf(
        [
          {
            _tag: "VerifyUnmeasured",
            reason: "no-checkout",
            message: `${worktree} is not a checkout root, so the run's changes cannot be measured`,
          },
        ],
        { worktree },
      ),
    ).toMatchObject({
      detail:
        "<worktree> is not a checkout root, so the run's changes cannot be measured",
    });
    const evidence = prEvidenceOf(
      [
        report([
          {
            _tag: "VerifyUnrunnable",
            surface: "api",
            source: "skill",
            directory: API_SKILL,
            command: "bash drive.sh",
            code: "spawn_failed",
            message: `spawn bash ENOENT in ${worktree}/${API_SKILL}`,
            output: "",
            truncated: false,
          },
        ]),
      ],
      { worktree },
    );
    expect(evidence).toMatchObject({
      results: [{ message: `spawn bash ENOENT in <worktree>/${API_SKILL}` }],
    });
  });

  it("counts a newest call that left no record instead of citing an older one as the last", () => {
    // A blocked or crashed call has no decodable details: `verifyCallsIn` gives it as `undefined`.
    const evidence = prEvidenceOf([report(ran(0, "pass\n")), undefined]);
    expect(evidence).toMatchObject({
      _tag: "EvidenceRecorded",
      calls: 2,
      unrecordedAfter: 1,
    });
    expect(prEvidenceOf([report(ran(0, "pass\n"))])).not.toHaveProperty(
      "unrecordedAfter",
    );
    expect(prEvidenceOf([undefined, undefined])).toEqual({
      _tag: "EvidenceNone",
      reason: "unrecorded",
      message:
        "none of the run's 2 `verify` call(s) left a record (blocked or crashed)",
    });
  });

  it("compares the cited call's measured paths with the PR's", () => {
    // The record measured one path; the run then committed two more before the PR opened.
    const stale = prEvidenceOf([report(ran(0, "pass\n"))], {
      published: ["docs/later.md", "apps/api/src/feature.ts", "apps/api/b.ts"],
    });
    expect(stale).toMatchObject({
      coverage: {
        published: 3,
        covered: 1,
        missed: ["apps/api/b.ts", "docs/later.md"],
      },
    });
    const fresh = prEvidenceOf([report(ran(0, "pass\n"))], {
      published: ["apps/api/src/feature.ts"],
    });
    expect(fresh).toMatchObject({
      coverage: { published: 1, covered: 1, missed: [] },
    });
    // Unmeasured PR paths are no comparison at all, not a "covers nothing".
    expect(prEvidenceOf([report(ran(0, "pass\n"))])).not.toHaveProperty(
      "coverage",
    );
  });

  it("cuts the excerpt to the PR's bound, deterministically, and marks it", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join(
      "",
    );
    const once = prEvidenceOf([report(ran(0, output))]);
    expect(prEvidenceOf([report(ran(0, output))])).toEqual(once);
    expect(once).toMatchObject({
      results: [
        {
          excerpt: tailOf(output, PR_EVIDENCE_EXCERPT).output,
          truncated: true,
        },
      ],
    });
    expect(
      tailOf(output, PR_EVIDENCE_EXCERPT).output.startsWith("line 60\n"),
    ).toBe(true);
  });
});
