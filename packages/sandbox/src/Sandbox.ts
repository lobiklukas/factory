/**
 * What a sandbox is, what a runtime says it can do, and how its operations fail (D6, LOB-88).
 *
 * A sandbox here is a unit of lifecycle: a working directory with commands run in it, created and
 * destroyed together. It is not a security boundary, and nothing in this package says otherwise:
 * what a runtime separates from its host is the `isolation` field of its descriptor, and the only
 * value that exists today is `"none"` (R2 — no local suite can establish more).
 */
import { Schema } from "effect";

/** `sbx_` then lowercase base-36: safe as a directory name, a pod name and a URL segment. */
export const SandboxId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sbx_[0-9a-z]+$/)),
  Schema.brand("SandboxId"),
);
export type SandboxId = typeof SandboxId.Type;

/** One live sandbox: the handle every other runtime operation takes. */
export const Sandbox = Schema.Struct({
  id: SandboxId,
  /** Absolute and canonical: the directory relative paths and commands start from. */
  workdir: Schema.String,
});
export type Sandbox = typeof Sandbox.Type;

/**
 * The capability descriptor (D6): what one runtime provides, so the control plane adapts to it
 * instead of assuming. Every field states a fact about the runtime that the conformance suite can
 * check against its behaviour, including the ones that say a capability is absent.
 */
export const SandboxCapabilities = Schema.Struct({
  /** The implementation's name, for logs and for the error a missing capability raises. */
  runtime: Schema.String,
  /**
   * What separates a sandbox's commands and files from its host. `"none"`: they run as the host's
   * user, on the host, and see its whole filesystem, network and processes. A runtime adds a value
   * here only with a test that observes what the value means.
   */
  isolation: Schema.Literals(["none"]),
  /**
   * How long a sandbox's files last. `"ephemeral"`: until it is destroyed or its runtime stops, and
   * only reachable through the runtime that created it. `"volume"`: on a volume that outlives the
   * process running the commands (a PVC). `"snapshot"`: captured and restored as a whole.
   */
  persistence: Schema.Literals(["ephemeral", "volume", "snapshot"]),
  /** The disk a sandbox may use, in GB; `null` when the runtime enforces no limit of its own. */
  maxDiskGb: Schema.NullOr(Schema.Int),
  /** Whether `pause` and `resume` exist; without it both fail with `SandboxUnsupported`. */
  pauseResume: Schema.Boolean,
  /**
   * Whether a long command needs outside traffic to keep its sandbox running (a Cloudflare
   * Container stops without requests even while a command still runs).
   */
  requiresKeepaliveForLongTasks: Schema.Boolean,
});
export type SandboxCapabilities = typeof SandboxCapabilities.Type;

/** What a finished command left: its exit code and its output, decoded as UTF-8. */
export const ExecResult = Schema.Struct({
  /** Non-zero is a result, not a failure: the command ran and said so. */
  exitCode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
});
export type ExecResult = typeof ExecResult.Type;

/** The sandbox was never created by this runtime, or it has been destroyed. */
export class SandboxNotFound extends Schema.TaggedError<SandboxNotFound>()(
  "SandboxNotFound",
  { sandboxId: SandboxId },
) {}

/** The runtime does not provide the operation; its descriptor says so too. */
export class SandboxUnsupported extends Schema.TaggedError<SandboxUnsupported>()(
  "SandboxUnsupported",
  {
    runtime: Schema.String,
    operation: Schema.Literals(["pause", "resume"]),
  },
) {}

/** A file operation failed. `code` is Pi Durable's `FileErrorCode`, so the two agree. */
export class SandboxFileError extends Schema.TaggedError<SandboxFileError>()(
  "SandboxFileError",
  {
    sandboxId: SandboxId,
    path: Schema.String,
    code: Schema.Literals([
      "aborted",
      "not_found",
      "permission_denied",
      "not_directory",
      "is_directory",
      "invalid",
      "not_supported",
      "unknown",
    ]),
    message: Schema.String,
  },
) {}

/**
 * A command could not run to completion: it never started, timed out, or was stopped by its
 * caller's interruption or by the sandbox's destruction. `code` is Pi Durable's
 * `ExecutionErrorCode`.
 */
export class SandboxExecError extends Schema.TaggedError<SandboxExecError>()(
  "SandboxExecError",
  {
    sandboxId: SandboxId,
    code: Schema.Literals([
      "aborted",
      "timeout",
      "shell_unavailable",
      "spawn_error",
      "callback_error",
      "unknown",
    ]),
    message: Schema.String,
  },
) {}
