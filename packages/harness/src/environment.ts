/**
 * Where a session's commands run (LOB-244): the sandbox the harness's tools get their
 * `ExecutionEnv` from, out of a `SandboxRuntime` (`@repo/sandbox`, D6) rather than built here.
 *
 * The runtime is the deployment's, selected by its configuration and handed in. With none, the
 * session gets an in-process runtime of its own, which is what every session ran on before this
 * seam existed: the host's processes, in the session's worktree, with the server's environment
 * less its credentials (`sessionShellEnv`). That runtime makes nothing on the host while it only
 * binds, so a session that is never released leaves nothing behind but memory.
 *
 * The session's worktree already exists when it opens — the control plane cut it (D10) — so its
 * sandbox is bound to that directory rather than created empty, and it is bound on first use, not
 * at open: a released session still opens, in a directory that is gone (LOB-268), and only a tool
 * that needs to run there should learn that.
 */
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { SessionError } from "@repo/domain/Session";
import { type BindableSandboxRuntimeShape, InProcess } from "@repo/sandbox";
import { Effect, Exit, Scope } from "effect";

export type SessionEnvironment = {
  /**
   * The environment for a conversation working in `cwd`, its `cwd` at that directory. The sandbox
   * behind it is bound once per directory and shared by every later use; a binding that fails is
   * not kept, so the next use tries again.
   */
  readonly env: (cwd: string) => Promise<ExecutionEnv>;
  /**
   * End every sandbox the session bound, and the session's own runtime when it has one: commands
   * still running are stopped, handles closed, temporary files removed, and the worktree's files
   * and the exec spill files its transcript names left. A use after it fails.
   */
  readonly release: Effect.Effect<void>;
};

/**
 * The environments of one session's commands, from `runtime` or, when absent, an in-process
 * runtime of its own. `shellEnv` is read at each binding: the variables every command starts with,
 * over the runtime's.
 */
export const openSessionEnvironment = (
  runtime: BindableSandboxRuntimeShape | undefined,
  shellEnv: () => Readonly<Record<string, string>>,
): Effect.Effect<SessionEnvironment> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const sandboxes =
      runtime ?? (yield* InProcess.make().pipe(Scope.provide(scope)));
    const bound = new Map<string, Promise<ExecutionEnv>>();
    // Pi Durable calls for an environment from outside any fiber; the bindings run with the
    // services the session was opened with.
    const services = yield* Effect.context<never>();

    // Bound into the session's scope, so its release ends the sandbox; once released, the scope
    // runs the finalizer at once and the environment read after it fails, which is the refusal.
    const bind = (cwd: string): Effect.Effect<ExecutionEnv, SessionError> =>
      // The spill files stay: the transcript names them, and a later turn may read one after an
      // idle release ended this sandbox and the session reopened in a new one.
      sandboxes.bind(cwd, { env: shellEnv(), keepSpillFiles: true }).pipe(
        Effect.tap((sandbox) =>
          Scope.addFinalizer(
            scope,
            sandboxes.destroy(sandbox).pipe(
              Effect.ignore({
                log: "Warn",
                message: `sandbox ${sandbox.id} over ${sandbox.workdir} was not fully cleaned up`,
              }),
            ),
          ),
        ),
        Effect.flatMap((sandbox) => sandboxes.executionEnv(sandbox)),
        Effect.mapError(
          (error) =>
            new SessionError({
              code: "harness",
              message: `the session's working directory ${cwd} cannot run commands (${sandboxes.capabilities.runtime} runtime): ${error.message}`,
            }),
        ),
        Effect.withSpan("SessionEnvironment.bind", {
          attributes: { cwd, runtime: sandboxes.capabilities.runtime },
        }),
      );

    const env = (cwd: string): Promise<ExecutionEnv> => {
      const held = bound.get(cwd);
      if (held !== undefined) return held;
      const binding = Effect.runPromiseWith(services)(bind(cwd));
      bound.set(cwd, binding);
      binding.catch(() => {
        if (bound.get(cwd) === binding) bound.delete(cwd);
      });
      return binding;
    };

    return { env, release: Scope.close(scope, Exit.void) };
  });
