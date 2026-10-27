/**
 * The `ExecutionEnv` adapter: Pi Durable's environment for one sandbox, bound to its lifetime, and
 * the runtime's coarse operations expressed over any such environment (LOB-88).
 *
 * `SandboxExecutionEnv` wraps the environment a runtime implementation provides — a
 * `NodeExecutionEnv` in-process, one over pod exec later — and adds only what a sandbox's lifetime
 * means to it. Once the sandbox is destroyed every operation is refused with `aborted`; commands
 * still running are aborted; readers and watchers opened through it are closed; and the temporary
 * files it made outside the workdir (`createTempDir`, `createTempFile`, exec spill files) are
 * removed, with the directories made to hold them. Everything else is the wrapped environment's own behaviour, which is why Pi Durable's
 * conformance suite runs against the wrapper and not against what it wraps.
 *
 * The wrapper adds no boundary: an absolute path or a command reaches whatever the wrapped
 * environment reaches. What that is, is the runtime's descriptor's `isolation` field.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  withoutAbortSignal,
} from "@earendil-works/chord/context";
import {
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileInfo,
  type FileWatcher,
  type LineScan,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
  err,
  ok,
} from "@earendil-works/pi-durable/env";
import { Effect } from "effect";
import {
  type ExecResult,
  SandboxExecError,
  SandboxFileError,
  type SandboxId,
} from "./Sandbox";
import { DEFAULT_MAX_OUTPUT_BYTES, type ExecOptions } from "./SandboxRuntime";

/** A POSIX path's directory; `undefined` for the root or a path with no directory part. */
const parentOf = (path: string): string | undefined => {
  const slash = path.replace(/\/+$/, "").lastIndexOf("/");
  return slash <= 0 ? undefined : path.slice(0, slash);
};

/** Anything opened through the environment that holds a resource until it is closed. */
type Closable = { close(context: Context): Promise<void> };

/**
 * How a temporary path is removed. `"tree"`: a directory made for it alone, removed with what it
 * holds. `"file"`: a file the wrapped environment placed itself (an exec spill file); its directory
 * is removed too once the file was the last thing in it, which is the case for Pi Durable's
 * `NodeExecutionEnv`, whose every temporary file sits in a fresh directory of its own.
 */
type Temporary = "tree" | "file";

export class SandboxExecutionEnv implements ExecutionEnv {
  /** The wrapped environment's file namespace: wrapping a sandbox's environment changes no files. */
  readonly id: string;
  private readonly lifetime = new AbortController();
  private readonly opened = new Set<Closable>();
  private readonly temporary = new Map<string, Temporary>();
  /** The cleanup in progress or done; cleared when it fails, so a later `destroy` retries it. */
  private cleaning: Promise<void> | undefined;

  constructor(
    private readonly inner: ExecutionEnv,
    readonly sandboxId: SandboxId,
  ) {
    this.id = inner.id;
  }

  get cwd(): string {
    return this.inner.cwd;
  }

  set cwd(value: string) {
    this.inner.cwd = value;
  }

  /** Whether `destroy` has started: from then on every operation is refused. */
  get destroyed(): boolean {
    return this.lifetime.signal.aborted;
  }

  /**
   * Refuse everything from now on, abort what runs, close what is open, and remove the temporary
   * files. The workdir itself belongs to the runtime, which removes it after this resolves.
   * Idempotent once it has resolved; when it rejects (a temporary path could not be removed), the
   * paths still there are kept and the next call tries them again.
   */
  destroy(context: Context): Promise<void> {
    this.lifetime.abort();
    if (this.cleaning !== undefined) return this.cleaning;
    // Mandatory cleanup: a caller's cancellation must not leave a handle open or a file behind.
    const cleaning = this.clean(withoutAbortSignal(context)).catch(
      (error: unknown) => {
        this.cleaning = undefined;
        throw error;
      },
    );
    this.cleaning = cleaning;
    return cleaning;
  }

