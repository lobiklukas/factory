/**
 * The in-process runtime (LOB-88): the shared conformance suite, Pi Durable's `ExecutionEnv`
 * suite over its adapter, and what its descriptor says it does not provide, observed from the
 * host. Then a sandbox bound to a directory that already exists (LOB-244), which Pi Durable's suite
 * holds to the same oracle.
 */
import {
  chmodSync,
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
  registerEnvConformance,
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

/** Run against a fresh in-process runtime with its `bind`, released when the body ends. */
const withBindable = <A, E>(
  body: (
    runtime: Effect.Success<ReturnType<typeof InProcess.make>>,
  ) => Effect.Effect<A, E, Scope.Scope>,
  options: InProcess.InProcessOptions = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* InProcess.make(options));
    }).pipe(Effect.scoped),
  );

// The environment of a sandbox bound to an existing directory is held to the oracle a created
// one is: the suite's cases write and list relative to the cwd, so they run in the bound directory.
registerEnvConformance(
  { describe, expect, it },
  "in-process runtime, bound to an existing directory: ExecutionEnv",
  (use) =>
    withBindable((runtime) =>
      Effect.gen(function* () {
        const directory = mkdtempSync(join(scratch, "bound-conformance-"));
        const sandbox = yield* Effect.acquireRelease(
          Effect.orDie(runtime.bind(directory)),
          (bound) => Effect.ignore(runtime.destroy(bound)),
        );
        const env = yield* Effect.orDie(runtime.executionEnv(sandbox));
        expect(env.cwd).toBe(realpathSync(directory));
        yield* Effect.promise(() => use(env));
      }),
    ),
);

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
    ).toBe(19);
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
    expect(result).toEqual({
      exitCode: 0,
      stdout: "finished",
      stderr: "",
      truncated: false,
    });
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

// A directory its owner may not write: removing the workdir under it fails, as a busy or
// permission-damaged workdir would. Root ignores the mode, so the cases need another user.
const asRoot = process.getuid?.() === 0;

/** A workdir the host cannot remove until `unlock` runs. */
const lock = (workdir: string): (() => void) => {
  const locked = join(workdir, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "f.txt"), "x");
  chmodSync(locked, 0o500);
  return () => chmodSync(locked, 0o700);
};

describe.skipIf(asRoot)("a destroy whose cleanup fails", () => {
  it("fails with SandboxFileError, and a retry finishes the cleanup", async () => {
    const root = mkdtempSync(join(scratch, "failing-"));
    const { workdir, failed, during, retried } = await withRuntime(
      (runtime) =>
        Effect.gen(function* () {
          const sandbox = yield* runtime.create;
          const unlock = lock(sandbox.workdir);
          const failed = yield* Effect.flip(runtime.destroy(sandbox));
          // Half destroyed is destroyed to every other operation.
          const during = yield* Effect.flip(runtime.readFile(sandbox, "x"));
          unlock();
          yield* runtime.destroy(sandbox);
          return {
            workdir: sandbox.workdir,
            failed,
            during,
            retried: existsSync(sandbox.workdir),
          };
        }),
      { root },
    );
    expect(failed).toMatchObject({
      _tag: "SandboxFileError",
      code: "permission_denied",
    });
    expect(during._tag).toBe("SandboxNotFound");
    expect(retried).toBe(false);
    expect(existsSync(workdir)).toBe(false);
  });

  it("releasing the runtime destroys every other sandbox, and finishes a half-destroyed one", async () => {
    const root = mkdtempSync(join(scratch, "failing-"));
    let unlockStuck = () => {};
    const { stuck, half, other } = await withRuntime(
      (runtime) =>
        Effect.gen(function* () {
          const stuck = yield* runtime.create;
          const half = yield* runtime.create;
          const other = yield* runtime.create;
          unlockStuck = lock(stuck.workdir);
          const unlockHalf = lock(half.workdir);
          yield* Effect.flip(runtime.destroy(half));
          unlockHalf();
          return { stuck, half, other };
        }),
      { root },
    );
    // The stuck one could not be removed, and that stopped neither of the others.
    expect(existsSync(stuck.workdir)).toBe(true);
    expect(existsSync(half.workdir)).toBe(false);
    expect(existsSync(other.workdir)).toBe(false);
    unlockStuck();
  });
});

