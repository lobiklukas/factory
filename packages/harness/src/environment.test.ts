/**
 * Where a session's commands run (LOB-244): through a `SandboxRuntime`, bound to the session's
 * existing worktree, with the credential filter of `sessionShellEnv` on every command.
 *
 * Offline and database-free: the model is pi-ai's faux provider scripted to call `bash` with the
 * command under test, and the log is Pi Durable's `MemoryStorage`, because what is proven here is
 * where the command ran and what it saw, not the log.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  type BindableSandboxRuntimeShape,
  InProcess,
  type Sandbox,
} from "@repo/sandbox";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openSessionEnvironment } from "./environment";
import { createModelAccess } from "./models";
import { projectView } from "./projection";
import {
  closeSession,
  openSession,
  sessionShellEnv,
  submitMessage,
  type OpenSession,
} from "./session";

const context = BACKGROUND_CONTEXT;
const scratch = mkdtempSync(join(tmpdir(), "factory-environment-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fresh directory standing in for the worktree the control plane cut, holding `files`. */
const worktree = (files: Record<string, string> = {}): string => {
  const directory = mkdtempSync(join(scratch, "worktree-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(directory, name), content);
  }
  return directory;
};

/** Send one message and return the `bash` results of the turn it starts, in order. */
const turn = (session: OpenSession, message: string) =>
  Effect.gen(function* () {
    const submitted = yield* submitMessage(session.root, {
      content: message,
      requestId: `request-${message}`,
    });
    const settled = yield* Effect.promise(() =>
      submitted.submission.wait(context),
    );
    expect(settled.status).toBe("done");
    const view = yield* Effect.promise(() => session.root.viewState(context));
    const projection = projectView(view.value);
    view.dispose();
    return projection.entries.filter(
      (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
    );
  });

/** Open a session over a fresh in-memory log whose model runs `command` in `bash` every turn. */
const open = (
  cwd: string,
  command: string,
  sandbox?: BindableSandboxRuntimeShape,
) =>
  openSession({
    storage: new MemoryStorage(),
    model: createModelAccess("faux", {
      fauxCommand: command,
      fauxEveryTurn: true,
    }),
    cwd,
    ...(sandbox === undefined ? {} : { sandbox }),
  });

describe("the default path", () => {
  it("runs a session's commands in its existing worktree, reading the marker file it already held", async () => {
    const cwd = worktree({ "marker.txt": "cut by the control plane" });
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* open(cwd, "cat marker.txt; echo; pwd -P");
        const results = yield* turn(session, "read the marker");
        yield* closeSession(session);
        return results;
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.text).toContain("cut by the control plane");
    expect(results[0]?.text).toContain(realpathSync(cwd));
    // Closing the session ends its sandbox and leaves the worktree's files where they were.
    expect(existsSync(join(cwd, "marker.txt"))).toBe(true);
  }, 60_000);

  it("still opens a session whose worktree is gone, and says so to the command that needed it", async () => {
    // A released session opens in a directory that no longer exists (LOB-268): only a tool that
    // runs there learns it.
    const cwd = join(scratch, "released-worktree");
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* open(cwd, "echo unreachable");
        const results = yield* turn(session, "try");
        yield* closeSession(session);
        return results;
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.text).toContain(cwd);
    expect(results[0]?.text).not.toContain("unreachable\n");
  }, 60_000);
});

describe("sessionShellEnv", () => {
  it("blanks every credential-shaped variable and names nothing else", () => {
    expect(
      sessionShellEnv({
        GITHUB_TOKEN: "ghs_x",
        ANTHROPIC_API_KEY: "sk-x",
        PGPASSWORD: "pw",
        GITHUB_WEBHOOK_SECRET: "s",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN",
        linear_api_key: "lower case too",
        PATH: "/usr/bin",
        HOME: "/home/x",
        SESSION_ROOT: ".factory/sessions",
      }),
    ).toEqual({
      GITHUB_TOKEN: "",
      ANTHROPIC_API_KEY: "",
      PGPASSWORD: "",
      GITHUB_WEBHOOK_SECRET: "",
      GITHUB_APP_PRIVATE_KEY: "",
      linear_api_key: "",
    });
  });

  it("reads the server's own environment when given none", () => {
    // oxlint-disable-next-line effecttsgo/process-env -- the server's environment is what the case varies.
    process.env["FACTORY_ENVIRONMENT_TEST_TOKEN"] = "from the server";
    try {
      expect(sessionShellEnv()["FACTORY_ENVIRONMENT_TEST_TOKEN"]).toBe("");
    } finally {
      // oxlint-disable-next-line effecttsgo/process-env -- the server's environment is what the case varies.
      delete process.env["FACTORY_ENVIRONMENT_TEST_TOKEN"];
    }
  });
});