  private clean(context: Context): Promise<void> {
    const handles = [...this.opened];
    this.opened.clear();
    const failures: FileError[] = [];
    return Promise.all(handles.map((handle) => handle.close(context)))
      .then(() => this.inner.cleanup(context))
      .then(() =>
        Promise.all(
          [...this.temporary].map(([path, kind]) =>
            this.removeTemporary(path, kind, context).then((removed) => {
              if (removed.ok) this.temporary.delete(path);
              else failures.push(removed.error);
            }),
          ),
        ),
      )
      .then(() => {
        if (failures[0] !== undefined) throw failures[0];
      });
  }

  /** Remove one temporary path, and a spill file's directory once it is empty. */
  private removeTemporary(
    path: string,
    kind: Temporary,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.inner
      .remove(path, { recursive: true, force: true }, context)
      .then((removed) => {
        const parent = parentOf(path);
        if (
          !removed.ok ||
          kind === "tree" ||
          parent === undefined ||
          parent === this.inner.cwd
        ) {
          return removed;
        }
        return this.inner.listDir(parent, context).then((listing) =>
          // Gone already, or holding something else: either way not this file's to remove.
          !listing.ok || listing.value.length > 0
            ? ok(undefined)
            : this.inner.remove(
                parent,
                { recursive: true, force: true },
                context,
              ),
        );
      });
  }

  // --- guards -------------------------------------------------------------------------------

  /** The caller's context, also cancelled when the sandbox is destroyed. */
  private scoped(context: Context): Context {
    return withAbortSignal(this.lifetime.signal, context);
  }

  private fileRefusal<T>(path?: string): Promise<Result<T, FileError>> {
    return Promise.resolve(
      err(
        new FileError(
          "aborted",
          `sandbox ${this.sandboxId} is destroyed`,
          path,
        ),
      ),
    );
  }

  /** Run a file operation unless the sandbox is destroyed. */
  private file<T>(
    path: string | undefined,
    operation: () => Promise<Result<T, FileError>>,
  ): Promise<Result<T, FileError>> {
    return this.destroyed ? this.fileRefusal(path) : operation();
  }

  /**
   * Track a handle the inner environment opened, so `destroy` can close it. A handle that opened
   * while the sandbox was being destroyed is closed at once and refused.
   */
  private track<T extends Closable>(
    path: string,
    result: Result<T, FileError>,
    wrap: (handle: T, release: (context: Context) => Promise<void>) => T,
  ): Promise<Result<T, FileError>> {
    if (!result.ok) return Promise.resolve(result);
    const handle = result.value;
    if (this.destroyed) {
      return handle
        .close(withoutAbortSignal(BACKGROUND_CONTEXT))
        .then(() => this.fileRefusal(path));
    }
    const wrapped = wrap(handle, (context) => {
      this.opened.delete(wrapped);
      return handle.close(context);
    });
    this.opened.add(wrapped);
    return Promise.resolve(ok(wrapped));
  }

  /**
   * Remember a temporary path outside the workdir, so `destroy` removes it. One that appears after
   * the destroy began (the spill file of a command it aborted) is removed at once.
   */
  private remember(path: string | undefined, kind: Temporary): Promise<void> {
    if (path === undefined) return Promise.resolve();
    if (this.destroyed) {
      return this.removeTemporary(
        path,
        kind,
        withoutAbortSignal(BACKGROUND_CONTEXT),
      ).then(() => undefined);
    }
    this.temporary.set(path, kind);
    return Promise.resolve();
  }

  // --- Shell ------------------------------------------------------------------------------------

  exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (this.destroyed) {
      return Promise.resolve(
        err(
          new ExecutionError(
            "aborted",
            `sandbox ${this.sandboxId} is destroyed`,
          ),
        ),
      );
    }
    return this.inner
      .exec(command, options, this.scoped(context))
      .then((result) =>
        this.remember(
          result.ok ? result.value.spillPath : result.error.spillPath,
          "file",
        ).then(() => result),
      );
  }

  cleanup(context: Context): Promise<void> {
    return this.inner.cleanup(context);
  }

  // --- FileSystem: paths ---------------------------------------------------------------------

  absolutePath(
    path: string,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.file(path, () =>
      this.inner.absolutePath(path, this.scoped(context)),
    );
  }

  joinPath(
    parts: string[],
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.file(undefined, () =>
      this.inner.joinPath(parts, this.scoped(context)),
    );
  }

  canonicalPath(
    path: string,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.file(path, () =>
      this.inner.canonicalPath(path, this.scoped(context)),
    );
  }

  exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.file(path, () => this.inner.exists(path, this.scoped(context)));
  }

  fileInfo(
    path: string,
    context: Context,
  ): Promise<Result<FileInfo, FileError>> {
    return this.file(path, () =>
      this.inner.fileInfo(path, this.scoped(context)),
    );
  }

  // --- FileSystem: reads ----------------------------------------------------------------------

  readTextFile(
    path: string,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.file(path, () =>
      this.inner.readTextFile(path, this.scoped(context)),
    );
  }

  readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    return this.file(path, () =>
      this.inner.readTextLines(path, options, this.scoped(context)),
    );
  }

  readBinaryFile(
    path: string,
    context: Context,
  ): Promise<Result<Uint8Array, FileError>> {
    return this.file(path, () =>
      this.inner.readBinaryFile(path, this.scoped(context)),
    );
  }

  listDir(
    path: string,
    context: Context,
  ): Promise<Result<FileInfo[], FileError>> {
    return this.file(path, () =>
      this.inner.listDir(path, this.scoped(context)),
    );
  }

  openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    return this.file(path, () =>
      this.inner.openTextLineReader(path, this.scoped(context)).then((result) =>
        this.track(path, result, (reader, release) => ({
          readLine: (lineContext) => reader.readLine(this.scoped(lineContext)),
          close: release,
        })),
      ),
    );
  }

  openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    return this.file(path, () =>
      this.inner
        .openBinaryReader(path, options, this.scoped(context))
        .then((result) =>
          this.track(path, result, (reader, release) => ({
            info: (infoContext) => reader.info(this.scoped(infoContext)),
            read: (offset, length, readContext) =>
              reader.read(offset, length, this.scoped(readContext)),
            scanLines: (
              range: { startLine: number; endLine?: number },
              scanContext: Context,
            ): Promise<Result<LineScan, FileError>> =>
              reader.scanLines(range, this.scoped(scanContext)),
            close: release,
          })),
        ),
    );
  }

  openDirReader(
    path: string,
    context: Context,
  ): Promise<Result<DirReader, FileError>> {
    return this.file(path, () =>
      this.inner.openDirReader(path, this.scoped(context)).then((result) =>
        this.track(path, result, (reader, release) => ({
          next: (maxEntries, nextContext) =>
            reader.next(maxEntries, this.scoped(nextContext)),
          close: release,
        })),
      ),
    );
  }

  watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    const path = targets[0]?.path ?? ".";
    return this.file(path, () =>
      this.inner.watch(targets, onChange, this.scoped(context)).then((result) =>
        this.track(path, result, (watcher, release) => ({
          mode: watcher.mode,
          close: release,
        })),
      ),
    );
  }

  // --- FileSystem: writes ---------------------------------------------------------------------

  writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.file(path, () =>
      this.inner.writeFile(path, content, this.scoped(context)),
    );
  }

  appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.file(path, () =>
      this.inner.appendFile(path, content, this.scoped(context)),
    );
  }

  truncateFile(
    path: string,
    size: number,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.file(path, () =>
      this.inner.truncateFile(path, size, this.scoped(context)),
    );
  }

  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.file(path, () =>
      this.inner.flushFile(path, this.scoped(context)),
    );
  }

  renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.file(sourcePath, () =>
      this.inner.renameFile(sourcePath, destinationPath, this.scoped(context)),
    );
  }

  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.file(path, () =>
      this.inner.createDir(path, options, this.scoped(context)),
    );
  }

  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.file(path, () =>
      this.inner.remove(path, options, this.scoped(context)),
    );
  }

  createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.file(undefined, () =>
      this.inner
        .createTempDir(prefix, this.scoped(context))
        .then((result) =>
          this.remember(result.ok ? result.value : undefined, "tree").then(
            () => result,
          ),
        ),
    );
  }

  /**
   * An empty file in a temporary directory made for it alone, as `NodeExecutionEnv` does it, but
   * made here, so the wrapper knows the directory is its own to remove.
   */
  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.createTempDir("tmp-", context).then((dir) => {
      if (!dir.ok) return dir;
      const name = `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`;
      return this.joinPath([dir.value, name], context).then((path) =>
        !path.ok
          ? path
          : this.writeFile(path.value, "", context).then((written) =>
              written.ok ? ok(path.value) : written,
            ),
      );
    });
  }
}

