/**
 * The relay's client half (LOB-91): a Pi Durable `ExecutionEnv` whose every call runs in a sandbox
 * somewhere else — a pod — through the relay server there (`./server`).
 *
 * It is how a Kubernetes sandbox serves D6's `executionEnv` while the harness still runs in the
 * control plane: each method becomes one request on a connection (`Connection`), opened on first
 * use and again after one is lost, and the answer is the server's environment's own `Result`. The
 * file namespace is the sandbox's (`id`), so equal paths here and on the host name different files.
 *
 * What a remote environment cannot do the local way, it does explicitly:
 *
 * - **Cancellation** crosses the wire. A context aborted before the call is refused here with
 *   `aborted`, as `NodeExecutionEnv` refuses it; one aborted during the call sends `cancel`, and the
 *   server's environment answers — for a command, after killing it.
 * - **A lost connection** — the pod paused or gone, `kubectl` killed — fails every call still in
 *   flight with `unknown`, naming what the connection said last, and every handle opened on it is
 *   dead: its methods fail with `invalid`, as a closed one's do. The next call opens a new one.
 * - **A refusal** (`refusal`) — the sandbox is paused — fails a call before any connection is
 *   tried, so a paused sandbox is never woken or waited on by a stray read.
 */
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
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
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
  err,
  ok,
} from "@earendil-works/pi-durable/env";
import type { Connection } from "./connection";
import {
  decode,
  encode,
  type EnvMethod,
  errorFromWire,
  type HandleMethod,
  isWireHandle,
  type Request,
  type WireError,
  type WireResult,
} from "./protocol";

export type RemoteExecutionEnvOptions = {
  /** The sandbox's file namespace: no other environment's paths name its files. */
  readonly id: string;
  /** Where relative paths and commands start, in the sandbox. */
  readonly cwd: string;
  /** Open a connection to the sandbox's relay server; called again after one is lost. */
  readonly connect: () => Connection;
  /** Why no call may run now (the sandbox is paused), or `undefined` when one may. */
  readonly refusal?: () => string | undefined;
};

type Pending = {
  readonly resolve: (result: WireResult) => void;
  readonly onOutput?: (text: string, stream: "stdout" | "stderr", skipped: unknown) => void;
};

/** One live connection and what is in flight on it. */
type Link = {
  readonly connection: Connection;
  readonly pending: Map<number, Pending>;
  readonly watchers: Map<number, (change: unknown) => void>;
  /** Changes for a watcher whose call has not answered yet: the server reports before it answers. */
  readonly orphans: Map<number, unknown[]>;
  dead: string | undefined;
};

const fileFailure = <T>(code: FileError["code"], message: string, path?: string): Result<T, FileError> =>
  err(new FileError(code, message, path));

