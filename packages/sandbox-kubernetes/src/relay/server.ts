/**
 * The relay's server half (LOB-91): Pi Durable's `NodeExecutionEnv`, inside the sandbox, answering
 * the requests `./client` sends. It runs where the files are — in the pod, started by `./main` over
 * `kubectl exec -i` — so every path it touches and every command it starts is the sandbox's.
 *
 * It adds nothing to the environment it serves. One `NodeExecutionEnv` per working directory a
 * client named, so concurrent calls with different `cwd`s never share one; a cancelled request
 * aborts the context its call runs under, which is how a command is killed; a handle is kept until
 * its `close`, or until the stream ends, when everything still open is closed and every command
 * still running is killed (`end`).
 */
import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  type ExecutionEnv,
  type FileWatcher,
  type Result,
  type ShellExecOptions,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  decode,
  encode,
  ENV_METHODS,
  errorToWire,
  HANDLE_METHODS,
  type Reply,
  type WireResult,
} from "./protocol";

export type RelayServerOptions = {
  /** Where a request's line goes back to the client, without its newline. */
  readonly send: (line: string) => void;
  /** The environment commands start with; the process's own when absent. */
  readonly shellEnv?: NodeJS.ProcessEnv;
};

export type RelayServer = {
  /** Handle one line the client sent. Lines that are not requests are ignored. */
  readonly receive: (line: string) => void;
  /** The client is gone: close every handle and kill every command still running. */
  readonly end: () => Promise<void>;
};

type Closable = { close(context: Context): Promise<void> };
type Held = Closable & Record<string, unknown>;

const fileResult = (result: Result<unknown, unknown>): WireResult =>
  result.ok
    ? { ok: true, value: result.value }
    : { ok: false, error: errorToWire(result.error) };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const serveExecutionEnv = (options: RelayServerOptions): RelayServer => {
  const envs = new Map<string, ExecutionEnv>();
  const handles = new Map<number, Held>();
  const running = new Map<number, AbortController>();
  let nextHandle = 1;

  const send = (reply: Reply): void => options.send(encode(reply));

  const envAt = (cwd: string): ExecutionEnv => {
    const held = envs.get(cwd);
    if (held !== undefined) return held;
    const env = new NodeExecutionEnv({
      cwd,
      ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
    });
    envs.set(cwd, env);
    return env;
  };

  /** Keep `handle` and answer with its number; a watcher also says its mode. */
  const hold = (
    handle: Held,
    mode?: FileWatcher["mode"],
    number = nextHandle++,
  ): WireResult => {
    handles.set(number, handle);
    return {
      ok: true,
      value: { $handle: number, ...(mode === undefined ? {} : { mode }) },
    };
  };

  const call = (
    id: number,
    env: ExecutionEnv,
    method: string,
    args: ReadonlyArray<unknown>,
    context: Context,
  ): Promise<WireResult> => {
    switch (method) {
      case "exec": {
        const [command, wanted] = args;
        const given = isRecord(wanted) ? wanted : {};
        const { output, ...rest } = given;
        const execOptions: ShellExecOptions = {
          ...(rest as ShellExecOptions),
          ...(output === true
            ? {
                onOutput: (text, _context, info) =>
                  send({
                    t: "output",
                    id,
                    text,
                    stream: info.stream,
                    ...(info.skipped === undefined
                      ? {}
                      : { skipped: info.skipped }),
                  }),
              }
            : {}),
        };
        return env
          .exec(command as string | string[], execOptions, context)
          .then(fileResult);
      }
      case "cleanup":
        return Promise.all([...envs.values()].map((each) => each.cleanup(context))).then(
          () => ({ ok: true, value: null }),
        );
      case "watch": {
        const targets = args[0] as ReadonlyArray<WatchTarget>;
        // Numbered before the watch exists: a change may be reported before the call resolves.
        const number = nextHandle++;
        return env
          .watch(
            targets,
            (change: WatchChange) =>
              send({
                t: "change",
                handle: number,
                change:
                  "error" in change
                    ? { error: errorToWire(change.error) }
                    : change,
              }),
            context,
          )
          .then((result) => {
            if (!result.ok) return fileResult(result);
            return hold(result.value as unknown as Held, result.value.mode, number);
          });
      }
      case "openTextLineReader":
      case "openBinaryReader":
      case "openDirReader": {
        const operation = env[method] as (
          ...given: unknown[]
        ) => Promise<Result<Held, unknown>>;
        return operation
          .call(env, ...args, context)
          .then((result) => (result.ok ? hold(result.value) : fileResult(result)));
      }
      default: {
        const operation = (env as unknown as Record<string, unknown>)[method];
        if (typeof operation !== "function") {
          return Promise.resolve({
            ok: false,
            error: { kind: "file", code: "invalid", message: `no method ${method}` },
          });
        }
        return (
          operation as (...given: unknown[]) => Promise<Result<unknown, unknown>>
        )
          .call(env, ...args, context)
          .then(fileResult);
      }
    }
  };

  const handleCall = (
    handle: number,
    method: string,
    args: ReadonlyArray<unknown>,
    context: Context,
  ): Promise<WireResult> => {
    const held = handles.get(handle);
    if (method === "close") {
      if (held === undefined) return Promise.resolve({ ok: true, value: null });
      handles.delete(handle);
      return held.close(context).then(() => ({ ok: true, value: null }));
    }
    const operation = held?.[method];
    if (held === undefined || typeof operation !== "function") {
      return Promise.resolve({
        ok: false,
        error: { kind: "file", code: "invalid", message: "the handle is closed" },
      });
    }
    return (operation as (...given: unknown[]) => Promise<Result<unknown, unknown>>)
      .call(held, ...args, context)
      .then(fileResult);
  };

  const answer = (id: number, work: (context: Context) => Promise<WireResult>) => {
    const controller = new AbortController();
    running.set(id, controller);
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    work(context)
      .catch((error: unknown): WireResult => ({ ok: false, error: errorToWire(error) }))
      .then((result) => {
        running.delete(id);
        send({ t: "done", id, result });
      });
  };

  const receive = (line: string): void => {
    const message = decode(line);
    if (!isRecord(message) || typeof message["id"] !== "number") return;
    const id = message["id"];
    const args = Array.isArray(message["args"]) ? message["args"] : [];
    switch (message["t"]) {
      case "cancel":
        running.get(id)?.abort();
        return;
      case "call": {
        const method = message["method"];
        const cwd = message["cwd"];
        if (
          typeof cwd !== "string" ||
          !ENV_METHODS.some((known) => known === method)
        ) {
          return;
        }
        answer(id, (context) => call(id, envAt(cwd), String(method), args, context));
        return;
      }
      case "handle": {
        const handle = message["handle"];
        const method = message["method"];
        if (
          typeof handle !== "number" ||
          !HANDLE_METHODS.some((known) => known === method)
        ) {
          return;
        }
        answer(id, (context) => handleCall(handle, String(method), args, context));
        return;
      }
    }
  };

  const end = (): Promise<void> => {
    for (const controller of running.values()) controller.abort();
    const open = [...handles.values()];
    handles.clear();
    return Promise.all(open.map((handle) => handle.close(BACKGROUND_CONTEXT)))
      .then(() =>
        Promise.all(
          [...envs.values()].map((env) => env.cleanup(BACKGROUND_CONTEXT)),
        ),
      )
      .then(() => undefined);
  };

  send({ t: "ready", pid: process.pid });
  return { receive, end };
};
