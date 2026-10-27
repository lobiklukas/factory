/**
 * The in-process runtime (LOB-88): the shared conformance suite, Pi Durable's `ExecutionEnv`
 * suite over its adapter, and what its descriptor says it does not provide, observed from the
 * host.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  createEnvConformance,
  createExpectAssertions,
} from "@earendil-works/pi-durable/testing";
import { Effect, Exit, Scope } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { InProcess, SandboxCapabilities, SandboxRuntime } from "./index";
import {
  createSandboxRuntimeConformance,
  registerSandboxRuntimeConformance,
} from "./testing";

const context = BACKGROUND_CONTEXT;

registerSandboxRuntimeConformance(
  { describe, expect, it },
  "in-process runtime",
  InProcess.layer(),
);

const scratch = mkdtempSync(join(tmpdir(), "factory-sandbox-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Run against a fresh in-process runtime, released when the body ends. */
const withRuntime = <A, E>(
  body: (
    runtime: typeof SandboxRuntime.Service,
  ) => Effect.Effect<A, E, Scope.Scope>,
  options: InProcess.InProcessOptions = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* SandboxRuntime);
    }).pipe(Effect.scoped, Effect.provide(InProcess.layer(options))),
  );

describe("the suites it runs", () => {
  it("are the size they were when this package was written", () => {
    // A Pi Durable upgrade that adds or drops env cases, or a runtime case lost in an edit, shows
    // up here rather than as a silently shorter run.
    const env = createEnvConformance({
      assertions: createExpectAssertions(expect),
      withEnv: async () => {},
    });
    expect(env.length).toBe(21);
    expect(
      createSandboxRuntimeConformance({ expect }, InProcess.layer()).length,
    ).toBe(18);
  });
});

describe("the in-process capability descriptor", () => {
  const descriptor = InProcess.capabilities;

  it("names exactly the D6 fields, and decodes", () => {
    expect(Object.keys(descriptor).sort()).toEqual([
      "isolation",
      "maxDiskGb",
      "pauseResume",
      "persistence",
      "requiresKeepaliveForLongTasks",
      "runtime",
    ]);
    expect(SandboxCapabilities.make(descriptor)).toEqual(descriptor);
  });

  it("is what the layer's runtime reports", async () => {
    expect(
      await withRuntime((runtime) => Effect.succeed(runtime.capabilities)),
    ).toEqual(descriptor);
  });

  it("runtime: in-process", () => {
    expect(descriptor.runtime).toBe("in-process");
  });

  it("isolation: none — a sandbox's command reads the host's files outside its workdir", async () => {
    expect(descriptor.isolation).toBe("none");
    const outside = join(scratch, "host-secret.txt");
    writeFileSync(outside, "visible from the sandbox");
    const { stdout, envId } = await withRuntime((runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.create;
        const result = yield* runtime.exec(sandbox, ["cat", outside]);
        const env = yield* runtime.executionEnv(sandbox);
        return { stdout: result.stdout, envId: env.id };
      }),
    );
    expect(stdout).toBe("visible from the sandbox");
    // The same file namespace as every local environment: nothing separates them.
    expect(envId).toBe(new NodeExecutionEnv({ cwd: scratch }).id);
  });

  it("persistence: ephemeral — destroy removes the workdir from the host, and so does releasing the runtime", async () => {
    expect(descriptor.persistence).toBe("ephemeral");
    const { destroyed, released } = await withRuntime((runtime) =>
      Effect.gen(function* () {
        const destroyed = yield* runtime.create;
        yield* runtime.writeFile(destroyed, "f.txt", "x");
        expect(existsSync(join(destroyed.workdir, "f.txt"))).toBe(true);
        yield* runtime.destroy(destroyed);
        const released = yield* runtime.create;
        yield* runtime.writeFile(released, "f.txt", "x");
        return { destroyed, released };
      }),
    );
    expect(existsSync(destroyed.workdir)).toBe(false);
    expect(existsSync(released.workdir)).toBe(false);
  });

  it("maxDiskGb: null — it enforces no disk limit of its own", () => {
    expect(descriptor.maxDiskGb).toBeNull();
  });

  it("pauseResume: false — pause and resume are refused and the sandbox is untouched", async () => {
    expect(descriptor.pauseResume).toBe(false);
    const { pause, resume, after } = await withRuntime((runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.create;
        yield* runtime.writeFile(sandbox, "f.txt", "x");
        const pause = yield* Effect.exit(runtime.pause(sandbox));
        const resume = yield* Effect.exit(runtime.resume(sandbox));
        const after = yield* runtime.exec(sandbox, "cat f.txt");
        return { pause, resume, after };
      }),
    );
    expect(Exit.isFailure(pause) && Exit.isFailure(resume)).toBe(true);
    expect(after.stdout).toBe("x");
  });

  it("requiresKeepaliveForLongTasks: false — a command outlives a quiet second with no traffic", async () => {
    expect(descriptor.requiresKeepaliveForLongTasks).toBe(false);
    const result = await withRuntime((runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.create;
        return yield* runtime.exec(sandbox, "sleep 1; printf finished");
      }),
    );
    expect(result).toEqual({ exitCode: 0, stdout: "finished", stderr: "" });
  });
});

