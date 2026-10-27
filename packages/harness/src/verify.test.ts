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
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createFauxModelAccess } from "./models";
import {
  closeHarness,
  openSession,
  readSessionLog,
  submitMessage,
} from "./session";
import {
  readVerifyRecords,
  runVerify,
  skillScript,
  surfaceOf,
  tailOf,
  VERIFY_OUTPUT_TAIL,
  VERIFY_TOOL,
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

describe("the verify tool, through a session's log", () => {
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
    const command = 'echo "from-workspace $FACTORY_VERIFY_SURFACE"';

    const turn = await verifiedTurn(root, { command });

    const report = onlyReport(turn.records);
    expect(report.results).toEqual([
      {
        _tag: "VerifyRan",
        surface: "api",
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
});

/** One pass of the tool's work over a checkout, without a model in between. */
const verifyIn = (cwd: string, options?: VerifyOptions) =>
  run(
    runVerify({
      env: new NodeExecutionEnv({ cwd }),
      ...(options === undefined ? {} : { options }),
    }),
  );

describe("runVerify", () => {
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
  }, 15_000);

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
