/* oxlint-disable effecttsgo/prefer-schema-over-json -- the relay's wire carries whatever an `ExecutionEnv` method returns: untyped by design, framed as one JSON value per line. */
/**
 * The environment relay's wire (LOB-91): how a Pi Durable `ExecutionEnv` call made in the control
 * plane reaches the environment that serves it inside a sandbox, and how its answer comes back.
 *
 * One JSON value per line, both ways, over whatever byte stream joins the two ends — the stdin and
 * stdout of `kubectl exec -i` into the pod, or of a local child process in the tests. The client
 * numbers its requests and may have many in flight; the server answers each once (`done`) and, for
 * a command, streams its output first (`output`). A reader or watcher the server opened stays on its
 * side as a numbered handle, and the client calls its methods through that number. Nothing in a
 * message is a credential: the server's environment is the sandbox's own.
 *
 * Bytes cross as base64 (`{"$bytes": "…"}`), the only value JSON cannot hold. A failure crosses as
 * its class (`file` or `exec`), its code and its message, so the client rebuilds the same
 * `FileError` or `ExecutionError` the server's environment returned.
 */
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";

/** The `ExecutionEnv` methods a client calls by name; each takes the environment's own arguments. */
export const ENV_METHODS = [
  "absolutePath",
  "joinPath",
  "readTextFile",
  "openTextLineReader",
  "readTextLines",
  "readBinaryFile",
  "openBinaryReader",
  "writeFile",
  "appendFile",
  "truncateFile",
  "flushFile",
  "renameFile",
  "fileInfo",
  "listDir",
  "openDirReader",
  "watch",
  "canonicalPath",
  "exists",
  "createDir",
  "remove",
  "createTempDir",
  "createTempFile",
  "exec",
  "cleanup",
] as const;
export type EnvMethod = (typeof ENV_METHODS)[number];

/** Methods of a handle the server holds: a reader, a directory page reader or a watcher. */
export const HANDLE_METHODS = [
  "readLine",
  "info",
  "read",
  "scanLines",
  "next",
  "close",
] as const;
export type HandleMethod = (typeof HANDLE_METHODS)[number];

/** FNV-1a over `text`, base 36: a short, stable fingerprint. */
const fingerprint = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
};

/**
 * The wire's version, which the server's `ready` carries and the client checks before anything it
 * sent is answered: a client and a server built from different sources — a sandbox image loaded
 * before the relay changed — fail every call at once, naming both, instead of waiting on requests
 * the other side does not understand. The leading number is bumped by hand when a message changes
 * meaning; the method lists are part of it, so adding or renaming a method changes it on its own.
 */
export const RELAY_PROTOCOL = `1-${fingerprint(`${ENV_METHODS.join(",")};${HANDLE_METHODS.join(",")}`)}`;

/** A failure as it crosses the wire. */
export type WireError = {
  readonly kind: "file" | "exec";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly spillPath?: string;
};

export type WireResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: WireError };

/** What the client sends. `cwd` is the client's `cwd` at the call, which relative paths start from. */
export type Request =
  | {
      readonly t: "call";
      readonly id: number;
      readonly cwd: string;
      readonly method: EnvMethod;
      readonly args: ReadonlyArray<unknown>;
    }
  | {
      readonly t: "handle";
      readonly id: number;
      readonly handle: number;
      readonly method: HandleMethod;
      readonly args: ReadonlyArray<unknown>;
    }
  | { readonly t: "cancel"; readonly id: number };

/**
 * What the server sends. `ready` is its first line, so a client can tell it started and which wire
 * it speaks (`RELAY_PROTOCOL`).
 */
export type Reply =
  | { readonly t: "ready"; readonly pid: number; readonly protocol: string }
  | { readonly t: "done"; readonly id: number; readonly result: WireResult }
  | {
      readonly t: "output";
      readonly id: number;
      readonly text: string;
      readonly stream: "stdout" | "stderr";
      readonly skipped?: unknown;
    }
  | { readonly t: "change"; readonly handle: number; readonly change: unknown };

/** A handle the server opened, as a method's value: its number, and a watcher's mode. */
export type WireHandle = {
  readonly $handle: number;
  readonly mode?: "native" | "polling";
};

export const isWireHandle = (value: unknown): value is WireHandle =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { $handle?: unknown }).$handle === "number";

/**
 * Read from the holder, not from `value`: a `Buffer` (what Node's file reads return) has a `toJSON`
 * that has already turned it into `{type, data}` by the time a replacer sees `value`.
 */
function replacer(this: unknown, key: string, value: unknown): unknown {
  const original = (this as Record<string, unknown>)[key];
  return original instanceof Uint8Array
    ? { $bytes: Buffer.from(original).toString("base64") }
    : value;
}

const reviver = (_key: string, value: unknown): unknown =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { $bytes?: unknown }).$bytes === "string" &&
  Object.keys(value).length === 1
    ? new Uint8Array(
        Buffer.from((value as { $bytes: string }).$bytes, "base64"),
      )
    : value;

/** One message as its line, without the newline. */
export const encode = (message: Request | Reply): string =>
  JSON.stringify(message, replacer);

/** One line as a message, or `undefined` for a line that is not one (a stray print). */
export const decode = (line: string): unknown => {
  try {
    return JSON.parse(line, reviver);
  } catch {
    return undefined;
  }
};

export const errorToWire = (error: unknown): WireError => {
  if (error instanceof FileError) {
    return {
      kind: "file",
      code: error.code,
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
    };
  }
  if (error instanceof ExecutionError) {
    return {
      kind: "exec",
      code: error.code,
      message: error.message,
      ...(error.spillPath === undefined ? {} : { spillPath: error.spillPath }),
    };
  }
  return {
    kind: "file",
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
};

const FILE_CODES: ReadonlyArray<FileError["code"]> = [
  "aborted",
  "not_found",
  "permission_denied",
  "not_directory",
  "is_directory",
  "invalid",
  "not_supported",
  "unknown",
];
const EXEC_CODES: ReadonlyArray<ExecutionError["code"]> = [
  "aborted",
  "timeout",
  "shell_unavailable",
  "spawn_error",
  "callback_error",
  "unknown",
];

export const errorFromWire = (error: WireError): FileError | ExecutionError => {
  if (error.kind === "exec") {
    const code = EXEC_CODES.find((known) => known === error.code) ?? "unknown";
    const rebuilt = new ExecutionError(code, error.message);
    if (error.spillPath !== undefined) rebuilt.spillPath = error.spillPath;
    return rebuilt;
  }
  const code = FILE_CODES.find((known) => known === error.code) ?? "unknown";
  return new FileError(code, error.message, error.path);
};