export class RemoteExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  private link: Link | undefined;
  private nextId = 1;

  constructor(private readonly options: RemoteExecutionEnvOptions) {
    this.id = options.id;
    this.cwd = options.cwd;
  }

  /** Close the connection, failing what is in flight; the next call opens a new one. */
  disconnect(reason = "the connection was closed"): void {
    const link = this.link;
    if (link === undefined) return;
    this.link = undefined;
    this.lose(link, reason);
    link.connection.close();
  }

  // --- the wire ---------------------------------------------------------------------------------

  private lose(link: Link, reason: string): void {
    if (link.dead !== undefined) return;
    link.dead = reason;
    if (this.link === link) this.link = undefined;
    const pending = [...link.pending.values()];
    link.pending.clear();
    link.watchers.clear();
    link.orphans.clear();
    for (const each of pending) {
      each.resolve({
        ok: false,
        error: { kind: "file", code: "unknown", message: `the sandbox's environment is unreachable: ${reason}` },
      });
    }
  }

  private open(): Link {
    if (this.link !== undefined) return this.link;
    const connection = this.options.connect();
    const link: Link = {
      connection,
      pending: new Map(),
      watchers: new Map(),
      orphans: new Map(),
      dead: undefined,
    };
    this.link = link;
    connection.onLine((line) => this.receive(link, line));
    connection.onClose((reason) => this.lose(link, reason));
    return link;
  }

  private receive(link: Link, line: string): void {
    const message = decode(line);
    if (typeof message !== "object" || message === null) return;
    const reply = message as Record<string, unknown>;
    switch (reply["t"]) {
      case "done": {
        const id = reply["id"];
        if (typeof id !== "number") return;
        const pending = link.pending.get(id);
        link.pending.delete(id);
        pending?.resolve(reply["result"] as WireResult);
        return;
      }
      case "output": {
        const id = reply["id"];
        const text = reply["text"];
        const stream = reply["stream"];
        if (typeof id !== "number" || typeof text !== "string") return;
        link.pending
          .get(id)
          ?.onOutput?.(text, stream === "stderr" ? "stderr" : "stdout", reply["skipped"]);
        return;
      }
      case "change": {
        const handle = reply["handle"];
        if (typeof handle !== "number") return;
        const watcher = link.watchers.get(handle);
        if (watcher !== undefined) watcher(reply["change"]);
        else link.orphans.set(handle, [...(link.orphans.get(handle) ?? []), reply["change"]]);
        return;
      }
    }
  }

  /**
   * Send one request and wait for its answer, with the connection it went out on. `link` pins a
   * handle's call to the connection that opened the handle; a call on the environment uses the
   * current one, opening it if needed.
   */
  private request(
    build: (id: number) => Request,
    context: Context,
    options: { readonly link?: Link; readonly onOutput?: Pending["onOutput"] } = {},
  ): Promise<{ readonly result: WireResult; readonly link?: Link }> {
    const refusal = options.link === undefined ? this.options.refusal?.() : undefined;
    if (refusal !== undefined) {
      return Promise.resolve({ result: { ok: false, error: { kind: "file", code: "unknown", message: refusal } } });
    }
    if (context.abortSignal?.aborted === true) {
      return Promise.resolve({ result: { ok: false, error: { kind: "file", code: "aborted", message: "aborted" } } });
    }
    const link = options.link ?? this.open();
    if (link.dead !== undefined) {
      return Promise.resolve({
        result: {
          ok: false,
          error: { kind: "file", code: "invalid", message: `the handle's connection is gone: ${link.dead}` },
        },
      });
    }
    const id = this.nextId++;
    return this.send(link, id, build(id), context.abortSignal, options.onOutput).then((result) => ({
      result,
      link,
    }));
  }

  private send(
    link: Link,
    id: number,
    message: Request,
    signal: AbortSignal | undefined,
    onOutput: Pending["onOutput"],
  ): Promise<WireResult> {
    let resolve: (result: WireResult) => void = () => undefined;
    // oxlint-disable-next-line effecttsgo/new-promise -- the answer arrives as a line on the connection, settled by `receive`.
    const promise = new Promise<WireResult>((settle) => {
      resolve = settle;
    });
    const cancel = () => {
      if (link.pending.has(id)) link.connection.send(encode({ t: "cancel", id }));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    link.pending.set(id, {
      resolve: (result) => {
        signal?.removeEventListener("abort", cancel);
        resolve(result);
      },
      ...(onOutput === undefined ? {} : { onOutput }),
    });
    link.connection.send(encode(message));
    return promise;
  }

  private call(
    method: EnvMethod,
    args: ReadonlyArray<unknown>,
    context: Context,
  ): Promise<{ readonly result: WireResult; readonly link?: Link }> {
    return this.request((id) => ({ t: "call", id, cwd: this.cwd, method, args }), context);
  }

  private file<T>(method: EnvMethod, args: ReadonlyArray<unknown>, context: Context): Promise<Result<T, FileError>> {
    return this.call(method, args, context).then(({ result }) => this.asFile<T>(result));
  }

  private asFile<T>(result: WireResult): Result<T, FileError> {
    if (result.ok) return ok(result.value as T);
    const error = errorFromWire(result.error);
    return err(error instanceof FileError ? error : new FileError("unknown", error.message));
  }

  // --- handles ----------------------------------------------------------------------------------

  private handleCall<T>(
    link: Link,
    handle: number,
    method: HandleMethod,
    args: ReadonlyArray<unknown>,
    context: Context,
  ): Promise<Result<T, FileError>> {
    return this.request((id) => ({ t: "handle", id, handle, method, args }), context, { link }).then(
      ({ result }) => this.asFile<T>(result),
    );
  }

  /** A handle's `close`: idempotent, and done once its connection is gone. */
  private closer(link: Link, handle: number): (context: Context) => Promise<void> {
    let closing: Promise<void> | undefined;
    return (context) => {
      // A watcher reports nothing once its close has begun; what the server sends until its close
      // answers is dropped here, and nothing is sent after that.
      if (link.watchers.has(handle)) link.watchers.set(handle, () => undefined);
      closing ??=
        link.dead !== undefined
          ? Promise.resolve()
          : this.request(
              (id) => ({ t: "handle", id, handle, method: "close", args: [] }),
              // Mandatory: a caller's cancellation must not leave the server's handle open.
              withoutAbortSignal(context),
              { link },
            ).then(() => {
              link.watchers.delete(handle);
            });
      return closing;
    };
  }

  /** Open a handle on the server and wrap it with `wrap`, which gets its methods' caller. */
  private opened<T>(
    method: EnvMethod,
    args: ReadonlyArray<unknown>,
    context: Context,
    wrap: (
      invoke: <V>(method: HandleMethod, args: ReadonlyArray<unknown>, context: Context) => Promise<Result<V, FileError>>,
      close: (context: Context) => Promise<void>,
      link: Link,
      handle: number,
      mode: FileWatcher["mode"] | undefined,
    ) => T,
  ): Promise<Result<T, FileError>> {
    return this.call(method, args, context).then(({ result, link: current }) => {
      if (!result.ok) return this.asFile<T>(result);
      if (current === undefined || !isWireHandle(result.value)) {
        return fileFailure<T>("unknown", "the sandbox's environment answered without a handle");
      }
      const { $handle: handle, mode } = result.value;
      let closed = false;
      const close = this.closer(current, handle);
      const invoke = <V>(handleMethod: HandleMethod, handleArgs: ReadonlyArray<unknown>, handleContext: Context) =>
        closed
          ? Promise.resolve(fileFailure<V>("invalid", "the handle is closed"))
          : this.handleCall<V>(current, handle, handleMethod, handleArgs, handleContext);
      return ok(
        wrap(
          invoke,
          (closeContext) => {
            closed = true;
            return close(closeContext);
          },
          current,
          handle,
          mode,
        ),
      );
    });
  }

  // --- Shell ------------------------------------------------------------------------------------

  exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const { onOutput, ...rest } = options ?? {};
    let callbackError: ExecutionError | undefined;
    let sent: number | undefined;
    const forward =
      onOutput === undefined
        ? undefined
        : (text: string, stream: "stdout" | "stderr", skipped: unknown) => {
            if (callbackError !== undefined) return;
            try {
              onOutput(text, context, {
                stream,
                ...(skipped === undefined ? {} : { skipped: skipped as never }),
              });
            } catch (cause) {
              callbackError = new ExecutionError(
                "callback_error",
                cause instanceof Error ? cause.message : String(cause),
                cause instanceof Error ? cause : undefined,
              );
              // The command is stopped, as `NodeExecutionEnv` stops one whose callback threw.
              if (sent !== undefined) this.link?.connection.send(encode({ t: "cancel", id: sent }));
            }
          };
    return this.request(
      (id) => {
        sent = id;
        return {
          t: "call",
          id,
          cwd: this.cwd,
          method: "exec",
          args: [command, { ...rest, output: onOutput !== undefined }],
        };
      },
      context,
      forward === undefined ? {} : { onOutput: forward },
    ).then(({ result }): Result<ShellExecResult, ExecutionError> => {
      if (callbackError !== undefined) return err(callbackError);
      if (result.ok) return ok(result.value as ShellExecResult);
      return err(asExecError(result.error));
    });
  }

  cleanup(context: Context): Promise<void> {
    // Nothing runs without a connection, so there is nothing to kill: no call opens one for this.
    if (this.link === undefined) return Promise.resolve();
    return this.call("cleanup", [], context).then(() => undefined);
  }

  // --- FileSystem -------------------------------------------------------------------------------

  absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.file("absolutePath", [path], context);
  }

  joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return this.file("joinPath", [parts], context);
  }

  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.file("readTextFile", [path], context);
  }

  readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    return this.file("readTextLines", [path, options ?? null], context);
  }

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.file("readBinaryFile", [path], context);
  }

  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.opened("openTextLineReader", [path], context, (invoke, close) => ({
      readLine: (lineContext) => invoke<TextLine | undefined>("readLine", [], lineContext).then(nullToUndefined),
      close,
    }));
  }

  openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    return this.opened("openBinaryReader", [path, options ?? null], context, (invoke, close) => ({
      info: (infoContext) => invoke<FileInfo>("info", [], infoContext),
      read: (offset, length, readContext) => invoke<Uint8Array>("read", [offset, length], readContext),
      scanLines: (range, scanContext) => invoke<LineScan>("scanLines", [range], scanContext),
      close,
    }));
  }

  openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.opened("openDirReader", [path], context, (invoke, close) => ({
      next: (maxEntries, nextContext) =>
        invoke<{ entries: FileInfo[]; done: boolean }>("next", [maxEntries], nextContext),
      close,
    }));
  }

  watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    return this.opened("watch", [targets], context, (_invoke, close, link, handle, mode) => {
      const deliver = (change: unknown) => onChange(fromWireChange(change));
      link.watchers.set(handle, deliver);
      // What the server reported before its answer arrived, in the order it was reported.
      for (const change of link.orphans.get(handle) ?? []) deliver(change);
      link.orphans.delete(handle);
      return { mode: mode ?? "polling", close };
    });
  }

  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.file("writeFile", [path, content], context);
  }

  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.file("appendFile", [path, content], context);
  }

  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.file("truncateFile", [path, size], context);
  }

  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.file("flushFile", [path], context);
  }

  renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    return this.file("renameFile", [sourcePath, destinationPath], context);
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.file("fileInfo", [path], context);
  }

  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.file("listDir", [path], context);
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.file("canonicalPath", [path], context);
  }

  exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.file("exists", [path], context);
  }

  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.file("createDir", [path, options ?? null], context);
  }

  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.file("remove", [path, options ?? null], context);
  }

  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.file("createTempDir", [prefix ?? null], context);
  }

  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.file("createTempFile", [options ?? null], context);
  }
}

const asExecError = (error: WireError): ExecutionError => {
  const rebuilt = errorFromWire(error);
  if (rebuilt instanceof ExecutionError) return rebuilt;
  // A transport failure arrives as a file error; for a command it is the same fact.
  return new ExecutionError(rebuilt.code === "aborted" ? "aborted" : "unknown", rebuilt.message);
};

/** JSON has no `undefined`: the end of a line reader crosses as `null`. */
const nullToUndefined = (
  result: Result<TextLine | undefined, FileError>,
): Result<TextLine | undefined, FileError> =>
  result.ok && result.value === null ? ok(undefined) : result;

const fromWireChange = (change: unknown): WatchChange => {
  if (typeof change === "object" && change !== null && "error" in change) {
    const error = errorFromWire((change as { error: WireError }).error);
    return { error: error instanceof FileError ? error : new FileError("unknown", error.message) };
  }
  return change as WatchChange;
};