// --- The coarse operations over an environment ---------------------------------------------------

/** A Pi Durable context cancelled when the effect running the call is interrupted. */
const interruptible = (signal: AbortSignal): Context =>
  withAbortSignal(signal, BACKGROUND_CONTEXT);

/**
 * Run one command to completion and collect both streams, up to `maxOutputBytes` between them.
 * Interruption aborts the call, which kills the command; a destroyed sandbox's environment fails
 * it with `aborted`.
 */
export const execIn = (
  env: ExecutionEnv,
  sandboxId: SandboxId,
  command: string | ReadonlyArray<string>,
  options: ExecOptions = {},
): Effect.Effect<ExecResult, SandboxExecError> =>
  Effect.gen(function* () {
    const output = { stdout: "", stderr: "" };
    const cap = Math.max(0, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    let kept = 0;
    let truncated = false;
    const shellOptions: ShellExecOptions = {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      onOutput: (text, _context, info) => {
        if (truncated) return;
        const bytes = Buffer.byteLength(text);
        if (kept + bytes <= cap) {
          output[info.stream] += text;
          kept += bytes;
          return;
        }
        // The part that fits, without a character cut in half: streaming decode holds it back.
        output[info.stream] += new TextDecoder().decode(
          Buffer.from(text).subarray(0, cap - kept),
          { stream: true },
        );
        kept = cap;
        truncated = true;
      },
    };
    const result = yield* Effect.promise((signal) =>
      env.exec(command, shellOptions, interruptible(signal)),
    );
    if (!result.ok) {
      return yield* new SandboxExecError({
        sandboxId,
        code: result.error.code,
        message: result.error.message,
      });
    }
    return { exitCode: result.value.exitCode, ...output, truncated };
  });

const fileResult = <T>(
  sandboxId: SandboxId,
  path: string,
  result: Result<T, FileError>,
): Effect.Effect<T, SandboxFileError> =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(
        new SandboxFileError({
          sandboxId,
          path: result.error.path ?? path,
          code: result.error.code,
          message: result.error.message,
        }),
      );

/** Run one file operation of an environment as an effect with a typed failure. */
export const fileIn = <T>(
  sandboxId: SandboxId,
  path: string,
  operation: (context: Context) => Promise<Result<T, FileError>>,
): Effect.Effect<T, SandboxFileError> =>
  Effect.promise((signal) => operation(interruptible(signal))).pipe(
    Effect.flatMap((result) => fileResult(sandboxId, path, result)),
  );

/** The file's bytes, unchanged. */
export const readFileIn = (
  env: ExecutionEnv,
  sandboxId: SandboxId,
  path: string,
): Effect.Effect<Uint8Array, SandboxFileError> =>
  fileIn(sandboxId, path, (context) => env.readBinaryFile(path, context));

/** Replace the file's content; the environment creates missing parent directories. */
export const writeFileIn = (
  env: ExecutionEnv,
  sandboxId: SandboxId,
  path: string,
  content: string | Uint8Array,
): Effect.Effect<void, SandboxFileError> =>
  fileIn(sandboxId, path, (context) => env.writeFile(path, content, context));