describe("the in-process root", () => {
  it("is a temporary directory removed with the runtime when none is given", async () => {
    const workdir = await withRuntime((runtime) =>
      runtime.create.pipe(Effect.map((sandbox) => sandbox.workdir)),
    );
    const root = join(workdir, "..");
    expect(root).toContain("factory-sandboxes-");
    expect(existsSync(root)).toBe(false);
  });

  it("is the caller's directory when given, which outlives the runtime emptied", async () => {
    const root = join(scratch, "given-root");
    mkdirSync(root);
    const workdir = await withRuntime(
      (runtime) =>
        runtime.create.pipe(Effect.map((sandbox) => sandbox.workdir)),
      { root },
    );
    expect(workdir.startsWith(`${realpathSync(root)}/`)).toBe(true);
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("the adapter's lifetime", () => {
  it("stops a watcher when the sandbox is destroyed", async () => {
    // Isolation is none, so the sandbox's environment can watch a host directory outside its
    // workdir; that directory outlives the sandbox, so a watcher left open would still report.
    const watched = join(scratch, "watched");
    mkdirSync(watched);
    const changes: unknown[] = [];
    await withRuntime((runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.create;
        const env = yield* runtime.executionEnv(sandbox);
        const watcher = yield* Effect.promise(() =>
          env.watch(
            [{ path: watched, recursive: true }],
            (change) => changes.push(change),
            context,
          ),
        );
        expect(watcher.ok && watcher.value.mode).toBe("native");
        yield* runtime.destroy(sandbox);
      }),
    );
    writeFileSync(join(watched, "after.txt"), "x");
    // The control below sees this write reported well inside this wait.
    await Effect.runPromise(Effect.sleep("1 second"));
    expect(changes).toEqual([]);
  });

  it("a watcher left open does report the same write (the control for the case above)", async () => {
    const watched = join(scratch, "watched-control");
    mkdirSync(watched);
    const changes: unknown[] = [];
    await withRuntime((runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.create;
        const env = yield* runtime.executionEnv(sandbox);
        const watcher = yield* Effect.promise(() =>
          env.watch(
            [{ path: watched, recursive: true }],
            (change) => changes.push(change),
            context,
          ),
        );
        writeFileSync(join(watched, "after.txt"), "x");
        // Native watches report within about two seconds (Pi Durable's `FileWatcher.mode`).
        yield* Effect.sleep("20 millis").pipe(
          Effect.repeat({ until: () => changes.length > 0, times: 150 }),
        );
        if (watcher.ok)
          yield* Effect.promise(() => watcher.value.close(context));
      }),
    );
    expect(changes.length).toBeGreaterThan(0);
  });

  it("forwards cwd to the environment it wraps", async () => {
    const cwd = await withRuntime((runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.create;
        yield* runtime.writeFile(sandbox, "sub/f.txt", "inside sub");
        const env = yield* runtime.executionEnv(sandbox);
        env.cwd = `${sandbox.workdir}/sub`;
        const read = yield* Effect.promise(() =>
          env.readTextFile("f.txt", context),
        );
        expect(read).toEqual({ ok: true, value: "inside sub" });
        return env.cwd;
      }),
    );
    expect(cwd.endsWith("/sub")).toBe(true);
  });
});
