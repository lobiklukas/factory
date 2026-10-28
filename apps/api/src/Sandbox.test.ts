/**
 * The configured sandbox runtime (LOB-244): unset is in-process, a name this server does not know
 * fails the boot, and what is selected is a runtime that binds a session's existing worktree.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Exit, Option } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_RUNTIME,
  describeSandboxRuntime,
  SandboxRuntimeConfig,
  selectSandboxRuntime,
} from "./Sandbox";

const scratch = mkdtempSync(join(tmpdir(), "factory-api-sandbox-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const read = (env: Record<string, string>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const named = yield* SandboxRuntimeConfig;
      return named;
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env }),
      ),
    ),
  );

describe("SANDBOX_RUNTIME", () => {
  it("names no runtime when unset, and the default is in-process", async () => {
    const exit = await read({});
    expect(exit).toEqual(Exit.succeed(Option.none()));
    expect(DEFAULT_SANDBOX_RUNTIME).toBe("in-process");
  });

  it("reads in-process when set to it", async () => {
    expect(await read({ SANDBOX_RUNTIME: "in-process" })).toEqual(
      Exit.succeed(Option.some("in-process")),
    );
  });

  it("refuses a runtime this server does not know, rather than running sessions on the default", async () => {
    expect(Exit.isFailure(await read({ SANDBOX_RUNTIME: "kind" }))).toBe(true);
  });
});

describe("the selected runtime", () => {
  it("is the in-process one, and binds a session's existing worktree", async () => {
    const worktree = mkdtempSync(join(scratch, "worktree-"));
    writeFileSync(join(worktree, "marker.txt"), "the session's own file");
    const { runtime, stdout } = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* selectSandboxRuntime(DEFAULT_SANDBOX_RUNTIME);
        const sandbox = yield* runtime.bind(worktree);
        const result = yield* runtime.exec(sandbox, "cat marker.txt");
        return { runtime: runtime.capabilities.runtime, stdout: result.stdout };
      }).pipe(Effect.scoped),
    );
    expect(runtime).toBe("in-process");
    expect(stdout).toBe("the session's own file");
  });

  it("is named on the boot line with what it does not separate", () => {
    expect(
      describeSandboxRuntime(
        {
          runtime: "in-process",
          isolation: "none",
          persistence: "ephemeral",
          maxDiskGb: null,
          pauseResume: false,
          requiresKeepaliveForLongTasks: false,
        },
        false,
      ),
    ).toBe(
      "sandbox runtime: in-process, isolation none — a session's commands run on this host as the server's user, in its worktree",
    );
  });
});
