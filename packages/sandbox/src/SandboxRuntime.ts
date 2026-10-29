/**
 * The executor seam (D6): one Effect service with the operations a local, a Kubernetes and a
 * Cloudflare implementation could each honestly serve, plus the descriptor saying which of them
 * this one does.
 *
 * Two levels, because two kinds of caller need them. The control plane drives a sandbox through
 * the coarse operations here — create it, run a command, read or write a file, destroy it. The
 * harness needs the whole of Pi Durable's `ExecutionEnv` (positional readers, directory paging,
 * watches), which cannot be derived from those operations without inventing a filesystem over a
 * shell, so `executionEnv` hands it the runtime's own, bound to the sandbox's lifetime
 * (`./env.ts`).
 *
 * Port exposure and metrics are D6 operations too. They arrive with the first runtime that serves
 * them, together with their descriptor fields: a stub nobody runs is the option D6 rejected.
 */
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Context, type Effect } from "effect";
import type {
  ExecResult,
  Sandbox,
  SandboxCapabilities,
  SandboxExecError,
  SandboxFileError,
  SandboxNotFound,
  SandboxUnsupported,
} from "./Sandbox";

/** The output `exec` keeps of one command when its options name no cap: 16 MiB. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** How one command runs. Paths are relative to the sandbox's workdir. */
export type ExecOptions = {
  /** Where the command starts; the workdir when absent. */
  readonly cwd?: string;
  /** Variables added to the runtime's command environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Seconds before the command is killed and the call fails with `timeout`. */
  readonly timeout?: number;
  /**
   * The most output kept, in UTF-8 bytes across stdout and stderr together; `DEFAULT_MAX_OUTPUT_BYTES`
   * when absent. Output past it is dropped and the result says `truncated`; the command runs on.
   * It bounds what one command can make the caller hold, since `exec` keeps all it keeps in memory.
   */
  readonly maxOutputBytes?: number;
};

export type SandboxRuntimeShape = {
  /** Fixed for the runtime's life: the control plane may read it once. */
  readonly capabilities: SandboxCapabilities;
  /** A new sandbox with a fresh, empty, writable workdir. */
  readonly create: Effect.Effect<Sandbox, SandboxFileError>;
  /**
   * Run one command to completion. A string runs through the sandbox's shell; an array runs its
   * first element with the rest as unparsed arguments. Interrupting the effect kills the command.
   * Its output is kept up to `maxOutputBytes`; the harness's `ExecutionEnv` is the way to stream
   * or spill more.
   */
  readonly exec: (
    sandbox: Sandbox,
    command: string | ReadonlyArray<string>,
    options?: ExecOptions,
  ) => Effect.Effect<ExecResult, SandboxNotFound | SandboxExecError>;
  /** The file's bytes, unchanged. */
  readonly readFile: (
    sandbox: Sandbox,
    path: string,
  ) => Effect.Effect<Uint8Array, SandboxNotFound | SandboxFileError>;
  /** Replace the file's content, creating it and its parent directories when missing. */
  readonly writeFile: (
    sandbox: Sandbox,
    path: string,
    content: string | Uint8Array,
  ) => Effect.Effect<void, SandboxNotFound | SandboxFileError>;
  /**
   * Stop the sandbox's compute and keep its files; only when `capabilities.pauseResume`. A backend
   * that could not do it (a cluster that failed or timed out) fails with `SandboxFileError`, as
   * `create` does, and the sandbox stays running.
   */
  readonly pause: (
    sandbox: Sandbox,
  ) => Effect.Effect<
    void,
    SandboxNotFound | SandboxUnsupported | SandboxFileError
  >;
  /**
   * Bring a paused sandbox back with its files; only when `capabilities.pauseResume`. A backend
   * that could not do it fails with `SandboxFileError`, and the sandbox stays paused.
   */
  readonly resume: (
    sandbox: Sandbox,
  ) => Effect.Effect<
    void,
    SandboxNotFound | SandboxUnsupported | SandboxFileError
  >;
  /**
   * The Pi Durable environment for the sandbox, `cwd` at its workdir, for the harness's tools.
   * It stops working when the sandbox is destroyed.
   */
  readonly executionEnv: (
    sandbox: Sandbox,
  ) => Effect.Effect<ExecutionEnv, SandboxNotFound>;
  /**
   * Stop every command still running in the sandbox, close what was opened through its
   * environment, and remove its files. Destroying a destroyed sandbox succeeds and does nothing.
   */
  readonly destroy: (sandbox: Sandbox) => Effect.Effect<void, SandboxFileError>;
};

/** How `bind` starts a sandbox's commands. */
export type BindOptions = {
  /**
   * Variables every command in the sandbox starts with, over the runtime's own; an empty value
   * overrides an inherited one, which is how a caller withholds a variable from the commands.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Leave the exec spill files on the host when the sandbox ends, rather than removing them with
   * its other temporary files. A session's sandbox sets it (LOB-244): Pi Durable's bash tool tells
   * the model where a truncated command's full output is, and the session's transcript, which a
   * later turn reads, outlives the sandbox the command ran in. Absent: removed.
   */
  readonly keepSpillFiles?: boolean;
};

/**
 * A runtime that can also run a sandbox in a directory that already exists: a session's git
 * worktree, which the control plane cut on the host before the session opened (D10, LOB-244).
 *
 * Not one of D6's operations, and so not on `SandboxRuntimeShape`: only a runtime whose commands
 * run on the host the directory is on can serve it honestly. The in-process runtime is one. A
 * Kubernetes runtime is not — its workdir is a volume in the cluster, and its session's worktree is
 * cut there — so it implements the shape above and nothing here.
 */
export type BindableSandboxRuntimeShape = SandboxRuntimeShape & {
  /**
   * A sandbox whose workdir is `workdir`, which must be an existing directory; a relative one is
   * resolved against the server's working directory. The directory is the caller's: `destroy` and
   * the runtime's release end the sandbox — its commands, its handles, its temporary files — and
   * leave every file in it.
   */
  readonly bind: (
    workdir: string,
    options?: BindOptions,
  ) => Effect.Effect<Sandbox, SandboxFileError>;
};

export class SandboxRuntime extends Context.Service<
  SandboxRuntime,
  SandboxRuntimeShape
>()("@repo/sandbox/SandboxRuntime") {}