describe("a sandbox bound to an existing directory", () => {
  it("runs its commands there, reading the files the directory already held", async () => {
    const directory = mkdtempSync(join(scratch, "bound-"));
    writeFileSync(join(directory, "marker.txt"), "already here");
    const { sandbox, pwd, cat, read } = await withBindable((runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.bind(directory);
        const pwd = yield* runtime.exec(sandbox, "pwd -P");
        const cat = yield* runtime.exec(sandbox, "cat marker.txt");
        const env = yield* runtime.executionEnv(sandbox);
        const read = yield* Effect.promise(() =>
          env.readTextFile("marker.txt", context),
        );
        return { sandbox, pwd, cat, read };
      }),
    );
    expect(sandbox.workdir).toBe(realpathSync(directory));
    expect(pwd.stdout.trim()).toBe(realpathSync(directory));
    expect(cat.stdout).toBe("already here");
    expect(read).toEqual({ ok: true, value: "already here" });
  });

  it("resolves a relative directory against the server's working directory", async () => {
    const directory = mkdtempSync(join(scratch, "bound-relative-"));
    const relative = join(
      ...Array.from({ length: process.cwd().split("/").length }, () => ".."),
      directory,
    );
    const workdir = await withBindable((runtime) =>
      runtime.bind(relative).pipe(Effect.map((sandbox) => sandbox.workdir)),
    );
    expect(workdir).toBe(realpathSync(directory));
  });

  it("leaves every file in the directory when destroyed, and when the runtime is released", async () => {
    const destroyedDir = mkdtempSync(join(scratch, "bound-destroyed-"));
    const releasedDir = mkdtempSync(join(scratch, "bound-released-"));
    const { destroyedExec } = await withBindable((runtime) =>
      Effect.gen(function* () {
        const destroyed = yield* runtime.bind(destroyedDir);
        yield* runtime.writeFile(destroyed, "made/inside.txt", "kept");
        yield* runtime.destroy(destroyed);
        const destroyedExec = yield* Effect.flip(
          runtime.exec(destroyed, "true"),
        );
        const released = yield* runtime.bind(releasedDir);
        yield* runtime.writeFile(released, "made/inside.txt", "kept too");
        return { destroyedExec };
      }),
    );
    // Ended, as any sandbox is: the runtime no longer knows it.
    expect(destroyedExec._tag).toBe("SandboxNotFound");
    expect(readdirSync(destroyedDir)).toEqual(["made"]);
    expect(readdirSync(join(destroyedDir, "made"))).toEqual(["inside.txt"]);
    expect(readdirSync(join(releasedDir, "made"))).toEqual(["inside.txt"]);
  });

  it("still removes a created sandbox's workdir beside a bound one (the control for the case above)", async () => {
    const directory = mkdtempSync(join(scratch, "bound-control-"));
    const created = await withBindable((runtime) =>
      Effect.gen(function* () {
        yield* runtime.bind(directory);
        return yield* runtime.create;
      }),
    );
    expect(existsSync(created.workdir)).toBe(false);
    expect(existsSync(directory)).toBe(true);
  });

  it("refuses a directory that does not exist, and a path that is a file", async () => {
    const file = join(scratch, "bound-not-a-directory.txt");
    writeFileSync(file, "x");
    const { missing, notDirectory } = await withBindable((runtime) =>
      Effect.gen(function* () {
        const missing = yield* Effect.flip(
          runtime.bind(join(scratch, "bound-missing")),
        );
        const notDirectory = yield* Effect.flip(runtime.bind(file));
        return { missing, notDirectory };
      }),
    );
    expect(missing).toMatchObject({
      _tag: "SandboxFileError",
      code: "not_found",
    });
    expect(notDirectory).toMatchObject({
      _tag: "SandboxFileError",
      code: "not_directory",
    });
  });

  it("starts its commands with the variables it was bound with, over the runtime's", async () => {
    const directory = mkdtempSync(join(scratch, "bound-env-"));
    const result = await withBindable(
      (runtime) =>
        Effect.gen(function* () {
          const sandbox = yield* runtime.bind(directory, {
            env: { BOUND_ONLY: "bound", SHARED: "bound wins", WITHHELD: "" },
          });
          return yield* runtime.exec(
            sandbox,
            'printf "%s|%s|%s|[%s]" "$RUNTIME_ONLY" "$BOUND_ONLY" "$SHARED" "$WITHHELD"',
          );
        }),
      {
        shellEnv: {
          RUNTIME_ONLY: "runtime",
          SHARED: "runtime",
          WITHHELD: "runtime value",
        },
      },
    );
    expect(result.stdout).toBe("runtime|bound|bound wins|[]");
  });

  it("makes no temporary root while it only binds, and makes one with its first create", async () => {
    // The temporary root goes under a directory of this case's own, not the shared tmpdir, which
    // other processes' runtimes (sibling worktrees' gates) fill and empty at the same time.
    const ownTmp = mkdtempSync(join(scratch, "own-tmpdir-"));
    // oxlint-disable-next-line effecttsgo/process-env -- the host's tmpdir is what the case varies.
    const previous = process.env["TMPDIR"];
    // oxlint-disable-next-line effecttsgo/process-env -- the host's tmpdir is what the case varies.
    process.env["TMPDIR"] = ownTmp;
    try {
      expect(tmpdir()).toBe(ownTmp);
      const observed = await withBindable((runtime) =>
        Effect.gen(function* () {
          yield* runtime.bind(mkdtempSync(join(scratch, "bound-lazy-")));
          const binding = readdirSync(ownTmp);
          yield* runtime.create;
          // The control: the root does land here once a sandbox needs one.
          const creating = readdirSync(ownTmp);
          return { binding, creating };
        }),
      );
      expect(observed.binding).toEqual([]);
      expect(observed.creating).toEqual([
        expect.stringMatching(/^factory-sandboxes-/),
      ]);
      expect(readdirSync(ownTmp)).toEqual([]);
    } finally {
      // oxlint-disable-next-line effecttsgo/process-env -- the host's tmpdir is what the case varies.
      if (previous === undefined) delete process.env["TMPDIR"];
      // oxlint-disable-next-line effecttsgo/process-env -- the host's tmpdir is what the case varies.
      else process.env["TMPDIR"] = previous;
    }
  });
});
