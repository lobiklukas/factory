/**
 * `SandboxExecutionEnv` on its own (LOB-88): what destroying a sandbox does to the environment
 * it wraps, observed on the wrapped environment, where the wrapper's own refusals cannot hide it.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  BinaryReader,
  DirReader,
  ExecutionError,
  FileError,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxExecutionEnv } from "./env";
import { SandboxId } from "./Sandbox";

const context = BACKGROUND_CONTEXT;
const sandboxId = SandboxId.make("sbx_envtest");

/** A Node environment that keeps the handles it hands out, so a test can probe them later. */
class RecordingEnv extends NodeExecutionEnv {
  readonly binaryReaders: BinaryReader[] = [];
  readonly dirReaders: DirReader[] = [];
  cleanups = 0;

  override async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    callContext: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const result = await super.openBinaryReader(path, options, callContext);
    if (result.ok) this.binaryReaders.push(result.value);
    return result;
  }

  override async openDirReader(
    path: string,
    callContext: Context,
  ): Promise<Result<DirReader, FileError>> {
    const result = await super.openDirReader(path, callContext);
    if (result.ok) this.dirReaders.push(result.value);
    return result;
  }

  override async cleanup(callContext: Context): Promise<void> {
    this.cleanups += 1;
    await super.cleanup(callContext);
  }
}

/**
 * A wrapped environment that ignores cancellation, as one over a remote transport might: the
 * wrapper's refusal must not depend on the wrapped environment checking the signal.
 */
class DeafEnv extends NodeExecutionEnv {
  override writeFile(
    path: string,
    content: string | Uint8Array,
    _callContext: Context,
  ): Promise<Result<void, FileError>> {
    return super.writeFile(path, content, BACKGROUND_CONTEXT);
  }

  override exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    _callContext: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    return super.exec(command, options, BACKGROUND_CONTEXT);
  }
}

let workdir: string;
let inner: RecordingEnv;
let env: SandboxExecutionEnv;

beforeEach(() => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "factory-sandbox-env-")));
  inner = new RecordingEnv({ cwd: workdir });
  env = new SandboxExecutionEnv(inner, sandboxId);
});

afterEach(() => rmSync(workdir, { recursive: true, force: true }));

const code = (result: Result<unknown, { code: string }>): string =>
  result.ok ? "ok" : result.error.code;

/** What reading one byte through a reader the wrapped environment handed out answers. */
const probe = async (reader: BinaryReader | undefined): Promise<string> => {
  if (reader === undefined)
    throw new Error("the wrapped environment opened no reader");
  return code(await reader.read(0, 1, context));
};

describe("a sandbox's environment", () => {
  it("shares the wrapped environment's file namespace and cwd", () => {
    expect(env.id).toBe(inner.id);
    expect(env.cwd).toBe(workdir);
    env.cwd = join(workdir, "sub");
    expect(inner.cwd).toBe(join(workdir, "sub"));
  });

  it("closes the readers opened through it when destroyed, and only those still open", async () => {
    expect(code(await env.writeFile("a.txt", "hello", context))).toBe("ok");
    const open = await env.openBinaryReader("a.txt", undefined, context);
    const closedEarly = await env.openBinaryReader("a.txt", undefined, context);
    const dir = await env.openDirReader(".", context);
    expect(open.ok && closedEarly.ok && dir.ok).toBe(true);
    if (closedEarly.ok) await closedEarly.value.close(context);
    const [innerOpen, innerClosedEarly] = inner.binaryReaders;
    // Still open underneath before the destroy.
    expect(await probe(innerOpen)).toBe("ok");

    await env.destroy(context);

    // Pi Durable's readers answer `invalid` once closed: the wrapper closed them underneath.
    for (const reader of [innerOpen, innerClosedEarly])
      expect(await probe(reader)).toBe("invalid");
    const innerDir = inner.dirReaders[0];
    expect(
      innerDir === undefined ? "none" : code(await innerDir.next(1, context)),
    ).toBe("invalid");
    expect(inner.cleanups).toBe(1);
  });

  it("removes the temporary files and spill files made through it when destroyed", async () => {
    const dir = await env.createTempDir("sandbox-probe-", context);
    const file = await env.createTempFile({ suffix: ".probe" }, context);
    const spilled = await env.exec(
      "seq 1 50",
      { spill: { afterBytes: 10, afterLines: 2 } },
      context,
    );
    const paths = [dir, file].map((result) => (result.ok ? result.value : ""));
    const spillPath = spilled.ok ? spilled.value.spillPath : undefined;
    expect(spillPath).toBeDefined();
    for (const path of [...paths, spillPath ?? ""])
      expect(existsSync(path)).toBe(true);

    await env.destroy(context);

    for (const path of [...paths, spillPath ?? ""])
      expect(existsSync(path)).toBe(false);
  });

  it("refuses every operation once destroyed, and destroying again does nothing", async () => {
    expect(code(await env.writeFile("kept.txt", "x", context))).toBe("ok");
    await env.destroy(context);
    await env.destroy(context);
    expect(env.destroyed).toBe(true);
    expect(inner.cleanups).toBe(1);
    const refusals = await Promise.all([
      env.readTextFile("kept.txt", context),
      env.writeFile("new.txt", "x", context),
      env.exists("kept.txt", context),
      env.listDir(".", context),
      env.openBinaryReader("kept.txt", undefined, context),
      env.watch([{ path: "." }], () => {}, context),
      env.createTempDir(undefined, context),
      env.exec("true", undefined, context),
    ]);
    expect(refusals.map(code)).toEqual(
      Array.from({ length: refusals.length }, () => "aborted"),
    );
    // The refusal is the wrapper's: the wrapped environment would still have answered.
    expect(code(await inner.readTextFile("kept.txt", context))).toBe("ok");
    expect(existsSync(join(workdir, "new.txt"))).toBe(false);
  });

  it("refuses once destroyed even when the wrapped environment ignores cancellation", async () => {
    const deaf = new SandboxExecutionEnv(
      new DeafEnv({ cwd: workdir }),
      sandboxId,
    );
    await deaf.destroy(context);
    const write = await deaf.writeFile("written-after.txt", "x", context);
    const exec = await deaf.exec(
      "printf x > ran-after.txt",
      undefined,
      context,
    );
    expect([code(write), code(exec)]).toEqual(["aborted", "aborted"]);
    expect(existsSync(join(workdir, "written-after.txt"))).toBe(false);
    expect(existsSync(join(workdir, "ran-after.txt"))).toBe(false);
  });

  it("aborts a command in flight when destroyed", async () => {
    const running = env.exec(
      "printf s > started; sleep 30",
      undefined,
      context,
    );
    while (!existsSync(join(workdir, "started")))
      await Effect.runPromise(Effect.sleep("20 millis"));
    await env.destroy(context);
    // Within the case's timeout, far short of the command's thirty seconds.
    expect(code(await running)).toBe("aborted");
  });
});
