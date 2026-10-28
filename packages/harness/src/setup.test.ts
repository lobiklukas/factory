/**
 * The worktree setup (S-env-setup): `install` then `build`, run in an `ExecutionEnv`, stopping at the
 * first that fails, recorded with exit codes and output tails — and that record committed to a log
 * and read back, by its owner and by a reader. Real processes in a temporary directory through Pi
 * Durable's `NodeExecutionEnv`; the log is Pi Durable's in-memory storage with the faux model, which
 * no case here calls.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createFauxModelAccess } from "./models";
import { closeSession, openSession } from "./session";
import {
  readLoggedSetup,
  readSetupRecord,
  rootEverSubmitted,
  runSetup,
  SETUP_NOTE_TAIL,
  setupFailureText,
  setupSteps,
  writeSetupRecord,
  type SetupRecord,
} from "./setup";
import { VERIFY_NO_DATABASE, VERIFY_OUTPUT_TAIL } from "./verify";

const workdir = () => mkdtempSync(join(tmpdir(), "factory-setup-"));

const run = (
  cwd: string,
  commands: Parameters<typeof runSetup>[0]["commands"],
) =>
  Effect.runPromise(runSetup({ env: new NodeExecutionEnv({ cwd }), commands }));

describe("setupSteps", () => {
  it("is install then build, whatever order the config names them in, and skips blanks", () => {
    expect(setupSteps({ build: "b", install: "i", test: "t" })).toEqual([
      { step: "install", command: "i" },
      { step: "build", command: "b" },
    ]);
    expect(setupSteps({ install: "  ", build: "b" })).toEqual([
      { step: "build", command: "b" },
    ]);
    expect(setupSteps({ test: "t", verify: "v" })).toEqual([]);
  });
});

describe("runSetup", () => {
  it("records nothing for a repo that declares neither command", async () => {
    expect(await run(workdir(), { verify: "true" })).toBeUndefined();
  });

  it("runs install then build in the environment's directory, each to exit 0", async () => {
    const cwd = workdir();
    const record = await run(cwd, {
      install: "echo installing; echo installed > installed.txt",
      build: "cat installed.txt > built.txt; echo built",
    });
    expect(record?.outcome).toBe("succeeded");
    expect(record?.directory).toBe(cwd);
    expect(record?.steps).toEqual([
      expect.objectContaining({
        _tag: "SetupStepRan",
        step: "install",
        exitCode: 0,
        output: "installing\n",
        truncated: false,
      }),
      expect.objectContaining({
        _tag: "SetupStepRan",
        step: "build",
        exitCode: 0,
        output: "built\n",
      }),
    ]);
    // The build ran after the install, in the same directory: it read what the install wrote.
    expect(readFileSync(join(cwd, "built.txt"), "utf8")).toBe("installed\n");
  });

  it("stops at a failed install: the build never runs, and the exit code and output are kept", async () => {
    const cwd = workdir();
    const record = await run(cwd, {
      install:
        'echo "resolving"; echo "error: registry unreachable" >&2; exit 7',
      build: "touch built.txt",
    });
    expect(record?.outcome).toBe("failed");
    expect(record?.steps).toHaveLength(1);
    expect(record?.steps[0]).toMatchObject({
      _tag: "SetupStepRan",
      step: "install",
      exitCode: 7,
    });
    expect(record?.steps[0]?.output).toContain("resolving\n");
    expect(record?.steps[0]?.output).toContain("error: registry unreachable");
    expect(existsSync(join(cwd, "built.txt"))).toBe(false);
  });

  it("fails on a build that fails after an install that passed", async () => {
    const record = await run(workdir(), { install: "true", build: "exit 2" });
    expect(record?.outcome).toBe("failed");
    expect(record?.steps.map((step) => step._tag)).toEqual([
      "SetupStepRan",
      "SetupStepRan",
    ]);
    expect(record?.steps[1]).toMatchObject({ step: "build", exitCode: 2 });
  });

  it("records a step that outlives its timeout as unrunnable, with its code", async () => {
    const record = await Effect.runPromise(
      runSetup({
        env: new NodeExecutionEnv({ cwd: workdir() }),
        commands: { install: "echo started; sleep 30", build: "true" },
        timeoutSeconds: 1,
      }),
    );
    expect(record?.outcome).toBe("failed");
    expect(record?.steps).toHaveLength(1);
    expect(record?.steps[0]).toMatchObject({
      _tag: "SetupStepUnrunnable",
      step: "install",
      code: "timeout",
    });
    expect(record?.steps[0]?.output.startsWith("started\n")).toBe(true);
  }, 20_000);

  it("keeps only the tail of a step that prints more than the record's bound", async () => {
    const lines = VERIFY_OUTPUT_TAIL.maxLines + 50;
    const record = await run(workdir(), {
      install: `for i in $(seq 1 ${lines}); do echo "line $i"; done; exit 1`,
    });
    const step = record?.steps[0];
    expect(step?.truncated).toBe(true);
    expect(step?.output.split("\n")).not.toContain("line 1");
    expect(step?.output.endsWith(`line ${lines}\n`)).toBe(true);
  });

  it("never hands a step the control plane's database", async () => {
    const record = await run(workdir(), {
      install: 'echo "db=${DATABASE_URL:-unset}"',
    });
    expect(record?.steps[0]?.output).toBe(`db=${VERIFY_NO_DATABASE}\n`);
  });
});

describe("setupFailureText", () => {
  it("names the step, the command, the exit code, the directory and the output's last lines", async () => {
    const cwd = workdir();
    const record = await run(cwd, {
      install: `for i in $(seq 1 60); do echo "line $i"; done; echo "boom" >&2; exit 3`,
    });
    if (record === undefined) throw new Error("no record");
    const text = setupFailureText(record);
    const [first, ...rest] = text.split("\n");
    expect(first).toBe(
      `setup failed: install \`for i in $(seq 1 60); do echo "line $i"; done; echo "boom" >&2; exit 3\` exited 3 in ${cwd}`,
    );
    // A short tail, said to be one: the record keeps the long one.
    expect(rest[0]).toBe("…(the last lines of its output)");
    expect(rest.at(-1)).toBe("boom");
    expect(rest.length - 1).toBe(SETUP_NOTE_TAIL.maxLines);
    expect(text).not.toContain("line 1\n");
  });
});

describe("the setup record in the log", () => {
  it("is committed by the owner and read back by the owner and by a reader", async () => {
    const storage = new MemoryStorage();
    const record: SetupRecord = {
      outcome: "failed",
      directory: "/w",
      steps: [
        {
          _tag: "SetupStepRan",
          step: "install",
          command: "bun install",
          exitCode: 1,
          output: "error\n",
          truncated: false,
        },
      ],
      startedAt: "2026-10-28T00:00:00.000Z",
      finishedAt: "2026-10-28T00:00:01.000Z",
    };
    const read = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* openSession({
          storage,
          model: createFauxModelAccess().access,
          cwd: workdir(),
        });
        const before = yield* readSetupRecord(session.harness, session.root);
        const submittedBefore = yield* rootEverSubmitted(storage);
        yield* writeSetupRecord(session.root, record);
        const owner = yield* readSetupRecord(session.harness, session.root);
        const reader = yield* readLoggedSetup(storage);
        yield* closeSession(session);
        return { before, submittedBefore, owner, reader };
      }),
    );
    expect(read.before).toBeUndefined();
    expect(read.submittedBefore).toBe(false);
    expect(read.owner).toEqual(record);
    expect(read.reader).toEqual(record);
  });
});