describe("a session's commands see the server's environment less its credentials", () => {
  afterEach(() => {
    // oxlint-disable-next-line effecttsgo/process-env -- the server's environment is what the case varies.
    delete process.env["FACTORY_ENVIRONMENT_TEST_TOKEN"];
    // oxlint-disable-next-line effecttsgo/process-env -- the server's environment is what the case varies.
    delete process.env["FACTORY_ENVIRONMENT_TEST_PLAIN"];
  });

  const probe =
    'printf "token=[%s] plain=[%s]" "$FACTORY_ENVIRONMENT_TEST_TOKEN" "$FACTORY_ENVIRONMENT_TEST_PLAIN"';

  const observe = (sandbox?: BindableSandboxRuntimeShape) =>
    Effect.gen(function* () {
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the server's environment is what the case varies.
      process.env["FACTORY_ENVIRONMENT_TEST_TOKEN"] = "must not reach";
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the server's environment is what the case varies.
      process.env["FACTORY_ENVIRONMENT_TEST_PLAIN"] = "reaches";
      const session = yield* open(worktree(), probe, sandbox);
      const results = yield* turn(session, "probe");
      yield* closeSession(session);
      return results[0]?.text ?? "";
    });

  it("on the default path", async () => {
    expect(await Effect.runPromise(observe())).toContain(
      "token=[] plain=[reaches]",
    );
  }, 60_000);

  it("through a configured runtime, which knows nothing of the filter", async () => {
    const text = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* observe(yield* InProcess.make());
      }).pipe(Effect.scoped),
    );
    expect(text).toContain("token=[] plain=[reaches]");
  }, 60_000);
});

/** The runtime given, with every `bind` and `destroy` it served recorded. */
const recording = (runtime: BindableSandboxRuntimeShape) => {
  const bound: Sandbox[] = [];
  const destroyed: Sandbox[] = [];
  const recorder: BindableSandboxRuntimeShape = {
    ...runtime,
    bind: (workdir, options) =>
      runtime
        .bind(workdir, options)
        .pipe(Effect.tap((sandbox) => Effect.sync(() => bound.push(sandbox)))),
    destroy: (sandbox) =>
      runtime
        .destroy(sandbox)
        .pipe(Effect.tap(() => Effect.sync(() => destroyed.push(sandbox)))),
  };
  return { recorder, bound, destroyed };
};

describe("a configured runtime", () => {
  it("binds the session's worktree once, serves every turn from it, and ends it when the session closes", async () => {
    const cwd = worktree({ "marker.txt": "one worktree" });
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const { recorder, bound, destroyed } = recording(
          yield* InProcess.make(),
        );
        const session = yield* open(cwd, "cat marker.txt", recorder);
        // Opening binds nothing: the worktree is bound when a command first needs it.
        const atOpen = bound.length;
        const first = yield* turn(session, "first");
        const second = yield* turn(session, "second");
        const beforeClose = destroyed.length;
        yield* closeSession(session);
        return { atOpen, first, second, bound, beforeClose, destroyed };
      }).pipe(Effect.scoped),
    );
    expect(observed.atOpen).toBe(0);
    expect(observed.second.map((entry) => entry.text)).toEqual([
      expect.stringContaining("one worktree"),
      expect.stringContaining("one worktree"),
    ]);
    expect(observed.bound.map((sandbox) => sandbox.workdir)).toEqual([
      realpathSync(cwd),
    ]);
    expect(observed.beforeClose).toBe(0);
    expect(observed.destroyed).toEqual(observed.bound);
    expect(existsSync(join(cwd, "marker.txt"))).toBe(true);
  }, 60_000);
});

describe("openSessionEnvironment", () => {
  it("does not keep a binding that failed, so the next use tries again", async () => {
    const cwd = join(scratch, "appears-later");
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const environment = yield* openSessionEnvironment(
          undefined,
          () => ({}),
        );
        const missing = yield* Effect.promise(() =>
          environment.env(cwd).then(
            () => "bound",
            (error: unknown) => String(error),
          ),
        );
        mkdirSync(cwd);
        const env = yield* Effect.promise(() => environment.env(cwd));
        const again = yield* Effect.promise(() => environment.env(cwd));
        yield* environment.release;
        return { missing, cwd: env.cwd, same: env === again };
      }),
    );
    expect(outcome.missing).toContain(cwd);
    expect(outcome.cwd).toBe(realpathSync(cwd));
    expect(outcome.same).toBe(true);
  });

  it("leaves the exec spill files its commands made when released, since the transcript names them", async () => {
    // Pi Durable's bash tool tells the model "Full output: <spill path>"; an idle release ends the
    // sandbox, and the turn after the session reopens may still read that path.
    const cwd = worktree();
    const spillPath = await Effect.runPromise(
      Effect.gen(function* () {
        const environment = yield* openSessionEnvironment(
          undefined,
          () => ({}),
        );
        const env = yield* Effect.promise(() => environment.env(cwd));
        const spilled = yield* Effect.promise(() =>
          env.exec(
            "seq 1 50",
            { spill: { afterBytes: 10, afterLines: 2 } },
            context,
          ),
        );
        yield* environment.release;
        return spilled.ok ? (spilled.value.spillPath ?? "") : "";
      }),
    );
    expect(spillPath).not.toBe("");
    expect(existsSync(spillPath)).toBe(true);
    rmSync(dirname(spillPath), { recursive: true, force: true });
  });

  it("refuses every use once released, including the environment it already gave", async () => {
    const cwd = worktree();
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const environment = yield* openSessionEnvironment(
          undefined,
          () => ({}),
        );
        const env = yield* Effect.promise(() => environment.env(cwd));
        yield* environment.release;
        const exec = yield* Effect.promise(() =>
          env.exec("true", undefined, context),
        );
        const later = yield* Effect.promise(() =>
          environment.env(worktree()).then(
            () => "bound",
            () => "refused",
          ),
        );
        return { exec: exec.ok ? "ran" : exec.error.code, later };
      }),
    );
    expect(outcome).toEqual({ exec: "aborted", later: "refused" });
  });
});
