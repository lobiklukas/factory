/**
 * The worktree setup (S-env-setup): `install` then `build`, run in an `ExecutionEnv`, stopping at the
 * first that fails, recorded with exit codes and output tails — and that record committed to a log
 * and read back, by its owner and by a reader. Real processes in a temporary directory through Pi
 * Durable's `NodeExecutionEnv`; the log is Pi Durable's in-memory storage with the faux model, which
 * no case here calls.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Effect, Fiber } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { createFauxModelAccess } from "./models";
import { closeSession, openSession } from "./session";
import {
  readLoggedSetup,
  readSetupRecord,
  rootEverSubmitted,
  runSetup,
  SETUP_NOTE_TAIL,
  setupCovers,
  setupFailureText,
  setupSteps,
  writeSetupRecord,
  type SetupRecord,
} from "./setup";
import { VERIFY_NO_DATABASE, VERIFY_OUTPUT_TAIL } from "./verify";

/** Every case spawns real shells; under a loaded machine vitest's 5 s default is too tight. */
const SPAWNS = 30_000;

const workdirs: string[] = [];
const workdir = () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-setup-"));
  workdirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of workdirs) rmSync(dir, { recursive: true, force: true });
});

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

describe("a setup's cut (F23)", () => {
  const record = (cut?: string): SetupRecord => ({
    outcome: "succeeded",
    directory: "/w",
    steps: [],
    startedAt: "2026-10-28T00:00:00.000Z",
    finishedAt: "2026-10-28T00:00:01.000Z",
    ...(cut === undefined ? {} : { cut }),
  });

  /** Mutation: compare only when both are present but treat a mismatch as covered (always true). */
  it("covers the worktree it ran in and not one cut since, and reads a cutless record beside a named cut as stale", () => {
    expect(setupCovers(record("a"), "a")).toBe(true);
    expect(setupCovers(record("a"), "b")).toBe(false);
    // A record from before cuts were named beside a worktree that has one: the worktree was cut
    // since, so it is set up again.
    expect(setupCovers(record(), "b")).toBe(false);
    // Nothing to tell apart: a directory with no cut.
    expect(setupCovers(record("a"), undefined)).toBe(true);
    expect(setupCovers(record(), undefined)).toBe(true);
  });

  it(
    "is recorded with the steps, and left out of a record that has none",
    async () => {
      const cwd = workdir();
      const named = await Effect.runPromise(
        runSetup({
          env: new NodeExecutionEnv({ cwd }),
          commands: { install: "true" },
          cut: "cut-1",
        }),
      );
      expect(named?.cut).toBe("cut-1");
      const unnamed = await run(cwd, { install: "true" });
      expect(unnamed).not.toHaveProperty("cut");
    },
    SPAWNS,
  );
});

describe("runSetup", () => {
  it(
    "records nothing for a repo that declares neither command",
    async () => {
      expect(await run(workdir(), { verify: "true" })).toBeUndefined();
    },
    SPAWNS,
  );

  it(
    "runs install then build in the environment's directory, each to exit 0",
    async () => {
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
    },
    SPAWNS,
  );

  it(
    "stops at a failed install: the build never runs, and the exit code and output are kept",
    async () => {
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
    },
    SPAWNS,
  );

  it(
    "fails on a build that fails after an install that passed",
    async () => {
      const record = await run(workdir(), { install: "true", build: "exit 2" });
      expect(record?.outcome).toBe("failed");
      expect(record?.steps.map((step) => step._tag)).toEqual([
        "SetupStepRan",
        "SetupStepRan",
      ]);
      expect(record?.steps[1]).toMatchObject({ step: "build", exitCode: 2 });
    },
    SPAWNS,
  );

  it(
    "records a step that outlives its timeout as unrunnable, with its code",
    async () => {
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
    },
    SPAWNS,
  );

  it(
    "stops the step's process when the setup is interrupted, rather than leaving it running",
    async () => {
      const cwd = workdir();
      const marker = join(cwd, "finished.txt");
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            runSetup({
              env: new NodeExecutionEnv({ cwd }),
              commands: {
                install: `echo started > started.txt; sleep 2; echo done > ${marker}`,
              },
            }),
          );
          for (
            let i = 0;
            i < 200 && !existsSync(join(cwd, "started.txt"));
            i += 1
          )
            yield* Effect.sleep(25);
          yield* Fiber.interrupt(fiber);
          // Past the point the command would have finished, had the interruption not killed it.
          yield* Effect.sleep(3_000);
        }),
      );
      expect(existsSync(join(cwd, "started.txt"))).toBe(true);
      expect(existsSync(marker)).toBe(false);
    },
    SPAWNS,
  );

  it(
    "keeps only the tail of a step that prints more than the record's bound",
    async () => {
      const lines = VERIFY_OUTPUT_TAIL.maxLines + 50;
      const record = await run(workdir(), {
        install: `for i in $(seq 1 ${lines}); do echo "line $i"; done; exit 1`,
      });
      const step = record?.steps[0];
      expect(step?.truncated).toBe(true);
      expect(step?.output.split("\n")).not.toContain("line 1");
      expect(step?.output.endsWith(`line ${lines}\n`)).toBe(true);
    },
    SPAWNS,
  );

  it(
    "never hands a step the control plane's database",
    async () => {
      const record = await run(workdir(), {
        install: 'echo "db=${DATABASE_URL:-unset}"',
      });
      expect(record?.steps[0]?.output).toBe(`db=${VERIFY_NO_DATABASE}\n`);
    },
    SPAWNS,
  );
});

describe("setupFailureText", () => {
  it(
    "names the step, the command, the exit code, the directory and the output's last lines",
    async () => {
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
    },
    SPAWNS,
  );
});

describe("the setup record in the log", () => {
  it(
    "is committed by the owner and read back by the owner and by a reader",
    async () => {
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
    },
    SPAWNS,
  );
});
